/**
 * Rule pack updates. The pack in use is the newest valid one: the plugin's
 * own (`pack.json`), or a downloaded one — `pack.json` and its Ed25519
 * signature `pack.json.sig` from the public data repository (GitHub, or the
 * jsDelivr mirror of it, or an address the user gives) — accepted only when
 * the signature checks out against the key built in here, its form is valid,
 * it fits this plugin version and it is newer. A downloaded pack is kept in
 * `$DSH_HOME/storages/custom-models-authn-pack.json` (+ `.sig`) and checked
 * again on every start. The request carries nothing of the user's: a plain
 * GET with the plugin's User-Agent.
 *
 * Until the data repository exists, `UPDATE_SOURCES` and `UPDATE_PUBLIC_KEY`
 * are empty and nothing is fetched (the page says updates are not set up).
 *
 * @module dsh-custom-models/authn/update
 */
import * as defaultFs from "node:fs/promises";
import { dirname } from "node:path";
import { replaceFile } from "../keys.js";
import { storagePath } from "../paths.js";
import { readCapped, USER_AGENT } from "../wire.js";
import { acceptPack, builtinPack, compareVersions, PLUGIN_VERSION } from "./rules.js";

/** The data repository's Ed25519 public key (PEM); set when the repository is created. */
export const UPDATE_PUBLIC_KEY = "";
/** Where `pack.json` and `pack.json.sig` are read: a base address per source (no trailing slash). */
export const UPDATE_SOURCES = Object.freeze({ github: "", jsdelivr: "" });
export const UPDATE_INTERVAL_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 600_000;
export const packPath = (env) => storagePath("custom-models-authn-pack.json", env);

/** The base addresses to try, in order, for the user's choice of source. */
export function sourcesFor(settings, sources = UPDATE_SOURCES) {
  const custom = typeof settings?.customUrl === "string" && /^https:\/\//i.test(settings.customUrl) ? settings.customUrl.replace(/\/+$/, "") : "";
  if (settings?.updateSource === "custom") return custom ? [custom] : [];
  const order = settings?.updateSource === "jsdelivr" ? [sources.jsdelivr, sources.github] : [sources.github, sources.jsdelivr];
  return order.filter(Boolean);
}

async function fetchText(url, { fetchImpl, signal }) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json, text/plain" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new Error("too large");
  // Read up to the cap only (a missing or wrong length header does not let a larger answer in).
  const read = await readCapped(response, MAX_BYTES);
  if (read.tooLarge) throw new Error("too large");
  return read.bytes.toString("utf8");
}

export class RuleUpdater {
  #store;
  #fs;
  #fetch;
  #file;
  #publicKey;
  #sources;
  #now;
  #log;
  #pack;
  #origin = "builtin";
  #checking = null;

  /** @param {object} options - `store` (AuthnStore), `fs`, `fetchImpl`, `file`, `publicKey`, `sources`, `now()`, `log`. */
  constructor({ store, fs = defaultFs, fetchImpl = fetch, file = packPath(), publicKey = UPDATE_PUBLIC_KEY, sources = UPDATE_SOURCES, now = () => Date.now(), log = () => {} }) {
    this.#store = store;
    this.#fs = fs;
    this.#fetch = fetchImpl;
    this.#file = file;
    this.#publicKey = publicKey;
    this.#sources = sources;
    this.#now = now;
    this.#log = log;
    this.#pack = builtinPack();
  }

  /** The pack in use. */
  current() {
    return this.#pack;
  }

