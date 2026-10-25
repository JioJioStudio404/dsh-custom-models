/**
 * Is a key valid, and what does it have left? By the site's platform:
 *
 * - **Hyper**: `GET /v1/credits` — the team's Hypercredits (1 = $0.05; the
 *   free plan gets 100 a month). Its model list is public, so this is also
 *   the validity check.
 * - **new-api / one-api**: new-api's `GET /api/usage/token` (the key's own
 *   quota: granted, used, left, unlimited, expiry), else one-api's
 *   OpenAI-style `GET /v1/dashboard/billing/subscription` + `/usage` (whose
 *   `total_usage` is in hundredths). Amounts are in the site's quota unit
 *   (`quota_per_unit` from `/api/status`; shown as USD, CNY or tokens as the
 *   site displays). A key with unlimited quota shows what it used; the
 *   account's own balance needs the site's access token, which a key is not.
 * - **Vercel**: `GET /credits` (USD strings). **OpenRouter**: `GET /key` and
 *   `GET /credits`.
 * - **anything else**: `GET /models` proves a key where the list is not
 *   public; no balance.
 *
 * ✓ (`deep`) adds one tiny real request on the site's first model, which
 * proves the key, the model and the protocol together — the only proof on a
 * site whose model list answers any key. A transient failure (network, 5xx)
 * is retried once and then kept beside the last verdict.
 *
 * @module dsh-custom-models/probe
 */
import { classifyFailure, KIND_LABELS, noBalanceScope } from "./dialects.js";
import { endpointById, messagesBaseOf } from "./endpoints.js";
import { asNumber, asString, isRecord, redact } from "./errors.js";
import { requestJson } from "./wire.js";

export const NO_BALANCE_HOLD_MS = 30 * 60_000;
export const PLAN_HOLD_MS = 60 * 60_000;
const RETRY_DELAY_MS = 800;
const PROBE_TIMEOUT_MS = 60_000;
/** Hyper: one Hypercredit is five cents (its docs). */
export const HYPERCREDIT_USD = 0.05;
const NO_HOLD = { limitedUntil: undefined, limitedReason: undefined, limitedExact: undefined, limitedScope: undefined };
/** Statuses a validity check may overturn: a funds verdict is not its business. */
const VALIDITY_OWNS = new Set([undefined, "unknown", "invalid", "error"]);

/** A key's state from one classified failure. */
export function statusFromFailure(failure, now = Date.now()) {
  switch (failure.kind) {
    case "invalid-key":
      return { status: "invalid", statusMessage: failure.message, ...NO_HOLD };
    case "expired":
      return { status: "expired", statusMessage: failure.message, ...NO_HOLD };
    case "no-balance":
      return { status: "no-balance", statusMessage: failure.message, limitedUntil: now + NO_BALANCE_HOLD_MS, limitedReason: "no-balance", limitedExact: false, limitedScope: noBalanceScope({ statusMessage: failure.message }) };
    case "plan-quota": {
      const exact = Boolean(failure.resetAt && failure.resetAt > now);
      return { status: "plan-quota", statusMessage: failure.message, limitedUntil: exact ? failure.resetAt : now + PLAN_HOLD_MS, limitedReason: "plan-quota", limitedExact: exact };
    }
    // The key got through: it is valid, just busy or refused this one request (or this one model).
    case "rate-limit":
    case "overloaded":
    case "moderation":
    case "bad-request":
    case "context":
    case "not-found":
    case "region":
    case "model-denied":
    case "paid-model":
    case "forbidden":
      return { status: "ok", statusMessage: failure.message };
    default:
      return { status: "error", statusMessage: failure.message };
  }
}

/** Where one key's funds are read; null where its site shows none. */
export const fundsKind = (record, endpoint = endpointById(record?.endpoint)) => endpoint?.check?.funds ?? null;

const transient = (response) => response.status === 0 || response.status >= 500;

function context(record, { fetchImpl, signal, now, retryDelayMs }) {
  const endpoint = endpointById(record.endpoint);
  const checkedAt = new Date(now()).toISOString();
  const call = async (url, extra) => {
    const first = await requestJson(url, record.key, { fetchImpl, signal, headers: endpoint?.headers, ...extra });
    if (!transient(first) || retryDelayMs < 0) return first;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return requestJson(url, record.key, { fetchImpl, signal, headers: endpoint?.headers, ...extra });
  };
  const classify = (response) => classifyFailure(endpoint?.platform ?? "generic", response.status, response.text, { headers: response.headers });
  const why = (response, failure) => (response.timedOut ? "请求超时" : response.status === 0 ? `网络错误：${redact(response.text)}` : redact(failure?.message ?? `HTTP ${response.status}`));
  return { endpoint, checkedAt, now, call, classify, why, fetchImpl, signal };
}

