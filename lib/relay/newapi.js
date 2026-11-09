/**
 * new-api: what a key (or a read-only account token) may read beside its quota (source: QuantumNous/new-api,
 * 2026-11, v1.0.0-rc.49).
 *
 * - `GET /api/log/token` (the key): the token's latest log entries (up to the site's `MaxRecentItems`, 1000 by
 *   default): when, which model, what it was billed (`quota`, in the site's quota unit), tokens, its group, and
 *   `other` — a JSON text whose user-visible fields say how the request was served: `is_model_mapped` with
 *   `upstream_model_name` (the site mapped the model to another upstream model), `response_model` (the upstream
 *   answered as another model, 2026-09-18), `is_system_prompt_overwritten`, `frt` (first response, ms), and a
 *   subscription's `subscription_plan_title` / `_remain` / `_total` / `_used`. Only consume entries (type 2) bill.
 * - `GET /api/perf-metrics/summary?hours=N` (public where the site shows its pricing page, 2026-05): per model the
 *   success rate, average latency and output speed the site measured itself.
 * - `GET /api/user/self`, `GET /api/subscription/self` (an account token: a personal access token with
 *   `profile:read` and `wallet:read`, 2026-09, or the older system access token with the `New-Api-User` header):
 *   the account's quota, use, group, and its subscriptions.
 *
 * @module dsh-custom-models/relay/newapi
 */
import { asNumber, asString, isRecord, safeJson } from "../errors.js";
import { relayAmount } from "../probe.js";

/** new-api's consume log type. */
const CONSUME = 2;
/** The entries one read may hold (new-api's `MaxRecentItems`): a read this full may have missed older ones. */
export const LOG_LIMIT = 1000;
const NAME = (value) => (asString(value) && value.length <= 200 ? value : null);

/** One log entry as this plugin keeps it (null: not one). */
export function parseLogEntry(raw) {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  const at = asNumber(raw.created_at);
  if (!Number.isInteger(id) || !(at > 0)) return null;
  const other = isRecord(raw.other) ? raw.other : isRecord(safeJson(raw.other)) ? safeJson(raw.other) : {};
  const response = isRecord(other.response_model) ? other.response_model : null;
  const subscription = asString(other.subscription_plan_title) || asNumber(other.subscription_total) !== undefined
    ? { title: NAME(other.subscription_plan_title), total: asNumber(other.subscription_total) ?? null, used: asNumber(other.subscription_used) ?? null, remain: asNumber(other.subscription_remain) ?? null }
    : null;
  return {
    id,
    at: at * 1000,
    type: asNumber(raw.type) ?? 0,
    model: NAME(raw.model_name),
    quota: Math.max(0, asNumber(raw.quota) ?? 0),
    input: Math.max(0, asNumber(raw.prompt_tokens) ?? 0),
    output: Math.max(0, asNumber(raw.completion_tokens) ?? 0),
    cacheRead: Math.max(0, asNumber(other.cache_tokens) ?? 0),
    group: NAME(raw.group),
    mapped: other.is_model_mapped === true && NAME(other.upstream_model_name) ? other.upstream_model_name : null,
    returned: response && NAME(response.returned_model) ? { requested: NAME(response.requested_model), upstream: NAME(response.upstream_model), returned: response.returned_model } : null,
    overwritten: other.is_system_prompt_overwritten === true,
    firstMs: asNumber(other.frt) > 0 ? asNumber(other.frt) : null,
    subscription,
  };
}

/** A read of `/api/log/token`: `{ entries }` newest first, or why there are none (`unsupported`: the site has no such endpoint). */
export function readTokenLog(response) {
  if (response.status === 404 || response.status === 405 || (response.ok && !isRecord(response.body))) return { unsupported: true, entries: [] };
  if (!response.ok) return { error: response.status, entries: [] };
  if (response.body.success === false) return { error: asString(response.body.message) ?? "refused", entries: [] };
  const list = Array.isArray(response.body.data) ? response.body.data : Array.isArray(response.body.data?.items) ? response.body.data.items : null;
  if (!list) return { unsupported: true, entries: [] };
  return { entries: list.map(parseLogEntry).filter(Boolean).sort((a, b) => b.id - a.id), full: list.length >= LOG_LIMIT };
}