  /** Whether updates are set up at all (a key and a source). */
  configured(settings) {
    return Boolean(this.#publicKey) && sourcesFor(settings, this.#sources).length > 0;
  }

  /** A downloaded pack kept from before, checked again; used when newer than the plugin's own. */
  async load() {
    try {
      const [text, signature] = await Promise.all([this.#fs.readFile(this.#file, "utf8"), this.#fs.readFile(`${this.#file}.sig`, "utf8")]);
      const state = (await this.#store.read()).rules;
      const result = acceptPack(text, signature, { publicKey: this.#publicKey, current: builtinPack().version });
      if (result.ok && result.pack.version !== state.rolledBack) {
        this.#pack = result.pack;
        this.#origin = "online";
      }
    } catch {
      /* none kept, or unreadable: the plugin's own */
    }
    return this.#pack;
  }

  /** What the page shows. */
  async status() {
    const state = (await this.#store.read());
    return {
      version: this.#pack.version,
      published: this.#pack.published,
      origin: this.#origin,
      builtin: builtinPack().version,
      configured: this.configured(state.settings),
      checkedAt: state.rules.checkedAt ?? null,
      error: state.rules.error ?? null,
      checking: this.#checking !== null,
    };
  }

  /**
   * Look for a newer pack (one run at a time). `force`: also when the last check was recent.
   * @returns `{ updated, version, error }`.
   */
  check({ force = false, signal } = {}) {
    this.#checking ??= this.#check({ force, signal }).finally(() => { this.#checking = null; });
    return this.#checking;
  }

  async #check({ force, signal }) {
    const state = await this.#store.read();
    if (!force && Number.isFinite(state.rules.checkedAt) && this.#now() - state.rules.checkedAt < UPDATE_INTERVAL_MS) return { updated: false, version: this.#pack.version, error: null };
    const sources = sourcesFor(state.settings, this.#sources);
    if (!this.#publicKey || sources.length === 0) return { updated: false, version: this.#pack.version, error: "not-configured" };
    let lastError = null;
    for (const base of sources) {
      try {
        const [text, sig] = await Promise.all([fetchText(`${base}/pack.json`, { fetchImpl: this.#fetch, signal }), fetchText(`${base}/pack.json.sig`, { fetchImpl: this.#fetch, signal })]);
        const result = acceptPack(text, sig, { publicKey: this.#publicKey, current: this.#pack.version, pluginVersion: PLUGIN_VERSION });
        if (!result.ok) {
          // An older or equal pack is no failure: nothing newer is out.
          if (result.reason === "not newer") {
            await this.#store.setRules({ checkedAt: this.#now(), error: null });
            return { updated: false, version: this.#pack.version, error: null };
          }
          lastError = result.reason;
          continue;
        }
        if (result.pack.version === state.rules.rolledBack) {
          await this.#store.setRules({ checkedAt: this.#now(), error: null });
          return { updated: false, version: this.#pack.version, error: null };
        }
        await this.#fs.mkdir(dirname(this.#file), { recursive: true });
        for (const [path, content] of [[`${this.#file}.sig`, sig], [this.#file, text]]) {
          const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.new`;
          await this.#fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
          await replaceFile(this.#fs, temp, path);
        }
        this.#pack = result.pack;
        this.#origin = "online";
        await this.#store.setRules({ checkedAt: this.#now(), error: null, version: result.pack.version });
        this.#log("info", `authn rule pack ${result.pack.version} from ${new URL(base).host}`);
        return { updated: true, version: result.pack.version, error: null };
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = String(error?.message ?? error).slice(0, 120);
      }
    }
    await this.#store.setRules({ checkedAt: this.#now(), error: lastError });
    this.#log("warn", `authn rule pack not updated: ${lastError}`);
    return { updated: false, version: this.#pack.version, error: lastError };
  }

  /** Back to the plugin's own pack; the downloaded version is not taken again (a newer one is). */
  async rollback() {
    const dropped = this.#origin === "online" ? this.#pack.version : null;
    this.#pack = builtinPack();
    this.#origin = "builtin";
    await this.#fs.rm(this.#file, { force: true }).catch(() => undefined);
    await this.#fs.rm(`${this.#file}.sig`, { force: true }).catch(() => undefined);
    if (dropped) await this.#store.setRules({ rolledBack: dropped });
    return this.#pack;
  }
}

export { compareVersions };
