/**
 * The plugin's own ledger of what the requests on each site's models used,
 * per local calendar day, kept for 90 days — DSH counts per conversation only.
 * One file, `$DSH_HOME/storages/custom-models-usage.json` (mode 0600): numbers
 * only, no key, no conversation.
 *
 * A request counts on the site and model that served it (a switch group's
 * on its chosen member): the tokens the site reported (what DSH sees too),
 * or — for a site whose answers carry none — an estimate from the text sent
 * and received (`estimated`), first-token latency and decode time, the cost
 * the site reported itself (Hyper), and failures. Counts gather in memory and
 * reach the file at most every few seconds, merged into what is there (a CLI
 * on the same home may count too).
 *
 * {@link usageReport} turns the days into what the tab shows: per site and
 * model today / 7 days / 30 days, and the last 30 days one by one, priced at
 * display time — the price the user set, else the site's, else none — so a
 * price set later applies to what was counted before.
 *
 * @module dsh-custom-models/usage
 */
import * as defaultFs from "node:fs/promises";
import { dirname } from "node:path";
import { asNumber, isRecord, safeJson } from "./errors.js";
import { dayOf, replaceFile } from "./keys.js";
import { usagePath } from "./paths.js";

export const USAGE_DAYS = 90;
/** The numbers one bucket (a site's model on one day) holds. */
/** `probes`: how many of the requests were model authenticity checks (authn/), counted in `requests` too. */
export const USAGE_FIELDS = Object.freeze(["requests", "input", "output", "cacheRead", "cacheWrite", "estimated", "failures", "ttftMs", "ttftCount", "decodeMs", "decodeTokens", "reported", "probes"]);
const VERSION = 1;
const FLUSH_MS = 3_000;
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_LIMIT = 200;

export const emptyBucket = () => Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));

/** Add a bucket's (or a request's) numbers into another; only finite, positive ones count. */
export function addInto(target, delta) {
  for (const field of USAGE_FIELDS) {
    const value = Number(delta?.[field]);
    if (Number.isFinite(value) && value > 0) target[field] = (Number(target[field]) || 0) + value;
  }
  return target;
}

/** Whatever is on disk, as a valid ledger: days → sites → models → buckets of non-negative numbers. */
export function coerceLedger(raw) {
  const days = {};
  for (const [day, sites] of Object.entries(isRecord(raw?.days) ? raw.days : {})) {
    if (!DAY_PATTERN.test(day) || !isRecord(sites)) continue;
    for (const [site, models] of Object.entries(sites)) {
      if (!site || site.length > 40 || !isRecord(models)) continue;
      for (const [model, bucket] of Object.entries(models)) {
        if (!model || model.length > ID_LIMIT || !isRecord(bucket)) continue;
        ((days[day] ??= {})[site] ??= {})[model] = addInto(emptyBucket(), bucket);
      }
    }
  }
  return { version: VERSION, days };
}

/** The local calendar days of the last `count` days, oldest first, ending today. */
export function lastDays(now, count) {
  return Array.from({ length: count }, (_, index) => dayOf(now - (count - 1 - index) * DAY_MS));
}

/** Days within the window only (a local calendar, so a day dropped is one older than `keep` days). */
export function pruneDays(days, now, keep = USAGE_DAYS) {
  const oldest = dayOf(now - (keep - 1) * DAY_MS);
  return Object.fromEntries(Object.entries(days).filter(([day]) => day >= oldest));
}

/**
 * A rough token count of text, for a site that reports none: a CJK character
 * is about one token, other text about four characters a token.
 */
export function estimateTokens(text) {
  const value = String(text ?? "");
  let wide = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) wide += 1;
  }
  return Math.ceil(wide + (value.length - wide) / 4);
}

/** The text a block carries (its own, its content's, a tool call's arguments); images count nothing. */
function textsOf(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) textsOf(item, out);
  else if (isRecord(value) && value.type !== "image") for (const field of ["text", "content", "arguments", "name"]) textsOf(value[field], out);
  return out;
}

/** A request's input, estimated: its system text, its messages' text, its tools' definitions. */
export function estimateRequestTokens(options) {
  const texts = textsOf(options?.system, []);
  for (const message of Array.isArray(options?.messages) ? options.messages : []) textsOf(message?.content, texts);
  for (const tool of Array.isArray(options?.tools) ? options.tools : []) texts.push(JSON.stringify({ name: tool?.name, description: tool?.description, parameters: tool?.parameters }));
  return texts.reduce((sum, text) => sum + estimateTokens(text), 0);
}