/**
 * What a log read adds: the entries newer than the last one counted (by id), billed in the site's display currency
 * per day and model, and what the newest entries say of the key's group and subscription. `partial`: the read was
 * full and none of it reached the last entry counted, so some in between were missed.
 */
export function newLogEntries(entries, lastId, info) {
  const fresh = entries.filter((entry) => entry.id > (lastId ?? 0));
  const consumed = fresh.filter((entry) => entry.type === CONSUME && entry.model);
  const billed = consumed.map((entry) => ({ ...entry, amount: relayAmount(entry.quota, info) ?? 0 }));
  const newest = entries[0] ?? null;
  const subscribed = entries.find((entry) => entry.subscription)?.subscription ?? null;
  return {
    billed,
    lastId: newest ? Math.max(newest.id, lastId ?? 0) : lastId ?? 0,
    group: entries.find((entry) => entry.group)?.group ?? null,
    subscription: subscribed ? { title: subscribed.title, total: relayAmount(subscribed.total ?? undefined, info), used: relayAmount(subscribed.used ?? undefined, info), remain: relayAmount(subscribed.remain ?? undefined, info) } : null,
  };
}

/** `/api/perf-metrics/summary`: per model the site's own success rate (as 0–1; the site gives a percentage), average latency (ms) and output speed (tokens/s). */
export function readPerfSummary(response) {
  if (response.status === 404 || response.status === 401 || response.status === 403 || response.status === 405) return { unsupported: true };
  if (!response.ok || !isRecord(response.body) || response.body.success === false) return { error: response.status };
  const data = isRecord(response.body.data) ? response.body.data : null;
  if (!data || !Array.isArray(data.models)) return { unsupported: true };
  const models = {};
  for (const item of data.models) {
    const name = isRecord(item) ? NAME(item.model_name) : null;
    if (!name) continue;
    const success = asNumber(item.success_rate);
    models[name] = {
      // A percentage (new-api rounds it to two decimals).
      successRate: success === undefined ? null : Math.min(1, Math.max(0, success / 100)),
      latencyMs: asNumber(item.avg_latency_ms) ?? null,
      tps: asNumber(item.avg_tps) ?? null,
    };
  }
  return { models, windowStart: asNumber(data.window_start) ?? null, windowEnd: asNumber(data.window_end) ?? null };
}

/** The headers an account token goes with: a personal access token alone; the older system token with its user id. */
export function accountHeaders(account) {
  return account?.userId ? { "New-Api-User": String(account.userId) } : {};
}

/** `/api/user/self` with an account token: the account's quota, use, group, request count (null: not readable). */
export function readAccount(response, info) {
  if (!response.ok || !isRecord(response.body) || response.body.success === false || !isRecord(response.body.data)) return null;
  const data = response.body.data;
  const quota = asNumber(data.quota);
  if (quota === undefined) return null;
  return {
    amount: relayAmount(quota, info),
    used: relayAmount(asNumber(data.used_quota) ?? 0, info),
    requests: asNumber(data.request_count) ?? null,
    group: NAME(data.group),
    name: NAME(data.display_name) ?? NAME(data.username),
  };
}

/** `/api/subscription/self` with an account token: the active subscriptions (amounts in the site's display currency). */
export function readSubscriptions(response, info) {
  if (!response.ok || !isRecord(response.body) || response.body.success === false || !isRecord(response.body.data)) return null;
  const list = Array.isArray(response.body.data.subscriptions) ? response.body.data.subscriptions : [];
  return list.map((item) => (isRecord(item?.subscription) ? item.subscription : item)).filter(isRecord).map((sub) => ({
    plan: asNumber(sub.plan_id) ?? null,
    total: relayAmount(asNumber(sub.amount_total), info),
    used: relayAmount(asNumber(sub.amount_used) ?? 0, info),
    endsAt: asNumber(sub.end_time) > 0 ? new Date(sub.end_time * 1000).toISOString() : null,
    nextResetAt: asNumber(sub.next_reset_time) > 0 ? new Date(sub.next_reset_time * 1000).toISOString() : null,
    status: asString(sub.status) ?? null,
  })).filter((sub) => sub.status === null || sub.status === "active");
}
