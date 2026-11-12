/**
 * What model authenticity checks keep: one file,
 * `$DSH_HOME/storages/custom-models-authn.json` (mode 0600) — the settings,
 * which conversations are tracked, and per site and model the last
 * observations (observe.js: no prompt, no answer) and active check results.
 * Changes gather in memory and reach the file every few seconds, merged into
 * what is there (as the usage ledger does).
 *
 * @module dsh-custom-models/authn/store
 */
import { randomBytes } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../errors.js";
import { replaceFile } from "../keys.js";
import { storagePath } from "../paths.js";
import { hasOwn, isSafeKey, readJsonFile, withFileLock } from "../safe.js";

const VERSION = 1;
const FLUSH_MS = 4_000;
const DAY_MS = 86_400_000;
const SESSION_LIMIT = 3_000;
const PROBE_LIMIT = 20;
export const authnPath = (env) => storagePath("custom-models-authn.json", env);

/** The intervals the automatic identity check may keep (minutes). */
export const AUTO_IDENTITY_MINUTES = Object.freeze([30, 60, 120, 360, 720, 1440]);
/** How many automatic identity checks may run in 24 hours, all models together (the choices offered). */
export const AUTO_IDENTITY_DAILY = Object.freeze([3, 6, 12, 24, 48]);

export const DEFAULT_SETTINGS = Object.freeze({
  // Passive monitoring: tracked conversations' answers are observed (no request of its own).
  passive: false,
  // Active testing: protocol tests and signature verification may be run (by hand).
  active: false,
  // The entry in each conversation's status bar.
  dock: true,
  // New conversations are scanned (each conversation can be switched by hand).
  passiveDefault: true,
  keepDays: 30,
  // Active checks ask first (the number of requests and their cost).
  confirmProbes: true,
  // A signature from one site may be sent to another site's check (only signatures the checks made).
  crossSite: true,
  // When passive monitoring doubts a model's identity, an identity check runs by itself (while active testing is on),
  // for one model at most once per this many minutes.
  autoIdentity: true,
  autoIdentityMinutes: 60,
  // At most this many automatic identity checks in 24 hours, all models together (a budget beside the interval).
  autoIdentityDaily: 12,
  // Knowledge-fingerprint sets the KBF authors published that the rule pack has not checked yet may be used.
  fingerprintUpstream: false,
  // Rule pack updates.
  autoUpdate: true,
  updateSource: "github",
  customUrl: "",
});

/**
 * Settings as given, kept within their forms. `enabled` is derived: either part on (with neither on, the status bar
 * shows nothing and no rule pack is fetched). A store from before the two switches had one `enabled`: both follow it.
 */
export function coerceSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (isRecord(raw)) {
    if (typeof raw.enabled === "boolean" && typeof raw.passive !== "boolean" && typeof raw.active !== "boolean") Object.assign(out, { passive: raw.enabled, active: raw.enabled });
    for (const field of ["passive", "active", "dock", "passiveDefault", "confirmProbes", "crossSite", "autoUpdate", "autoIdentity", "fingerprintUpstream"]) if (typeof raw[field] === "boolean") out[field] = raw[field];
  }
  out.enabled = out.passive || out.active;
  if (!isRecord(raw)) return out;
  if (Number.isInteger(raw.keepDays) && raw.keepDays >= 1 && raw.keepDays <= 365) out.keepDays = raw.keepDays;
  if (AUTO_IDENTITY_MINUTES.includes(raw.autoIdentityMinutes)) out.autoIdentityMinutes = raw.autoIdentityMinutes;
  if (AUTO_IDENTITY_DAILY.includes(raw.autoIdentityDaily)) out.autoIdentityDaily = raw.autoIdentityDaily;
  if (["github", "jsdelivr", "custom"].includes(raw.updateSource)) out.updateSource = raw.updateSource;
  if (typeof raw.customUrl === "string" && raw.customUrl.length <= 500 && (raw.customUrl === "" || /^https:\/\/[^\s]+$/i.test(raw.customUrl))) out.customUrl = raw.customUrl;
  out.enabled = out.passive || out.active;
  return out;
}

