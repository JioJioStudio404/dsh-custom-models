/**
 * The settings store: the user's sites, the models added to each, and the
 * switch groups. One file, `$DSH_HOME/storages/custom-models-settings.json`
 * (mode 0600; it holds no keys — those are in the key store). Writes are
 * serialized within the process and land atomically; a file another process
 * changed is re-read on its next use. Every read and write refreshes the
 * site registry (endpoints.js).
 *
 * A model is what the site's list said about it, filled in from the
 * reference where the site was silent, and edited by the user where both
 * were wrong: `{ id, name, protocol?, context?, contextFrom?, output?, image?,
 * reasoning?, cost?, flags?, source }` — `contextFrom` says whose word the
 * context is (`site`, `reference`, `user`; models.js caps a reference figure).
 * A site may carry its own limits: `defaultContext`, `imageBudget` (the
 * request's images, base64 bytes), `imageMaxBytes` (one image), the image
 * budget a 413 taught (`imageBudgetLearned`), and whether its streams report
 * usage (`usageReported`). A switch group is one picker entry served by one
 * of its members (a model on a site), the one the user chose — never
 * switched automatically.
 *
 * @module dsh-custom-models/store
 */
import * as defaultFs from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeBaseUrl, PLATFORMS, PROTOCOL_IDS, setSites, SITE_ID_PATTERN } from "./endpoints.js";
import { asNumber, asString, isRecord, safeJson } from "./errors.js";
import { replaceFile } from "./keys.js";
import { settingsPath } from "./paths.js";

