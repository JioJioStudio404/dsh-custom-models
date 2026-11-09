/**
 * Keeps what relay systems tell beside the balance current, and reports it.
 *
 * Per key (by its site's platform): new-api's log — what each request was billed, the key's group, its subscription,
 * and what the log says of the model served (for model verification, while passive monitoring is on); sub2api's and
 * CRS's own statistics — the key's spend per day and per model. Per site: new-api's performance figures, sub2api's
 * model plaza. Every read is free and read-only; an endpoint a site lacks is asked again a day later (store.js).
 *
 * When: a few seconds after a key served (at most once a minute per key), on ↻, and once after the start. A site's
 * statistics and figures are read at most every 30 minutes, its plaza every 6 hours, unless asked by hand.
 *
 * @module dsh-custom-models/relay/sync
 */
import { endpointById } from "../endpoints.js";
import { asNumber, isRecord, redact } from "../errors.js";
import { dayOf } from "../keys.js";
import { requestJson } from "../wire.js";
import { readCrsModelStats } from "./crs.js";
import { compareModelNames } from "./names.js";
import { accountHeaders, newLogEntries, readAccount, readPerfSummary, readSubscriptions, readTokenLog } from "./newapi.js";
import { factKey } from "./store.js";
import { dateBefore, readPlaza, readUsageStats } from "./sub2api.js";

const AFTER_USE_DELAY_MS = 10_000;
const LOG_GAP_MS = 60_000;
const STATS_GAP_MS = 30 * 60_000;
const PERF_GAP_MS = 30 * 60_000;
const PLAZA_GAP_MS = 6 * 3_600_000;
const FACT_NAMES = 20;
/** The platforms this module reads. */
export const RELAY_PLATFORMS = new Set(["newapi", "sub2api", "crs"]);

const originOf = (site) => new URL(site.baseUrl).origin;
const fresh = (at, gap, now) => typeof at === "number" && now - at < gap;

/**
 * @param {object} deps - `keys` (KeyStore), `settings` (SettingsStore), `store` (RelayStore), `factsOn()` (whether
 *   the log's evidence is gathered: passive monitoring on), `account(siteId)` (a site's read-only account token, if
 *   the user gave one), `fetchImpl`, `log`, `now`, `delayMs`, `gapMs`.
 */