const key = (siteId, modelId) => `${siteId}\u0000${modelId}`;

/** Whatever is on disk, as a valid store. */
export function coerceStore(raw) {
  const out = { version: VERSION, salt: typeof raw?.salt === "string" && /^[0-9a-f]{32}$/.test(raw.salt) ? raw.salt : randomBytes(16).toString("hex"), settings: coerceSettings(raw?.settings), sessions: {}, models: {}, rules: isRecord(raw?.rules) ? { ...raw.rules } : {}, jobs: {} };
  for (const [id, entry] of Object.entries(isRecord(raw?.sessions) ? raw.sessions : {})) {
    if (id.length > 120 || !isSafeKey(id) || !isRecord(entry) || typeof entry.on !== "boolean") continue;
    out.sessions[id] = { on: entry.on, at: Number(entry.at) || 0 };
  }
  for (const [name, entry] of Object.entries(isRecord(raw?.models) ? raw.models : {})) {
    if (!name.includes("\u0000") || name.length > 260 || !isRecord(entry)) continue;
    out.models[name] = {
      obs: (Array.isArray(entry.obs) ? entry.obs : []).filter((item) => isRecord(item) && Number.isFinite(item.t)),
      probes: (Array.isArray(entry.probes) ? entry.probes : []).filter((item) => isRecord(item) && typeof item.kind === "string" && Number.isFinite(item.at)).slice(-PROBE_LIMIT),
    };
  }
  for (const [name, job] of Object.entries(isRecord(raw?.jobs) ? raw.jobs : {})) {
    if (name.includes("\u0000") && name.length <= 260 && validJob(job)) out.jobs[name] = job;
  }
  return out;
}

/** A background job as kept: a knowledge fingerprint part done. */
function validJob(job) {
  return isRecord(job) && job.kind === "fingerprint" && typeof job.set === "string" && job.set.length <= 60
    && Array.isArray(job.values) && job.values.length <= 5000 && job.values.every((value) => value === null || Number.isFinite(value))
    && Number.isInteger(job.next) && job.next >= 0 && isRecord(job.usage);
}

export class AuthnStore {
  #file;
  #fs;
  #now;
  #flushMs;
  #keep;
  #pending = { obs: new Map(), probes: new Map(), sessions: new Map(), settings: null, clear: [], rules: null, jobs: new Map() };
  #timer;
  #chain = Promise.resolve();
  #cache;
  #stamp;

  /** @param {object} [options] - `file`, `fs`, `now()`, `flushMs`, `keepObservations` (per model). */
  constructor({ file = authnPath(), fs = defaultFs, now = () => Date.now(), flushMs = FLUSH_MS, keepObservations = 300 } = {}) {
    this.#file = file;
    this.#fs = fs;
    this.#now = now;
    this.#flushMs = flushMs;
    this.#keep = keepObservations;
  }