/** A failed check request: a verdict when the site gave one, else a note beside the last one. */
function validityFailed(record, ctx, response) {
  const failure = ctx.classify(response);
  const verdict = statusFromFailure(failure, ctx.now());
  if ((verdict.status === "invalid" || verdict.status === "expired") && !transient(response)) return { ...verdict, checkedAt: ctx.checkedAt, validityError: null, authenticated: false };
  if (response.status === 404 || transient(response) || verdict.status === "error") {
    const message = response.status === 404 ? "检测接口不可用（404）" : ctx.why(response, failure);
    return { checkedAt: ctx.checkedAt, validityError: message, ...(record.status === undefined || record.status === "unknown" ? { status: "error", statusMessage: message } : {}) };
  }
  return { ...verdict, checkedAt: ctx.checkedAt, validatedAt: ctx.checkedAt, validityError: null, authenticated: true };
}

/** The site accepted the key. */
function passed(record, ctx) {
  return { checkedAt: ctx.checkedAt, validatedAt: ctx.checkedAt, validityError: null, authenticated: true, ...(VALIDITY_OWNS.has(record.status) ? { status: "ok", statusMessage: null } : {}) };
}

/**
 * A balance read: the verdict it carries, keeping a hold the balance cannot judge (a budget, a rate limit).
 * `judges` is what the read sees: `account` (the money itself: Hyper, Vercel, OpenRouter), `key` (a
 * relay token's own quota) or `none` (an unlimited token). A "no balance" a read cannot see — the
 * account behind a token that still has quota, or any behind an unlimited one — stays until a request
 * is served or ✓ gets an answer (new-api refuses "用户额度不足" while the token reads unlimited).
 */
function withBalance(record, ctx, balance, { empty = false, emptyMessage = "余额已用完", judges = "account" } = {}) {
  const base = { ...passed(record, ctx), balance, quotaAt: ctx.checkedAt, quotaError: null, quotaHint: undefined };
  const now = ctx.now();
  if (typeof record.limitedUntil === "number" && record.limitedUntil > now && record.limitedReason !== "no-balance") return base;
  if (empty) return { ...base, status: "no-balance", statusMessage: emptyMessage, limitedUntil: now + NO_BALANCE_HOLD_MS, limitedReason: "no-balance", limitedExact: false, limitedScope: judges === "account" ? "account" : "key" };
  if (record.status === "no-balance" && !(judges === "account" || (judges === "key" && noBalanceScope(record) === "key"))) return base;
  return { ...base, status: "ok", statusMessage: null, ...NO_HOLD };
}

/** Hyper's `/v1/credits`: Hypercredits left (validity and funds in one free read). */
async function hyper(record, ctx, { funds }) {
  const origin = new URL(ctx.endpoint.baseUrl).origin;
  const response = await ctx.call(`${origin}/v1/credits`);
  if (!response.ok) return { ...validityFailed(record, ctx, response), ...(funds && transient(response) ? { quotaError: ctx.why(response) } : {}) };
  if (!funds) return passed(record, ctx);
  const credits = asNumber(response.body?.balance);
  return withBalance(record, ctx, { currency: "credits", amount: credits ?? null, usd: credits === undefined ? null : Math.round(credits * HYPERCREDIT_USD * 1e4) / 1e4 }, { empty: credits !== undefined && credits <= 0, emptyMessage: "Hypercredits 已用完" });
}

/** Vercel's `/credits`: the team's balance and total spend (USD strings). */
async function vercel(record, ctx, { funds }) {
  const response = await ctx.call(`${ctx.endpoint.baseUrl}/credits`);
  if (!response.ok) return { ...validityFailed(record, ctx, response), ...(funds && transient(response) ? { quotaError: ctx.why(response) } : {}) };
  if (!funds) return passed(record, ctx);
  const amount = asNumber(response.body?.balance);
  return withBalance(record, ctx, { currency: "USD", amount: amount ?? null, totalUsed: asNumber(response.body?.total_used) ?? null }, { empty: amount !== undefined && amount <= 0 });
}

/** OpenRouter's `/key` (the key's limit and spend) and `/credits` (the account). */
async function openrouter(record, ctx, { funds }) {
  const response = await ctx.call(`${ctx.endpoint.baseUrl}/key`);
  if (!response.ok) return { ...validityFailed(record, ctx, response), ...(funds && transient(response) ? { quotaError: ctx.why(response) } : {}) };
  if (!funds) return passed(record, ctx);
  const data = isRecord(response.body?.data) ? response.body.data : {};
  const credits = await ctx.call(`${ctx.endpoint.baseUrl}/credits`);
  const total = asNumber(credits.body?.data?.total_credits);
  const used = asNumber(credits.body?.data?.total_usage);
  const amount = total !== undefined && used !== undefined ? Math.max(0, Math.round((total - used) * 1e4) / 1e4) : null;
  return { ...withBalance(record, ctx, { currency: "USD", amount, keyLimit: asNumber(data.limit) ?? null, keyRemaining: asNumber(data.limit_remaining) ?? null, totalUsed: asNumber(data.usage) ?? null }), quotaError: credits.ok ? null : ctx.why(credits) };
}