export function createRelaySync({ keys, settings, store, factsOn = async () => false, account = async () => null, onGroup = () => {}, fetchImpl = fetch, log = () => {}, now = () => Date.now(), delayMs = AFTER_USE_DELAY_MS, gapMs = LOG_GAP_MS }) {
  const running = new Map();
  const call = (url, key, options = {}) => requestJson(url, key, { fetchImpl, timeoutMs: 20_000, ...options });

  /** new-api: the token's log (billing, group, subscription, evidence). */
  async function newapiKey(record, site, force) {
    const id = record.id;
    const state = await store.read();
    const own = state.keys[id] ?? {};
    if (!force && fresh(own.log?.at, gapMs, now())) return;
    if (!(await store.allowed(site.id, "log"))) return;
    const response = await call(`${originOf(site)}/api/log/token`, record.key, { headers: endpointById(site.id)?.headers });
    const read = readTokenLog(response);
    if (read.unsupported) return store.capability(site.id, "log", false);
    if (read.error !== undefined) {
      await store.update((s) => {
        const entry = (s.keys[id] ??= { site: site.id });
        entry.log = { ...(entry.log ?? {}), at: now(), error: typeof read.error === "number" ? `HTTP ${read.error}` : String(read.error).slice(0, 200) };
      });
      return;
    }
    await store.capability(site.id, "log", true);
    const lastId = own.log?.lastId ?? 0;
    const added = newLogEntries(read.entries, lastId, site.platformInfo);
    // The active key's group changed (or is known for the first time): the site's prices follow it.
    const active = await keys.active(site.id);
    if (added.group && added.group !== (own.log?.group ?? null) && active?.id === id) queueMicrotask(() => onGroup(site.id, added.group));
    const evidence = (await factsOn()) ? read.entries.filter((entry) => entry.id > lastId && entry.type === 2 && entry.model) : [];
    await store.update((s) => {
      const entry = (s.keys[id] ??= { site: site.id });
      entry.site = site.id;
      const billed = (entry.billed ??= { currency: null, days: {}, since: now() });
      billed.currency = site.platformInfo?.display === "TOKENS" ? "tokens" : site.platformInfo?.display === "CNY" ? "CNY" : "USD";
      for (const item of added.billed) {
        const bucket = ((billed.days[dayOf(item.at)] ??= {})[item.model] ??= { amount: 0, requests: 0, tokens: 0 });
        bucket.amount = Math.round((bucket.amount + item.amount) * 1e8) / 1e8;
        bucket.requests += 1;
        bucket.tokens += item.input + item.output;
      }
      // A full read that never reached the last entry counted: some in between were missed.
      const partial = lastId > 0 && read.full && !read.entries.some((item) => item.id <= lastId);
      entry.log = { lastId: added.lastId, at: now(), group: added.group ?? entry.log?.group ?? null, ...(partial || entry.log?.partial ? { partial: true } : {}) };
      if (added.subscription) entry.subscription = { ...added.subscription, at: now(), from: "log" };
      for (const item of evidence) noteFacts(s, site.id, item);
    });
  }

  /** What one log entry says of the model it served, kept per site and model (counts and the latest time). */
  function noteFacts(state, siteId, item) {
    const facts = (state.facts[factKey(siteId, item.model)] ??= { checked: 0, since: item.at, mapped: {}, returned: {}, overwritten: null });
    facts.checked += 1;
    facts.last = Math.max(facts.last ?? 0, item.at);
    const note = (bucket, name, relation) => {
      if (!bucket[name] && Object.keys(bucket).length >= FACT_NAMES) return;
      const entry = (bucket[name] ??= { n: 0, at: 0, relation });
      entry.n += 1;
      entry.at = Math.max(entry.at, item.at);
    };
    if (item.mapped) {
      const relation = compareModelNames(item.model, item.mapped);
      if (relation !== "same") note(facts.mapped, item.mapped, relation);
    }
    if (item.returned) {
      const served = item.returned.returned;
      const against = item.returned.upstream || item.model;
      const relation = compareModelNames(item.model, served);
      if (relation !== "same" && compareModelNames(against, served) !== "same") note(facts.returned, served, relation);
    }
    if (item.overwritten) facts.overwritten = { n: (facts.overwritten?.n ?? 0) + 1, at: Math.max(facts.overwritten?.at ?? 0, item.at) };
  }

  /** sub2api: the key's spend per day (30 days) and per model (today, 7 days, 30 days), as the site counted it. */
  async function sub2apiKey(record, site, force) {
    const state = await store.read();
    if (!force && fresh(state.keys[record.id]?.stats?.at, STATS_GAP_MS, now())) return;
    const today = dateBefore(now(), 0);
    const base = `${originOf(site)}/v1/usage`;
    const headers = endpointById(site.id)?.headers;
    const first = await call(`${base}?days=30&start_date=${today}&end_date=${today}`, record.key, { headers });
    if (!first.ok) return;
    const day = readUsageStats(first.body);
    if (!day) return;
    const week = readUsageStats((await call(`${base}?days=1&start_date=${dateBefore(now(), 6)}&end_date=${today}`, record.key, { headers })).body);
    const month = readUsageStats((await call(`${base}?days=1&start_date=${dateBefore(now(), 29)}&end_date=${today}`, record.key, { headers })).body);
    await store.update((s) => {
      const entry = (s.keys[record.id] ??= { site: site.id });
      entry.site = site.id;
      entry.stats = { at: now(), currency: "USD", daily: day.daily, models: { today: day.models, ...(week ? { d7: week.models } : {}), ...(month ? { d30: month.models } : {}) } };
    });
  }

  /** CRS: the key's spend per model, today and this month. */
  async function crsKey(record, site, force) {
    const state = await store.read();
    if (!force && fresh(state.keys[record.id]?.stats?.at, STATS_GAP_MS, now())) return;
    const url = `${originOf(site)}/apiStats/api/user-model-stats`;
    const headers = endpointById(site.id)?.headers;
    const daily = readCrsModelStats((await call(url, null, { method: "POST", body: { apiKey: record.key, period: "daily" }, headers })).body);
    if (!daily) return;
    const monthly = readCrsModelStats((await call(url, null, { method: "POST", body: { apiKey: record.key, period: "monthly" }, headers })).body);
    await store.update((s) => {
      const entry = (s.keys[record.id] ??= { site: site.id });
      entry.site = site.id;
      entry.stats = { at: now(), currency: "USD", daily: {}, models: { today: daily, ...(monthly ? { month: monthly } : {}) } };
    });
  }

  /** new-api with an account token the user gave: the account's quota and subscriptions. */
  async function newapiAccount(site, force) {
    const token = await account(site.id);
    if (!token?.token) return;
    const state = await store.read();
    if (!force && fresh(state.sites[site.id]?.account?.at, gapMs, now())) return;
    const headers = { ...(endpointById(site.id)?.headers ?? {}), ...accountHeaders(token) };
    const self = await call(`${originOf(site)}/api/user/self`, token.token, { headers });
    const info = readAccount(self, site.platformInfo);
    const subs = info ? readSubscriptions(await call(`${originOf(site)}/api/subscription/self`, token.token, { headers }), site.platformInfo) : null;
    await store.update((s) => {
      const entry = (s.sites[site.id] ??= {});
      entry.account = info
        ? { at: now(), ...info, currency: site.platformInfo?.display === "CNY" ? "CNY" : site.platformInfo?.display === "TOKENS" ? "tokens" : "USD", subscriptions: subs ?? [] }
        : { at: now(), error: self.status === 401 || self.status === 403 ? "denied" : `HTTP ${self.status}` };
    });
  }

  /** Read what a key's site offers for it (and the site's account, when the user gave a token). */
  async function refreshKey(id, { force = false } = {}) {
    const name = `${id}:${force}`;
    if (running.has(name)) return running.get(name);
    const run = (async () => {
      const record = await keys.get(id);
      if (!record) return;
      const site = await settings.site(record.endpoint);
      if (!site || !RELAY_PLATFORMS.has(site.platform) || site.enabled === false) return;
      try {
        if (site.platform === "newapi") {
          await newapiKey(record, site, force);
          await newapiAccount(site, force);
        } else if (site.platform === "sub2api") await sub2apiKey(record, site, force);
        else if (site.platform === "crs") await crsKey(record, site, force);
      } catch (error) {
        log("warn", `relay read for ${id} failed: ${redact(error?.message ?? error)}`);
      }
    })().finally(() => running.delete(name));
    running.set(name, run);
    return run;
  }

  /** Read what a site offers for all (new-api's performance figures, sub2api's plaza). */
  async function refreshSite(siteId, { force = false } = {}) {
    const site = await settings.site(siteId);
    if (!site || !RELAY_PLATFORMS.has(site.platform)) return null;
    const state = await store.read();
    const own = state.sites[site.id] ?? {};
    const headers = endpointById(site.id)?.headers;
    try {
      if (site.platform === "newapi" && (force || !fresh(own.perf?.at, PERF_GAP_MS, now())) && (await store.allowed(site.id, "perf"))) {
        const read = readPerfSummary(await call(`${originOf(site)}/api/perf-metrics/summary?hours=24`, null, { headers }));
        if (read.unsupported) await store.capability(site.id, "perf", false);
        else if (read.models) await store.update((s) => { (s.sites[site.id] ??= {}).perf = { at: now(), hours: 24, models: read.models }; });
      }
      if (site.platform === "sub2api" && (force || !fresh(own.plaza?.at, PLAZA_GAP_MS, now())) && (await store.allowed(site.id, "plaza"))) {
        const read = readPlaza(await call(`${originOf(site)}/api/v1/model-plaza`, null, { headers }));
        if (read.unsupported) await store.capability(site.id, "plaza", false);
        else if (read.groups) await store.update((s) => { (s.sites[site.id] ??= {}).plaza = { at: now(), groups: read.groups }; });
      }
    } catch (error) {
      log("warn", `relay read for site ${siteId} failed: ${redact(error?.message ?? error)}`);
    }
    return (await store.read()).sites[site.id] ?? null;
  }

  const pending = new Set();
  /** A few seconds after a key served: its log (or statistics) read again, at most once a minute. */
  function afterUse(id) {
    if (!id || pending.has(id)) return;
    pending.add(id);
    const timer = setTimeout(() => {
      pending.delete(id);
      refreshKey(id).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
  }

  /** What the site's log says of one model (null: nothing read yet), for model verification. */
  async function facts(siteId, modelId) {
    const state = await store.read();
    return state.facts[factKey(siteId, modelId)] ?? null;
  }

  /** Every model's facts (site + model → facts), for model verification's views. */
  async function allFacts() {
    return (await store.read()).facts;
  }

  /** Read a site's account now (its token was just set). */
  async function refreshAccount(siteId) {
    const site = await settings.site(siteId);
    if (site?.platform === "newapi") await newapiAccount(site, true);
  }

  return { refreshKey, refreshSite, refreshAccount, afterUse, facts, allFacts };
}

/** Sum one period's per-model amounts into a site's report. */
function addPeriod(target, models) {
  for (const [model, value] of Object.entries(models ?? {})) {
    const own = (target.models[model] ??= { amount: 0, requests: 0 });
    own.amount += asNumber(value?.amount) ?? 0;
    own.requests += asNumber(value?.requests) ?? 0;
    target.total += asNumber(value?.amount) ?? 0;
    target.requests += asNumber(value?.requests) ?? 0;
  }
}
const period = () => ({ total: 0, requests: 0, models: {} });

/**
 * What the page shows of the relay data, per site: what the site billed the site's keys (today, 7 days, 30 days or
 * this month, per model and per day; its currency; since when it is read and whether reads missed some), the key's
 * group and subscription, the account (an account token), the site's own performance figures and its plaza.
 */
export function relayReport(state, sites, keyRecords, { now = Date.now() } = {}) {
  const out = {};
  const today = dayOf(now);
  const days = Array.from({ length: 30 }, (_, index) => dayOf(now - (29 - index) * 86_400_000));
  const week = new Set(days.slice(-7));
  const siteById = new Map((sites ?? []).map((site) => [site.id, site]));
  for (const record of keyRecords ?? []) {
    const own = state?.keys?.[record.id];
    const site = siteById.get(record.endpoint);
    if (!own || !site) continue;
    const entry = (out[site.id] ??= { billed: null, keys: {} });
    entry.keys[record.id] = { group: own.log?.group ?? null, subscription: own.subscription ?? null, logError: own.log?.error ?? null };
    const billed = (entry.billed ??= { currency: null, source: null, today: period(), d7: period(), d30: period(), month: null, daily: Object.fromEntries(days.map((day) => [day, 0])), since: null, partial: false, at: null });
    if (isRecord(own.billed?.days)) {
      billed.source = "log";
      billed.currency = own.billed.currency ?? billed.currency;
      billed.since = billed.since === null ? own.billed.since ?? null : Math.min(billed.since, own.billed.since ?? billed.since);
      billed.partial ||= own.log?.partial === true;
      billed.at = Math.max(billed.at ?? 0, own.log?.at ?? 0) || null;
      for (const day of days) {
        const models = own.billed.days[day];
        if (!models) continue;
        if (day === today) addPeriod(billed.today, models);
        if (week.has(day)) addPeriod(billed.d7, models);
        addPeriod(billed.d30, models);
        billed.daily[day] += Object.values(models).reduce((sum, item) => sum + (asNumber(item?.amount) ?? 0), 0);
      }
    } else if (isRecord(own.stats)) {
      billed.source = "stats";
      billed.currency = own.stats.currency ?? "USD";
      billed.at = Math.max(billed.at ?? 0, own.stats.at ?? 0) || null;
      addPeriod(billed.today, own.stats.models?.today);
      if (own.stats.models?.d7) addPeriod(billed.d7, own.stats.models.d7);
      if (own.stats.models?.d30) addPeriod(billed.d30, own.stats.models.d30);
      if (own.stats.models?.month) addPeriod((billed.month ??= period()), own.stats.models.month);
      if (!own.stats.models?.d7) billed.d7 = null;
      if (!own.stats.models?.d30) billed.d30 = null;
      for (const [day, value] of Object.entries(own.stats.daily ?? {})) if (day in billed.daily) billed.daily[day] += asNumber(value?.amount) ?? 0;
    }
  }
  for (const [siteId, value] of Object.entries(state?.sites ?? {})) {
    if (!siteById.has(siteId)) continue;
    const entry = (out[siteId] ??= { billed: null, keys: {} });
    if (value.perf) entry.perf = value.perf;
    if (value.account) entry.account = value.account;
    if (value.plaza) entry.plaza = { at: value.plaza.at, groups: (value.plaza.groups ?? []).map((group) => ({ name: group.name, platform: group.platform, rate: group.rate, peak: group.peak ?? null, models: group.models.length })) };
  }
  return out;
}