  path() {
    return this.#file;
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush().catch(() => undefined);
    }, this.#flushMs);
    this.#timer.unref?.();
  }

  /** The file as it is now (`fresh`: re-read regardless, under the lock). A file that cannot be read throws; a corrupt one is set aside (safe.js). */
  async #disk({ fresh = false } = {}) {
    let stamp;
    try {
      const info = await this.#fs.stat(this.#file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stamp = "absent";
    }
    if (fresh || this.#cache === undefined || stamp !== this.#stamp) {
      this.#cache = coerceStore(stamp === "absent" ? null : await readJsonFile(this.#fs, this.#file));
      this.#stamp = stamp;
    }
    return this.#cache;
  }

  /** The store as on disk with what is not written yet. */
  #merged(disk, pending) {
    const out = { ...disk, settings: { ...disk.settings }, sessions: { ...disk.sessions }, models: { ...disk.models }, rules: { ...disk.rules }, jobs: { ...(disk.jobs ?? {}) } };
    for (const scope of pending.clear) {
      for (const name of [...Object.keys(out.models), ...Object.keys(out.jobs)]) {
        const [site, model] = name.split("\u0000");
        if (scope.all || (site === scope.site && (scope.model === undefined || model === scope.model))) {
          delete out.models[name];
          delete out.jobs[name];
        }
      }
    }
    for (const [name, job] of pending.jobs) {
      if (job) out.jobs[name] = job;
      else delete out.jobs[name];
    }
    if (pending.settings) out.settings = coerceSettings({ ...out.settings, ...pending.settings });
    if (pending.rules) out.rules = { ...out.rules, ...pending.rules };
    for (const [id, entry] of pending.sessions) out.sessions[id] = entry;
    const sessionIds = Object.keys(out.sessions);
    if (sessionIds.length > SESSION_LIMIT) {
      for (const id of sessionIds.sort((a, b) => out.sessions[a].at - out.sessions[b].at).slice(0, sessionIds.length - SESSION_LIMIT)) delete out.sessions[id];
    }
    const oldest = this.#now() - out.settings.keepDays * DAY_MS;
    const names = new Set([...Object.keys(out.models), ...pending.obs.keys(), ...pending.probes.keys()]);
    for (const name of names) {
      const entry = out.models[name] ?? { obs: [], probes: [] };
      const obs = [...entry.obs, ...(pending.obs.get(name) ?? [])].filter((item) => item.t >= oldest).slice(-this.#keep);
      const probes = [...entry.probes, ...(pending.probes.get(name) ?? [])].filter((item) => item.at >= oldest).slice(-PROBE_LIMIT);
      if (obs.length || probes.length) out.models[name] = { obs, probes };
      else delete out.models[name];
    }
    return out;
  }

  /** Everything, with the changes not written yet. */
  async read() {
    const run = this.#chain.then(async () => this.#merged(await this.#disk(), this.#pending));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async settings() {
    return (await this.read()).settings;
  }

  async saveSettings(patch) {
    this.#pending.settings = { ...(this.#pending.settings ?? {}), ...patch };
    await this.flush();
    return this.settings();
  }

  /** Whether a conversation is scanned: its own switch, else the default for new conversations. */
  async tracked(sessionId) {
    const state = await this.read();
    const own = sessionId && hasOwn(state.sessions, String(sessionId)) ? state.sessions[String(sessionId)] : undefined;
    return own ? own.on : state.settings.passiveDefault;
  }

  /** Whether a conversation was switched by hand (else it follows the default). */
  async sessionSwitch(sessionId) {
    const sessions = (await this.read()).sessions;
    const own = sessionId && hasOwn(sessions, String(sessionId)) ? sessions[String(sessionId)] : undefined;
    return own ? own.on : null;
  }

  async setTracked(sessionId, on) {
    if (!sessionId || !isSafeKey(String(sessionId).slice(0, 120))) return;
    this.#pending.sessions.set(String(sessionId).slice(0, 120), { on: on === true, at: this.#now() });
    await this.flush();
  }

  /** Keep one observation of a site's model. */
  add(siteId, modelId, observation) {
    if (!siteId || !modelId || !observation) return;
    const name = key(siteId, String(modelId).slice(0, 200));
    (this.#pending.obs.get(name) ?? this.#pending.obs.set(name, []).get(name)).push(observation);
    this.#schedule();
  }

  /** Keep one active check's result. */
  async addProbe(siteId, modelId, result) {
    const name = key(siteId, String(modelId).slice(0, 200));
    (this.#pending.probes.get(name) ?? this.#pending.probes.set(name, []).get(name)).push(result);
    await this.flush();
  }

  /** One site's model: its observations and check results (oldest first). */
  async model(siteId, modelId) {
    return (await this.read()).models[key(siteId, modelId)] ?? { obs: [], probes: [] };
  }

  /** Forget observations and results: all, one site's, or one model's. */
  async clear(scope = { all: true }) {
    const match = (name) => {
      if (scope.all) return true;
      const [site, model] = name.split("\u0000");
      return site === scope.site && (scope.model === undefined || model === scope.model);
    };
    for (const name of [...this.#pending.obs.keys()]) if (match(name)) this.#pending.obs.delete(name);
    for (const name of [...this.#pending.probes.keys()]) if (match(name)) this.#pending.probes.delete(name);
    for (const name of [...this.#pending.jobs.keys()]) if (match(name)) this.#pending.jobs.delete(name);
    this.#pending.clear.push(scope.all ? { all: true } : { site: scope.site, ...(scope.model !== undefined ? { model: scope.model } : {}) });
    await this.flush();
  }

  /** A background job's progress (a knowledge fingerprint), kept so a restart resumes it; null ends it. */
  async setJob(siteId, modelId, job) {
    this.#pending.jobs.set(key(siteId, String(modelId).slice(0, 200)), job ?? null);
    await this.flush();
  }

  /** The background jobs kept: site\0model → job. */
  async jobs() {
    return (await this.read()).jobs;
  }

  /** The rule pack's update state (`{ version, source, checkedAt, error, etag }`). */
  async setRules(patch) {
    this.#pending.rules = { ...(this.#pending.rules ?? {}), ...patch };
    await this.flush();
  }

  /** Write what gathered (merged into the file as it is now, atomically). */
  async flush() {
    const run = this.#chain.then(async () => {
      const pending = this.#pending;
      if (pending.obs.size === 0 && pending.probes.size === 0 && pending.sessions.size === 0 && !pending.settings && pending.clear.length === 0 && !pending.rules && pending.jobs.size === 0) return;
      this.#pending = { obs: new Map(), probes: new Map(), sessions: new Map(), settings: null, clear: [], rules: null, jobs: new Map() };
      try {
        // Under the lock and read afresh: another process on the same home (the terminal) is not written over.
        await withFileLock(this.#fs, this.#file, async () => {
          const next = this.#merged(await this.#disk({ fresh: true }), pending);
          await this.#fs.mkdir(dirname(this.#file), { recursive: true });
          const temp = `${this.#file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.new`;
          await this.#fs.writeFile(temp, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
          await replaceFile(this.#fs, temp, this.#file);
          this.#cache = next;
          try {
            const info = await this.#fs.stat(this.#file);
            this.#stamp = `${info.mtimeMs}:${info.size}`;
          } catch {
            this.#stamp = undefined;
          }
        });
      } catch (error) {
        // Nothing is lost: the changes wait for the next write.
        for (const [name, list] of pending.obs) (this.#pending.obs.get(name) ?? this.#pending.obs.set(name, []).get(name)).unshift(...list);
        for (const [name, list] of pending.probes) (this.#pending.probes.get(name) ?? this.#pending.probes.set(name, []).get(name)).unshift(...list);
        for (const [id, entry] of pending.sessions) if (!this.#pending.sessions.has(id)) this.#pending.sessions.set(id, entry);
        if (pending.settings) this.#pending.settings = { ...pending.settings, ...(this.#pending.settings ?? {}) };
        if (pending.rules) this.#pending.rules = { ...pending.rules, ...(this.#pending.rules ?? {}) };
        for (const [name, job] of pending.jobs) if (!this.#pending.jobs.has(name)) this.#pending.jobs.set(name, job);
        this.#pending.clear.unshift(...pending.clear);
        for (const scope of this.#pending.clear.slice(pending.clear.length)) {
          const match = (name) => {
            if (scope.all) return true;
            const [site, model] = name.split("\u0000");
            return site === scope.site && (scope.model === undefined || model === scope.model);
          };
          for (const name of [...this.#pending.obs.keys()]) if (match(name)) this.#pending.obs.delete(name);
          for (const name of [...this.#pending.probes.keys()]) if (match(name)) this.#pending.probes.delete(name);
        }
        this.#schedule();
        throw error;
      }
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
