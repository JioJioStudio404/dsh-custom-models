/**
 * What the plugin reads from relay systems beside the balance (new-api, sub2api, CRS): one file,
 * `$DSH_HOME/storages/custom-models-relay.json` (mode 0600) — numbers and names only, no key, no conversation.
 *
 * - per key: the site's own record of what the key was billed (new-api's log, read incrementally by log id; sub2api's
 *   and CRS's statistics, replaced on each read), the key's group, its subscription as the log states it;
 * - per site: which optional endpoints it has (an endpoint that answered 404 is asked again a day later), the site's
 *   own performance figures, its model plaza prices;
 * - per site and model: what the site's log says of the model it served (mapped to another upstream model, another
 *   model returned, the system prompt overwritten) — evidence for model verification.
 *
 * Changes gather in memory and reach the file every few seconds (one process writes it: the plugin's host).
 *
 * @module dsh-custom-models/relay/store
 */
import * as defaultFs from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, safeJson } from "../errors.js";
import { dayOf, replaceFile } from "../keys.js";
import { storagePath } from "../paths.js";

const VERSION = 1;
const FLUSH_MS = 2_000;
/** Billed days kept per key (the page shows 30). */
export const BILLED_DAYS = 35;
/** An optional endpoint that was missing is asked again after this long. */
export const CAPABILITY_RETRY_MS = 24 * 3_600_000;
export const relayPath = (env) => storagePath("custom-models-relay.json", env);

const emptyState = () => ({ version: VERSION, sites: {}, keys: {}, facts: {} });

/** Whatever is on disk, as a valid state (anything malformed is dropped, not the file). */
export function coerceRelay(raw) {
  const out = emptyState();
  if (!isRecord(raw)) return out;
  for (const [id, value] of Object.entries(isRecord(raw.sites) ? raw.sites : {})) if (isRecord(value) && id.length <= 40) out.sites[id] = value;
  for (const [id, value] of Object.entries(isRecord(raw.keys) ? raw.keys : {})) if (isRecord(value) && id.length <= 80) out.keys[id] = value;
  for (const [id, value] of Object.entries(isRecord(raw.facts) ? raw.facts : {})) if (isRecord(value) && id.length <= 260) out.facts[id] = value;
  return out;
}

/** The days of a billed record older than the window go. */
export function pruneBilled(days, now) {
  const oldest = dayOf(now - (BILLED_DAYS - 1) * 86_400_000);
  for (const day of Object.keys(days ?? {})) if (day < oldest) delete days[day];
  return days;
}

export const factKey = (siteId, modelId) => `${siteId}\u0000${modelId}`;

export class RelayStore {
  #file;
  #fs;
  #now;
  #flushMs;
  #state;
  #loading;
  #timer;
  #chain = Promise.resolve();

  /** @param {object} [options] - `file`, `fs`, `now()`, `flushMs`. */
  constructor({ file = relayPath(), fs = defaultFs, now = () => Date.now(), flushMs = FLUSH_MS } = {}) {
    this.#file = file;
    this.#fs = fs;
    this.#now = now;
    this.#flushMs = flushMs;
  }

  path() {
    return this.#file;
  }

  /** The state (read from the file once). */
  async read() {
    if (this.#state) return this.#state;
    this.#loading ??= this.#fs.readFile(this.#file, "utf8").then((text) => coerceRelay(safeJson(text)), () => emptyState());
    this.#state = await this.#loading;
    return this.#state;
  }

  /** Change the state; the file follows in a few seconds. */
  async update(fn) {
    const state = await this.read();
    const result = fn(state);
    this.#schedule();
    return result;
  }

  /** Whether an optional endpoint of a site may be asked now (not known missing within the retry window). */
  async allowed(siteId, capability) {
    const state = await this.read();
    const known = state.sites[siteId]?.caps?.[capability];
    return !(isRecord(known) && known.ok === false && this.#now() - (known.at ?? 0) < CAPABILITY_RETRY_MS);
  }

  /** Note whether a site has an optional endpoint. */
  async capability(siteId, capability, ok) {
    return this.update((state) => {
      const site = (state.sites[siteId] ??= {});
      (site.caps ??= {})[capability] = { ok: ok === true, at: this.#now() };
    });
  }

  /** Forget a site (it was removed): its own data, its keys' and its models' facts. */
  async removeSite(siteId) {
    return this.update((state) => {
      delete state.sites[siteId];
      for (const [id, value] of Object.entries(state.keys)) if (value.site === siteId) delete state.keys[id];
      for (const id of Object.keys(state.facts)) if (id.startsWith(`${siteId}\u0000`)) delete state.facts[id];
    });
  }

  /** Forget a key (it was removed). */
  async removeKey(keyId) {
    return this.update((state) => {
      delete state.keys[keyId];
    });
  }

  /** Forget the site-log facts of one model, a site's, or all (model verification's records were cleared). */
  async clearFacts({ siteId, modelId } = {}) {
    return this.update((state) => {
      for (const id of Object.keys(state.facts)) {
        const [site, model] = id.split("\u0000");
        if (!siteId || (site === siteId && (!modelId || model === modelId))) delete state.facts[id];
      }
    });
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush().catch(() => undefined);
    }, this.#flushMs);
    this.#timer.unref?.();
  }

  /** Write the state (atomically). */
  async flush() {
    const run = this.#chain.then(async () => {
      if (!this.#state) return;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      for (const value of Object.values(this.#state.keys)) if (isRecord(value.billed?.days)) pruneBilled(value.billed.days, this.#now());
      await this.#fs.mkdir(dirname(this.#file), { recursive: true });
      const temp = `${this.#file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.new`;
      await this.#fs.writeFile(temp, `${JSON.stringify(this.#state)}\n`, { encoding: "utf8", mode: 0o600 });
      await replaceFile(this.#fs, temp, this.#file);
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