/** A new-api / one-api amount in its display unit: quota → dollars (or yuan), or tokens as they are. */
function relayAmount(quota, info) {
  if (quota === undefined) return null;
  const perUnit = asNumber(info?.quotaPerUnit) ?? 500000;
  if (info?.display === "TOKENS") return quota;
  const dollars = quota / perUnit;
  const value = info?.display === "CNY" && asNumber(info?.rate) ? dollars * info.rate : dollars;
  return Math.round(value * 1e6) / 1e6;
}
const relayCurrency = (info) => (info?.display === "TOKENS" ? "tokens" : info?.display === "CNY" ? "CNY" : "USD");

/** new-api's `/api/usage/token`, else one-api's dashboard billing: the key's quota (or what an unlimited key used). */
async function newapi(record, ctx, { funds }, site) {
  const origin = new URL(ctx.endpoint.baseUrl).origin;
  const info = site?.platformInfo ?? null;
  const token = await ctx.call(`${origin}/api/usage/token`);
  if (token.status === 401 || token.status === 403) return validityFailed(record, ctx, token);
  const data = isRecord(token.body?.data) ? token.body.data : null;
  if (token.ok && data && data.object === "token_usage") {
    if (!funds) return passed(record, ctx);
    const expiresAt = asNumber(data.expires_at) > 0 ? new Date(data.expires_at * 1000).toISOString() : null;
    const unlimited = data.unlimited_quota === true;
    const left = relayAmount(asNumber(data.total_available), info);
    const balance = { currency: relayCurrency(info), amount: unlimited ? null : left, used: relayAmount(asNumber(data.total_used), info), unlimited, scope: "key", ...(expiresAt ? { expiresAt } : {}) };
    if (expiresAt && Date.parse(expiresAt) <= ctx.now()) return { ...passed(record, ctx), balance, quotaAt: ctx.checkedAt, quotaError: null, status: "expired", statusMessage: "令牌已过期", ...NO_HOLD };
    return withBalance(record, ctx, balance, { empty: !unlimited && left !== null && left <= 0, emptyMessage: "令牌额度已用完", judges: unlimited ? "none" : "key" });
  }
  // one-api (and new-api without the token endpoint): the OpenAI-style billing pair.
  const subscription = await ctx.call(`${origin}/v1/dashboard/billing/subscription`);
  if (subscription.status === 401 || subscription.status === 403) return validityFailed(record, ctx, subscription);
  if (transient(subscription)) return { ...validityFailed(record, ctx, subscription), ...(funds ? { quotaError: ctx.why(subscription) } : {}) };
  const limit = asNumber(subscription.body?.hard_limit_usd);
  // Neither answers with a balance (a fork without them, or the site's web page for an unknown path):
  // the model list proves the key, and the cell says the site shows no balance.
  if (!subscription.ok || limit === undefined) return { ...(await generic(record, ctx)), balance: undefined, quotaAt: ctx.checkedAt, quotaError: null, quotaHint: "这个站点没有开放余额查询接口" };
  if (!funds) return passed(record, ctx);
  const usage = await ctx.call(`${origin}/v1/dashboard/billing/usage`);
  const used = asNumber(usage.body?.total_usage) === undefined ? null : Math.round((asNumber(usage.body.total_usage) / 100) * 1e6) / 1e6;
  const unlimited = limit !== undefined && limit >= 1e8;
  const amount = unlimited || limit === undefined ? null : Math.round((limit - (used ?? 0)) * 1e6) / 1e6;
  // one-api answers with the token's quota or the user's, by a site setting: judged as the token's.
  return { ...withBalance(record, ctx, { currency: relayCurrency(info), amount, used, unlimited, scope: "account" }, { empty: amount !== null && amount <= 0, judges: unlimited || amount === null ? "none" : "key" }), quotaError: usage.ok ? null : ctx.why(usage) };
}

/** A plain OpenAI-compatible site: its model list proves a key, unless the list is public. */
async function generic(record, ctx) {
  if (ctx.endpoint.modelsPublic) return { checkedAt: ctx.checkedAt, validityError: null, unproven: true };
  const response = await ctx.call(`${ctx.endpoint.baseUrl}/models`);
  return response.ok ? passed(record, ctx) : validityFailed(record, ctx, response);
}