export class UsageLedger {
  #file;
  #fs;
  #now;
  #flushMs;
  /** Counts not on disk yet: "day\0site\0model" → bucket. */
  #pending = new Map();
  /** Sites removed since the last write: their days go with them. */
  #removed = new Set();
  #timer;
  #chain = Promise.resolve();
  #cache;
  #stamp;

  /** @param {object} [options] - `file`, `fs`, `now()`, `flushMs` (how long counts gather before a write). */
  constructor({ file = usagePath(), fs = defaultFs, now = () => Date.now(), flushMs = FLUSH_MS } = {}) {
    this.#file = file;
    this.#fs = fs;
    this.#now = now;
    this.#flushMs = flushMs;
  }

  path() {
    return this.#file;
  }

  /** Count one request (or a failure) of a site's model, today. */
  record(siteId, modelId, entry) {
    if (!siteId || !modelId) return;
    const key = `${dayOf(this.#now())}\u0000${siteId}\u0000${String(modelId).slice(0, ID_LIMIT)}`;
    addInto(this.#pending.get(key) ?? this.#pending.set(key, emptyBucket()).get(key), entry);
    this.#schedule();
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush().catch(() => undefined);
    }, this.#flushMs);
    this.#timer.unref?.();
  }

  /** The file as it is now, re-read when another process changed it. */
  async #disk() {
    let stamp;
    try {
      const info = await this.#fs.stat(this.#file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stamp = "absent";
    }
    if (this.#cache === undefined || stamp !== this.#stamp) {
      this.#cache = stamp === "absent" ? coerceLedger(null) : coerceLedger(safeJson(await this.#fs.readFile(this.#file, "utf8").catch(() => "")));
      this.#stamp = stamp;
    }
    return this.#cache;
  }

  /** The days with the counts not written yet, without the removed sites, within the window. */
  #merged(ledger, pending, removed) {
    const days = structuredClone(ledger.days);
    for (const [key, bucket] of pending) {
      const [day, site, model] = key.split("\u0000");
      addInto((((days[day] ??= {})[site] ??= {})[model] ??= emptyBucket()), bucket);
    }
    for (const sites of Object.values(days)) for (const site of removed) delete sites[site];
    for (const [day, sites] of Object.entries(days)) if (Object.keys(sites).length === 0) delete days[day];
    return pruneDays(days, this.#now());
  }

  /**
   * Every day kept, counts not written yet included. Queued behind a write in progress: its counts
   * have left memory but are not in the cache yet, and read halfway they would be missing.
   */
  async days() {
    const run = this.#chain.then(async () => this.#merged(await this.#disk(), this.#pending, this.#removed));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Write what gathered (merged into the file as it is now, atomically). */
  async flush() {
    const run = this.#chain.then(async () => {
      if (this.#pending.size === 0 && this.#removed.size === 0) return;
      const pending = this.#pending;
      const removed = this.#removed;
      this.#pending = new Map();
      this.#removed = new Set();
      try {
        const next = { version: VERSION, days: this.#merged(await this.#disk(), pending, removed) };
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
      } catch (error) {
        // Nothing is lost: the counts wait for the next write.
        for (const [key, bucket] of pending) addInto(this.#pending.get(key) ?? this.#pending.set(key, emptyBucket()).get(key), bucket);
        for (const site of removed) this.#removed.add(site);
        this.#schedule();
        throw error;
      }
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Forget a site's counts (the site was removed). */
  async removeSite(siteId) {
    for (const key of [...this.#pending.keys()]) if (key.split("\u0000")[1] === siteId) this.#pending.delete(key);
    this.#removed.add(siteId);
    await this.flush();
  }
}

// ----------------------------------------------------------------- report

/**
 * What a model's tokens cost per million, and in what: the price the user set
 * (`price`, USD or CNY), else the site's (`cost`: USD, or a new-api relay's
 * own quota, shown in yuan at the site's rate when the site shows yuan),
 * else null.
 */
export function priceOf(model, site) {
  const own = model?.price;
  if (isRecord(own)) return { rates: own, currency: own.currency === "CNY" ? "CNY" : "USD", from: "user" };
  const cost = model?.cost;
  if (!isRecord(cost)) return null;
  if (cost.unit === "quota") {
    const rate = asNumber(site?.platformInfo?.rate);
    const yuan = site?.platformInfo?.display === "CNY" && rate > 0;
    const scale = yuan ? rate : 1;
    return { rates: { input: cost.input * scale, output: cost.output * scale, cacheRead: (cost.cacheRead ?? 0) * scale, cacheWrite: (cost.cacheWrite ?? 0) * scale, ...(typeof cost.perRequest === "number" ? { perRequest: cost.perRequest * scale } : {}) }, currency: yuan ? "CNY" : "USD", from: "site", quota: true };
  }
  if (cost.unit && cost.unit !== "USD") return null;
  return { rates: cost, currency: "USD", from: "site" };
}

const tokensIn = (bucket) => bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;

/** A bucket's cost: what the site reported, else its tokens at the price; per currency. */
function costOf(bucket, price) {
  if (bucket.reported > 0) return { cost: { USD: bucket.reported }, from: "reported" };
  if (!price || (tokensIn(bucket) === 0 && !(typeof price.rates?.perRequest === "number" && bucket.requests > 0))) return { cost: null, from: price ? price.from : null };
  const rates = price.rates;
  // A price per call (a relay's fixed-price model) counts each request.
  const each = typeof rates.perRequest === "number" ? rates.perRequest * (bucket.requests ?? 0) : 0;
  const amount = ((rates.input ?? 0) * bucket.input + (rates.output ?? 0) * bucket.output + (rates.cacheRead ?? 0) * bucket.cacheRead + (rates.cacheWrite ?? 0) * bucket.cacheWrite) / 1e6 + each;
  return { cost: { [price.currency]: amount }, from: price.from };
}

/** Sum of costs per currency (null when nothing was priced). */
function addCost(total, cost) {
  if (!cost) return total;
  const out = { ...(total ?? {}) };
  for (const [currency, amount] of Object.entries(cost)) out[currency] = (out[currency] ?? 0) + amount;
  return out;
}

/** A bucket as the tab shows it: the numbers, the cost per currency, where its prices came from, and what went unpriced. */
function view(bucket = emptyBucket(), extra = {}) {
  return { ...bucket, tokens: tokensIn(bucket), cost: null, priced: [], unpriced: false, quota: false, ...extra };
}

/** Fold a priced model bucket into a total view. */
function foldInto(total, bucket, priced) {
  addInto(total, bucket);
  total.tokens = tokensIn(total);
  total.cost = addCost(total.cost, priced.cost);
  if (priced.from && !total.priced.includes(priced.from)) total.priced.push(priced.from);
  if (!priced.cost && tokensIn(bucket) > 0) total.unpriced = true;
  if (priced.quota) total.quota = true;
  return total;
}

/**
 * What the tab shows: per site and model today, 7 days and 30 days; per site
 * and overall the last 30 days one by one; priced now (see {@link priceOf}).
 * Models no longer on the site still show (unpriced) while they have counts.
 * @param {object} days - the ledger's days.
 * @param {object[]} sites - the stored sites (their models carry the prices).
 */
export function usageReport(days, sites, { now = Date.now() } = {}) {
  const window = lastDays(now, 30);
  const today = window.at(-1);
  const week = new Set(window.slice(-7));
  const siteById = new Map((Array.isArray(sites) ? sites : []).map((site) => [site.id, site]));
  const out = { today, days: window, totals: { today: view(), d7: view(), d30: view(), daily: window.map((date) => view(emptyBucket(), { date })) }, sites: {} };
  window.forEach((date, index) => {
    for (const [siteId, models] of Object.entries(days?.[date] ?? {})) {
      const site = siteById.get(siteId);
      // A site or model taken off is not reported, nor counted in any total (the counts stay on disk:
      // added back, it gets its history back).
      if (!site) continue;
      const entry = (out.sites[siteId] ??= { today: view(), d7: view(), d30: view(), daily: window.map((day) => view(emptyBucket(), { date: day })), models: {} });
      for (const [modelId, raw] of Object.entries(models)) {
        const model = site.models?.find((item) => item.id === modelId);
        if (!model) continue;
        const bucket = addInto(emptyBucket(), raw);
        const price = priceOf(model, site);
        const priced = { ...costOf(bucket, price), quota: price?.quota === true };
        const own = (entry.models[modelId] ??= { today: view(), d7: view(), d30: view() });
        const spans = [["d30", true], ["d7", week.has(date)], ["today", date === today]];
        for (const [span, inside] of spans) {
          if (!inside) continue;
          foldInto(own[span], bucket, priced);
          foldInto(entry[span], bucket, priced);
          foldInto(out.totals[span], bucket, priced);
        }
        foldInto(entry.daily[index], bucket, priced);
        foldInto(out.totals.daily[index], bucket, priced);
      }
    }
  });
  return out;
}