const VERSION = 1;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** How a model takes a reasoning effort over Chat Completions (pi-ai's `thinkingFormat`, see gateway.js). */
export const THINKING_FORMATS = Object.freeze(["effort", "openrouter", "deepseek", "qwen", "none"]);
export const MAX_MODELS_PER_SITE = 300;
export const MAX_GROUPS = 100;

const empty = () => ({ version: VERSION, sites: [], groups: [] });
const positive = (value) => {
  const number = asNumber(value);
  return number !== undefined && number > 0 ? Math.round(number) : undefined;
};
const price = (value) => {
  const number = asNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
};
/** A whole number within bounds, or undefined (null clears a stored limit). */
const within = (value, min, max) => {
  const number = positive(value);
  return number !== undefined && number >= min && number <= max ? number : undefined;
};
/** Where a model's context came from. */
export const CONTEXT_ORIGINS = Object.freeze(["site", "reference", "user"]);

/** A stored model, checked field by field (anything malformed is dropped, not the model). */
export function coerceModel(raw) {
  if (!isRecord(raw) || !asString(raw.id) || raw.id.length > 200) return null;
  const out = { id: raw.id.trim() };
  if (!out.id) return null;
  if (asString(raw.name)) out.name = raw.name.slice(0, 120);
  if (PROTOCOL_IDS.includes(raw.protocol)) out.protocol = raw.protocol;
  if (positive(raw.context)) out.context = positive(raw.context);
  if (out.context && CONTEXT_ORIGINS.includes(raw.contextFrom)) out.contextFrom = raw.contextFrom;
  if (positive(raw.output)) out.output = positive(raw.output);
  if (raw.image === true) out.image = true;
  // false: the model takes no reasoning field (the site said so, or the user did).
  if (raw.reasoning === false) out.reasoning = false;
  else if (isRecord(raw.reasoning)) {
    const levels = Array.isArray(raw.reasoning.levels) ? EFFORTS.filter((level) => raw.reasoning.levels.includes(level)) : [];
    const map = isRecord(raw.reasoning.map) ? Object.fromEntries(Object.entries(raw.reasoning.map).filter(([level, value]) => (level === "off" || EFFORTS.includes(level)) && typeof value === "string" && value.length <= 40)) : null;
    if (levels.length || raw.reasoning.off === true) out.reasoning = { levels: levels.length ? levels : ["high"], off: raw.reasoning.off === true, ...(map && Object.keys(map).length ? { map } : {}) };
  }
  if (isRecord(raw.cost) && price(raw.cost.input) !== undefined && price(raw.cost.output) !== undefined) {
    out.cost = { input: price(raw.cost.input), output: price(raw.cost.output), cacheRead: price(raw.cost.cacheRead) ?? 0, cacheWrite: price(raw.cost.cacheWrite) ?? 0, ...(asString(raw.cost.unit) ? { unit: raw.cost.unit.slice(0, 20) } : {}) };
  }
  if (isRecord(raw.flags)) {
    const flags = {};
    if (THINKING_FORMATS.includes(raw.flags.thinkingFormat)) flags.thinkingFormat = raw.flags.thinkingFormat;
    if (raw.flags.reasoningOnAssistant === true) flags.reasoningOnAssistant = true;
    if (raw.flags.noTemperature === true) flags.noTemperature = true;
    if (raw.flags.adaptive === true) flags.adaptive = true;
    if (raw.flags.maxTokensField === "max_completion_tokens") flags.maxTokensField = "max_completion_tokens";
    if (Object.keys(flags).length) out.flags = flags;
  }
  out.source = ["site", "reference", "manual"].includes(raw.source) ? raw.source : "manual";
  return out;
}

/** Request headers a site sends with every request: plain names and values, never the key's own headers. */
export function coerceHeaders(raw) {
  if (!isRecord(raw)) return {};
  const out = {};
  for (const [name, value] of Object.entries(raw).slice(0, 20)) {
    const lower = name.toLowerCase();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || ["authorization", "x-api-key", "x-goog-api-key", "content-type", "host", "content-length"].includes(lower)) continue;
    if (typeof value !== "string" || value.length > 512 || /[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

function coerceSite(raw) {
  if (!isRecord(raw) || !asString(raw.id) || !SITE_ID_PATTERN.test(raw.id) || !asString(raw.baseUrl)) return null;
  const seen = new Set();
  const models = (Array.isArray(raw.models) ? raw.models : []).map(coerceModel).filter((model) => model && !seen.has(model.id) && seen.add(model.id)).slice(0, MAX_MODELS_PER_SITE);
  return {
    id: raw.id,
    name: asString(raw.name) ? raw.name.slice(0, 60) : raw.id,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    protocol: PROTOCOL_IDS.includes(raw.protocol) ? raw.protocol : "chat",
    headers: coerceHeaders(raw.headers),
    platform: PLATFORMS.includes(raw.platform) ? raw.platform : "generic",
    ...(isRecord(raw.platformInfo) ? { platformInfo: raw.platformInfo } : {}),
    modelsPublic: raw.modelsPublic === true,
    keyless: raw.keyless === true,
    // Switched off by hand: its models leave the model picker (its keys and models stay).
    enabled: raw.enabled !== false,
    // The user confirmed that this public plain-HTTP address may be used unencrypted.
    allowHttp: raw.allowHttp === true,
    // Limits the user set (DSH's own custom-route defaults apply where unset) and what a 413 taught.
    ...(within(raw.defaultContext, 4_096, 10_000_000) ? { defaultContext: within(raw.defaultContext, 4_096, 10_000_000) } : {}),
    ...(within(raw.imageBudget, 65_536, 1_073_741_824) ? { imageBudget: within(raw.imageBudget, 65_536, 1_073_741_824) } : {}),
    ...(within(raw.imageBudgetLearned, 65_536, 1_073_741_824) ? { imageBudgetLearned: within(raw.imageBudgetLearned, 65_536, 1_073_741_824) } : {}),
    ...(within(raw.imageMaxBytes, 16_384, 67_108_864) ? { imageMaxBytes: within(raw.imageMaxBytes, 16_384, 67_108_864) } : {}),
    // Whether the site's answers carry token usage (false: none seen in a finished answer).
    ...(typeof raw.usageReported === "boolean" ? { usageReported: raw.usageReported } : {}),
    models,
    addedAt: asString(raw.addedAt) ?? null,
    detectedAt: asString(raw.detectedAt) ?? null,
  };
}

function coerceGroup(raw, sites) {
  if (!isRecord(raw) || !asString(raw.id) || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(raw.id)) return null;
  const members = (Array.isArray(raw.members) ? raw.members : [])
    .filter((member) => isRecord(member) && asString(member.site) && asString(member.model) && sites.some((site) => site.id === member.site))
    .map((member) => ({ site: member.site, model: member.model.slice(0, 200) }))
    .filter((member, index, list) => list.findIndex((item) => item.site === member.site && item.model === member.model) === index)
    .slice(0, 20);
  if (members.length === 0) return null;
  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < members.length ? raw.active : 0;
  return { id: raw.id, name: asString(raw.name) ? raw.name.slice(0, 60) : raw.id, members, active };
}

/** Whatever is on disk, as a valid state. */
export function coerceState(raw) {
  if (!isRecord(raw)) return empty();
  const ids = new Set();
  const sites = (Array.isArray(raw.sites) ? raw.sites : []).map(coerceSite).filter((site) => site && !ids.has(site.id) && ids.add(site.id));
  const groupIds = new Set();
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).map((group) => coerceGroup(group, sites)).filter((group) => group && !groupIds.has(group.id) && groupIds.add(group.id)).slice(0, MAX_GROUPS);
  return { version: VERSION, sites, groups };
}

export class SettingsStore {
  #file;
  #fs;
  #chain = Promise.resolve();
  #cache;
  #cacheStamp;

  constructor({ file = settingsPath(), fs = defaultFs } = {}) {
    this.#file = file;
    this.#fs = fs;
  }

  path() {
    return this.#file;
  }

  /** Current state, re-read when another process changed the file. */
  async read() {
    let stamp;
    try {
      const info = await this.#fs.stat(this.#file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stamp = "absent";
    }
    if (this.#cache !== undefined && stamp === this.#cacheStamp) return this.#cache;
    const state = stamp === "absent" ? empty() : coerceState(safeJson(await this.#fs.readFile(this.#file, "utf8").catch(() => "")));
    this.#cache = state;
    this.#cacheStamp = stamp;
    setSites(state.sites);
    return state;
  }

  /** The state read synchronously at boot (routes must exist before the first request). */
  readSync(readFileSync) {
    try {
      const state = coerceState(safeJson(readFileSync(this.#file, "utf8")));
      // Also the cache a synchronous caller reads (cachedSite); the next read() checks the file again.
      this.#cache = state;
      setSites(state.sites);
      return state;
    } catch {
      setSites([]);
      return empty();
    }
  }

  /** Serialized read-modify-write: `fn` gets a copy and returns `{ state?, result }`. */
  mutate(fn) {
    const run = this.#chain.then(async () => {
      const current = structuredClone(await this.read());
      const outcome = await fn(current);
      if (outcome?.state !== undefined) {
        const next = coerceState(outcome.state);
        await this.#fs.mkdir(dirname(this.#file), { recursive: true });
        const temp = `${this.#file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.new`;
        await this.#fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await replaceFile(this.#fs, temp, this.#file);
        this.#cache = next;
        try {
          const info = await this.#fs.stat(this.#file);
          this.#cacheStamp = `${info.mtimeMs}:${info.size}`;
        } catch {
          this.#cacheStamp = undefined;
        }
        setSites(next.sites);
      }
      return outcome?.result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async sites() {
    return (await this.read()).sites;
  }

  async site(id) {
    return (await this.sites()).find((site) => site.id === id);
  }

  /** A site as last read, synchronously (DSH asks for an image's size target without waiting). */
  cachedSite(id) {
    return this.#cache?.sites.find((site) => site.id === id);
  }

  /** The switch groups as last read, synchronously. */
  cachedGroups() {
    return this.#cache?.groups ?? [];
  }

  async groups() {
    return (await this.read()).groups;
  }

  /** Add a site (its id must be new). */
  async addSite(site) {
    return this.mutate((state) => {
      if (state.sites.some((item) => item.id === site.id)) return { result: { ok: false, error: `站点 ID ${site.id} 已存在` } };
      return { state: { ...state, sites: [...state.sites, { ...site, addedAt: new Date().toISOString() }] }, result: { ok: true } };
    });
  }

  /** Change a site's fields (its id stays). */
  async updateSite(id, patch) {
    return this.mutate((state) => {
      const index = state.sites.findIndex((site) => site.id === id);
      if (index < 0) return { result: false };
      const sites = [...state.sites];
      sites[index] = { ...sites[index], ...patch, id };
      return { state: { ...state, sites }, result: true };
    });
  }

  /** Forget a site, and its members in the switch groups. */
  async removeSite(id) {
    return this.mutate((state) => {
      if (!state.sites.some((site) => site.id === id)) return { result: false };
      const groups = state.groups.map((group) => {
        const current = group.members[group.active];
        const members = group.members.filter((member) => member.site !== id);
        const active = Math.max(0, members.findIndex((member) => member === current));
        return { ...group, members, active };
      });
      return { state: { ...state, sites: state.sites.filter((site) => site.id !== id), groups }, result: true };
    });
  }

  /** Put the sites in this order (unknown ids ignored). */
  async reorderSites(ids) {
    return this.mutate((state) => {
      const listed = [...new Set(ids)].map((id) => state.sites.find((site) => site.id === id)).filter(Boolean);
      const sites = [...listed, ...state.sites.filter((site) => !listed.includes(site))];
      return sites.every((site, index) => site === state.sites[index]) ? { result: false } : { state: { ...state, sites }, result: true };
    });
  }

  /** Add models to a site (a model already there is replaced by the new description). */
  async addModels(siteId, models) {
    return this.mutate((state) => {
      const site = state.sites.find((item) => item.id === siteId);
      if (!site) return { result: false };
      const incoming = models.map(coerceModel).filter(Boolean);
      const kept = site.models.filter((model) => !incoming.some((item) => item.id === model.id));
      site.models = [...kept, ...incoming].slice(0, MAX_MODELS_PER_SITE);
      return { state, result: true };
    });
  }

  /** Remove models from a site (and from the switch groups). */
  async removeModels(siteId, ids) {
    return this.mutate((state) => {
      const site = state.sites.find((item) => item.id === siteId);
      if (!site) return { result: false };
      site.models = site.models.filter((model) => !ids.includes(model.id));
      for (const group of state.groups) {
        const current = group.members[group.active];
        group.members = group.members.filter((member) => !(member.site === siteId && ids.includes(member.model)));
        group.active = Math.max(0, group.members.indexOf(current));
      }
      return { state, result: true };
    });
  }

  /** Edit one model of a site (fields set to null are cleared). */
  async updateModel(siteId, modelId, patch) {
    return this.mutate((state) => {
      const site = state.sites.find((item) => item.id === siteId);
      const model = site?.models.find((item) => item.id === modelId);
      if (!model) return { result: false };
      const next = { ...model, ...patch, id: modelId, source: "manual" };
      for (const [name, value] of Object.entries(next)) if (value === null) delete next[name];
      site.models = site.models.map((item) => (item.id === modelId ? next : item));
      return { state, result: true };
    });
  }

  /** Add or replace a switch group. */
  async saveGroup(group) {
    return this.mutate((state) => {
      const exists = state.groups.some((item) => item.id === group.id);
      if (!exists && state.groups.length >= MAX_GROUPS) return { result: { ok: false, error: `最多 ${MAX_GROUPS} 个切换组` } };
      const groups = exists ? state.groups.map((item) => (item.id === group.id ? group : item)) : [...state.groups, group];
      return { state: { ...state, groups }, result: { ok: true } };
    });
  }

  async removeGroup(id) {
    return this.mutate((state) => (state.groups.some((group) => group.id === id) ? { state: { ...state, groups: state.groups.filter((group) => group.id !== id) }, result: true } : { result: false }));
  }

  /** Choose which member serves a switch group from now on. */
  async setGroupActive(id, index) {
    return this.mutate((state) => {
      const group = state.groups.find((item) => item.id === id);
      if (!group || !Number.isInteger(index) || index < 0 || index >= group.members.length) return { result: false };
      group.active = index;
      return { state, result: true };
    });
  }
}