async function checkSite(record, ctx, { funds }, site) {
  switch (ctx.endpoint.platform) {
    case "hyper": return hyper(record, ctx, { funds });
    case "vercel": return vercel(record, ctx, { funds });
    case "openrouter": return openrouter(record, ctx, { funds });
    case "newapi": return newapi(record, ctx, { funds }, site);
    default: return generic(record, ctx);
  }
}

/** The smallest real request in a protocol (undefined: Gemini, which this plugin no longer serves). */
function probeRequest(endpoint, model) {
  const protocol = model.protocol ?? endpoint.protocol;
  const hello = [{ role: "user", content: "hi" }];
  if (protocol === "gemini") return undefined;
  if (protocol === "messages") return { url: `${messagesBaseOf(endpoint, model)}/v1/messages`, auth: "both", body: { model: model.id, max_tokens: 16, messages: hello } };
  if (protocol === "responses") return { url: `${endpoint.baseUrl}/responses`, body: { model: model.id, input: "hi", max_output_tokens: 16 } };
  return { url: `${endpoint.baseUrl}/chat/completions`, body: { model: model.id, messages: hello, max_tokens: 16 } };
}

/**
 * One tiny request on the site's models, first added first, until one answers
 * for the key (a refusal of the model alone tries the next, up to three).
 */
async function checkAvailability(record, ctx, models) {
  const candidates = models.filter((model) => model?.id).slice(0, 3);
  if (candidates.length === 0) return { checkedAt: ctx.checkedAt, probeError: "还没有添加模型，无法发测试请求" };
  const notes = [];
  for (const model of candidates) {
    const request = probeRequest(ctx.endpoint, model);
    if (!request) {
      notes.push(`${model.id}：Gemini 协议已不支持`);
      continue;
    }
    const response = await requestJson(request.url, record.key, { method: "POST", body: request.body, auth: request.auth, headers: ctx.endpoint.headers, fetchImpl: ctx.fetchImpl, signal: ctx.signal, timeoutMs: PROBE_TIMEOUT_MS });
    if (response.ok) {
      return { status: "ok", statusMessage: null, ...NO_HOLD, checkedAt: ctx.checkedAt, validatedAt: ctx.checkedAt, validityError: null, authenticated: true, probedAt: ctx.checkedAt, probeModel: model.id, probeError: null, probeNote: notes.join("；") || null };
    }
    const failure = ctx.classify(response);
    if (["invalid-key", "expired", "no-balance", "plan-quota"].includes(failure.kind)) {
      return { ...statusFromFailure(failure, ctx.now()), checkedAt: ctx.checkedAt, ...(failure.kind === "invalid-key" ? { authenticated: false } : { validatedAt: ctx.checkedAt, authenticated: true }), validityError: null, probedAt: ctx.checkedAt, probeModel: model.id, probeError: null, probeNote: notes.join("；") || null };
    }
    notes.push(`${model.id}：${response.timedOut ? "超时" : KIND_LABELS[failure.kind] ?? ctx.why(response, failure)}`);
  }
  return { checkedAt: ctx.checkedAt, probeError: notes.join("；") || "没有得到结论" };
}

/**
 * Check one key.
 * @param {object} record - the stored key (with its secret).
 * @param {object} [options] - `mode` (`auto` | `validity` | `funds` | `probe`), `deep` (add the tiny request), `site` (its settings: platform info, models), `fetchImpl`, `signal`, `now`, `retryDelayMs`.
 * @returns a patch for the key store, plus `authenticated` for the caller.
 */
export async function checkKey(record, { mode = "auto", deep = false, site, fetchImpl = fetch, signal, now = () => Date.now(), retryDelayMs = RETRY_DELAY_MS } = {}) {
  const ctx = context(record, { fetchImpl, signal, now, retryDelayMs });
  if (!ctx.endpoint) return { checkedAt: ctx.checkedAt, status: "error", statusMessage: "这个 Key 的站点已不存在", authenticated: false };
  const models = Array.isArray(site?.models) ? site.models : [];
  if (mode === "probe") return checkAvailability(record, ctx, models);
  const result = await checkSite(record, ctx, { funds: mode !== "validity" && Boolean(fundsKind(record, ctx.endpoint)) }, site);
  if (!(deep || (result.unproven && mode !== "validity" && !record.probedAt))) return result;
  if (result.authenticated === false) return result;
  // ✓ — or a site whose model list answers any key and nothing proved this one yet: one tiny request.
  return { ...result, ...(await checkAvailability({ ...record, ...result }, ctx, models)) };
}

/** Whether a check proved the key belongs to its site (whatever its balance). */
export const authenticated = (result) => result?.authenticated === true;
