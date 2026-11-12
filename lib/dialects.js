/**
 * What differs between the sites: reasoning levels, and what a failure
 * means for the key that got it. The "vendor" a failure is read for is the
 * site's platform (`newapi`, `hyper`, `vercel`, `openrouter`, `generic`);
 * every site also gets the wording relays share (new-api / one-api's, in
 * English and Chinese).
 *
 * Failures are classified from the vendor's own error body, not the HTTP
 * status alone: OpenAI says "no credits" with a 429 (`insufficient_quota`) —
 * or inside a 200 stream —, Anthropic with a 400 ("credit balance is too
 * low"), OpenRouter with a 402 that names which budget ran out, Google with a
 * 403 `CONSUMER_SUSPENDED` for a dead project. Shapes were checked against
 * live answers on 2026-10-15 where a key allowed it, else the vendors' docs.
 *
 * @module dsh-custom-models/dialects
 */
import { asNumber, isRecord, safeJson } from "./errors.js";

/** Reasoning level names, in order (the harness shows these). */
export const EFFORT_ORDER = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const EFFORT_NAMES = Object.freeze({ off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" });

/**
 * The reasoning efforts one model offers (catalog `reasoning`: `levels` in
 * order, `off` when thinking can be switched off).
 */
export function effortsOf(model) {
  const reasoning = model?.reasoning;
  if (!isRecord(reasoning)) return [];
  const levels = Array.isArray(reasoning.levels) ? reasoning.levels.filter((level) => EFFORT_ORDER.includes(level) && level !== "off") : [];
  return [...(reasoning.off ? ["off"] : []), ...EFFORT_ORDER.filter((level) => levels.includes(level))];
}

/** The default effort: "high" when offered, else the strongest below it, else the first. */
export function defaultEffortOf(model) {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return undefined;
  for (const level of ["high", "medium", "low", "minimal"]) if (efforts.includes(level)) return level;
  return efforts.find((effort) => effort !== "off") ?? efforts[0];
}

/** A requested effort, checked against what the model offers (unknown → the default). */
export function resolveEffort(model, requested, purpose) {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return undefined;
  // Titles and compaction need no deliberation where it can be switched off; else the lightest level.
  if (purpose === "session-title" || purpose === "compaction") return efforts.includes("off") ? "off" : efforts.find((level) => level !== "off");
  return efforts.includes(requested) ? requested : defaultEffortOf(model);
}

/** The vendor's own value for a level (the catalog maps some, e.g. OpenAI's "off" is "none"). */
export const providerLevel = (model, level) => (typeof model?.reasoning?.map?.[level] === "string" ? model.reasoning.map[level] : level);

/**
 * What a failure means for the key that got it:
 *  - `invalid-key`, `expired`: the key is dead → mark it, try the next key;
 *  - `no-balance`, `plan-quota`: the key (account) is out → mark it until it recovers, try the next key;
 *  - `forbidden`: this key may not use this → try the next key, leave the key's status;
 *  - `client-denied`: the site lets this key serve its official clients only (sub2api's "Claude Code only"
 *    groups, CRS's client restriction) → the key is fine but no request from here passes: mark it;
 *  - `rate-limit`: per organization or project → back off (DSH retries), next key only if the user allows;
 *  - `region`: the vendor refuses this network location → no key helps; say so;
 *  - `free-tier`: OpenCode's free models answer only inside the OpenCode app → no key helps; the model is withdrawn;
 *  - `paid-model`: Vercel's free tier does not serve this model → the model is withdrawn for now (credits lift it);
 *  - `model-denied`: this key (its group on a relay) may not use this model, or the relay has no channel for it → the model is withdrawn for now;
 *  - `moderation`, `bad-request`, `context`, `not-found`: the request itself → never switch keys;
 *  - `overloaded`, `server`, `transport`, `timeout`: transient → DSH retries.
 */
export const ROTATE_KINDS = Object.freeze(new Set(["invalid-key", "expired", "no-balance", "plan-quota", "forbidden", "client-denied"]));

/** The harness code each kind surfaces as. */
export const KIND_CODES = Object.freeze({
  "invalid-key": "INVALID_CREDENTIAL",
  expired: "INVALID_CREDENTIAL",
  forbidden: "INVALID_CREDENTIAL",
  "client-denied": "INVALID_CREDENTIAL",
  region: "INVALID_REQUEST",
  "free-tier": "INVALID_REQUEST",
  "paid-model": "INVALID_REQUEST",
  "model-denied": "INVALID_REQUEST",
  "no-balance": "QUOTA",
  "plan-quota": "QUOTA",
  "rate-limit": "RATE_LIMIT",
  overloaded: "SERVER",
  server: "SERVER",
  moderation: "INVALID_REQUEST",
  "bad-request": "INVALID_REQUEST",
  context: "CONTEXT_WINDOW_EXCEEDED",
  // The site's body-size limit (HTTP 413): the adapter asks DSH to drop old images, else to compact.
  "too-large": "CONTEXT_WINDOW_EXCEEDED",
  "not-found": "UNKNOWN_MODEL",
  transport: "TRANSPORT",
  timeout: "TIMEOUT",
});

/** A short Chinese label per kind (status chips, error text). */
export const KIND_LABELS = Object.freeze({
  "invalid-key": "Key 无效",
  expired: "无有效套餐或已过期",
  forbidden: "无访问权限",
  "client-denied": "该 Key 仅允许站点指定的客户端使用",
  region: "当前地区不受支持（需使用代理）",
  "free-tier": "OpenCode 免费模型仅限在 OpenCode 客户端中使用（平台限制）",
  "paid-model": "免费层级无法使用该模型（需购买额度）",
  "model-denied": "该 Key 无权使用此模型（站点未开通，或无可用渠道）",
  "no-balance": "余额不足",
  "plan-quota": "额度已用尽",
  "rate-limit": "已触发限流",
  overloaded: "服务繁忙",
  server: "服务端错误",
  moderation: "内容审核未通过",
  "bad-request": "请求参数错误",
  context: "超出上下文窗口",
  "too-large": "请求体超出站点上限",
  "not-found": "模型不存在",
  transport: "网络错误",
  timeout: "请求超时",
});

/** A relay's refusal (or read) about the token's own quota, not the account behind it (new-api's, a relay station's wording). */
const TOKEN_WORDING = /令牌额度|token quota|TokenStatusExhausted|API Key 已达到用量上限|billing_limit_exceeded|api key 额度已用完|api key quota exhausted|已达到总费用限制/i;
/** sub2api's used-up windows: a key's 5h / day / 7d spend limits, a subscription's, a user's platform quota. */
export const SUB2API_WINDOW = /api key (5小时|日|7天)限额已用完|api key (5h|1d|7d|daily|weekly) (rate )?limit exceeded|usage quota exhausted for this platform|(daily|weekly|monthly) usage limit exceeded/i;
/** A key's spend cap that refuses by up-front reservation (a relay station): small requests may still pass. */
const UPFRONT_LIMIT = /^billing_limit_exceeded$/i;
const UPFRONT_WORDING = /API Key 已达到用量上限/;
/** A key the site serves to its official clients only (sub2api, CRS). */
export const CLIENT_DENIED = /this group only allows Claude Code clients|Client not allowed|client is not authorized to use this API key/i;
/** CRS's windows: "已达到请求次数限制 (100 次)，将在 37 分钟后重置" (also Token use and spend). */
const CRS_WINDOW = /已达到\s*(?:请求次数|Token 使用|费用)限制[^，,]*[，,]\s*将在\s*(\d+)\s*分钟后重置/;
/** CRS's day and Claude-week spend caps ("已达到 Claude 模型周费用限制 ($100)"): they reset on the site's own schedule. */
const CRS_PERIOD = /已达到\s*(?:每日费用|Claude 模型周费用|Opus 周费用)限制/;
/** CRS's total spend cap on a key. */
const CRS_TOTAL = /已达到\s*总费用限制/;

/**
 * What ran out behind a "no balance": `key` (the token's own quota, which a token read sees) or
 * `account` (the money behind it). A mark stored before 0.1.2 has no scope: its message tells.
 */
export const noBalanceScope = (record) => record?.limitedScope ?? (TOKEN_WORDING.test(String(record?.statusMessage ?? "")) ? "key" : "account");

/** Retry-After (seconds or an HTTP date) in ms. */
export function retryAfterMs(headers) {
  const raw = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined;
}

/** The title of an HTML page (a relay's or Cloudflare's error page), or undefined for anything else. */
export function htmlTitle(text) {
  const raw = String(text ?? "");
  if (!/^\s*(<!doctype html|<html|<!--)/i.test(raw)) return undefined;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g, " ").trim();
  return title || "（无标题网页）";
}

/** A body read as a message: an HTML page by its title (Cloudflare's 502 page is 7 KB of markup), else as it came. */
function bodyMessage(text) {
  const title = htmlTitle(text);
  if (!title) return text;
  return `站点返回的是网页而非 API 响应：${title}${/cloudflare|cf-error-details|cf_styles/i.test(text) ? "（Cloudflare）" : ""}`;
}

/**
 * The parts of an error body every vendor's rules read: OpenAI
 * `{error:{type,code,message}}`, Anthropic `{type:"error",error:{type,message,details}}`,
 * Google `{error:{code,status,message,details:[{reason}…]}}`, OpenRouter
 * `{error:{code,message,metadata}}`, a Responses `error` event.
 */
export function errorParts(status, text) {
  const body = typeof text === "string" ? safeJson(text) : text;
  const error = isRecord(body?.error) ? body.error : isRecord(body) ? body : {};
  // xAI: `{ code: "<gRPC status text>", error: "<message>" }`.
  // Cloudflare: `{ success: false, errors: [{ code, message }] }`.
  const listed = Array.isArray(body?.errors) && isRecord(body.errors[0]) ? body.errors[0] : {};
  const message = String(error.message ?? body?.message ?? listed.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? (typeof text === "string" && !isRecord(body) ? bodyMessage(text) : "") ?? "");
  const details = Array.isArray(error.details) ? error.details : [];
  const reason = String(details.find((item) => isRecord(item) && item.reason)?.reason ?? "");
  const code = String(error.code ?? body?.code ?? error.details?.error_code ?? listed.code ?? "");
  const type = String(error.type ?? error.status ?? "");
  const retry = details.find((item) => isRecord(item) && /RetryInfo/.test(String(item["@type"])))?.retryDelay;
  const quotaIds = details.flatMap((item) => (Array.isArray(item?.violations) ? item.violations.map((violation) => String(violation?.quotaId ?? "")) : []));
  return {
    status,
    code,
    type,
    reason,
    message,
    limitSource: String(error.metadata?.limit_source ?? ""),
    errorCode: String(error.details?.error_code ?? ""),
    quotaIds,
    retryDelayMs: typeof retry === "string" && /^\d+(\.\d+)?s$/.test(retry) ? Math.round(Number.parseFloat(retry) * 1000) : undefined,
  };
}

const has = (pattern, ...values) => values.some((value) => pattern.test(String(value ?? "")));

/** "You will regain access on 2026-09-01 at 00:00 UTC." → ms. */
function regainAt(message) {
  const match = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}))? ?UTC/i.exec(message);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2] ?? "00:00"}:00Z`);
  return Number.isFinite(at) ? at : undefined;
}

/** A reset time a refusal states as an ISO timestamp ("resets at 2026-11-12T03:00:00Z"), in ms; undefined otherwise. */
function stampIn(message) {
  const match = /(?:reset|resets|resetting|until|after|retry at)\D{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(String(message ?? ""));
  const at = match ? Date.parse(match[1]) : Number.NaN;
  return Number.isFinite(at) && at > Date.now() ? at : undefined;
}

/** The next midnight in US Pacific time (Google's daily quotas reset then). */
function nextPacificMidnight(now = Date.now()) {
  const pacific = new Date(new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = new Date(now).getTime() - pacific.getTime();
  const midnight = new Date(pacific);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() + offset;
}

/**
 * Classify one failed response.
 * @param {string} vendor - endpoint vendor.
 * @param {number} status - HTTP status (0 for transport; 200 for an error inside a stream).
 * @param {string | object} text - response body or error frame.
 * @param {object} [extra] - `{ plan, headers }`.
 * @returns `{ kind, code, message, vendorCode, retryAfterMs?, resetAt? }`.
 */
/**
 * Wordings vendors and relays use beyond the English ones (magpie's collection, 2026-11):
 * - the conversation too long: "内容太长了，请精简输入或开启新对话" (a relay at ~730K of a 1M model),
 *   z.ai's "Prompt 超长", iFlytek's "…字数太多，需要精简输入", "输入长度超过限制". Not a field's length
 *   ("超出最大长度"), a daily allowance ("token数量超过上限"), an output ("输出过长");
 * - its pace: "请求过于频繁", "频率过高", "限流", "并发数过高", "请稍后重试";
 * - a provider busy for now, even under a 400: "Concurrency limit exceeded for account, please retry later".
 * Money and quota wordings are read before these.
 */
const CJK_TOO_LONG = /内容太长|Prompt ?超长|(输入|上下文|内容|提示词?)(长度)?(超长|超过(限制|上限|最大))|字数太多|请精简输入/i;
const PACE_WORDS = /请求(过于|太)?频繁|过于频繁|频率过高|访问频率|速率(限制|超限|过高)|限流|并发(数|请求)?(过高|超限|超过|上限|限制)|稍后(再试|重试)/;
const BUSY_WORDS = /concurrency limit|too many (pending|concurrent|in-?flight) requests|retry later|服务繁忙|系统繁忙/i;
/** Money or quota named beside pace words ("用户额度不足，请稍后重试"): never a pace refusal. */
const MONEY_WORDS = /余额|欠费|额度|充值|quota|credit|balance|billing/i;
const paced = (message) => PACE_WORDS.test(message) && !MONEY_WORDS.test(message);
const busy = (message) => BUSY_WORDS.test(message) && !MONEY_WORDS.test(message);

/**
 * A refusal of reasoning this request replayed — an Anthropic thinking signature, OpenAI / xAI sealed
 * reasoning, a Gemini thought signature — made by another account or conversation (a key switched by
 * hand, a relay's other upstream account). magpie's collection, 2026-11: "Invalid signature in thinking
 * block. The block is bound to a different conversation", "invalid_encrypted_content", Azure's "invalid
 * encrypted summary", xAI's "Could not decode the compaction blob". The request is sent again without it.
 */
export const REPLAY_REFUSED = /invalid `?signature`? in `?thinking`? block|bound to a different conversation|not created in this conversation|invalid data in `?redacted_thinking`? block|invalid_encrypted_content|invalid[ _]encrypted[ _](summary|content)|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content|could not (decode|decrypt).{0,20}compaction[ _]blob|thought[ _]signature.{0,40}(invalid|not valid)|invalid.{0,20}thought[ _]signature|item with id '?rs_[\w-]+'? not found/i;

/**
 * A model asking for an earlier turn's reasoning back: DeepSeek's "The `reasoning_content` in the thinking mode
 * must be passed back to the API" (its Messages API: `content[].thinking`; Kimi's without the backticks), a
 * relay's "Missing required parameter: 'messages[1].reasoning_content'". magpie's collection, 2026-11.
 */
export const REASONING_BACK = /`?(?:content\[\]\.thinking|reasoning_content)`? in the thinking mode must be passed back|\breasoning_content\b[^"]{0,40}\b(?:is (?:missing|required)|must be (?:passed|provided|included))|\b(?:missing|required)\b[^"]{0,80}\breasoning_content\b/i;

/**
 * The output field a site's refusal names, or null: OpenAI's "'max_tokens' is not supported with this model.
 * Use 'max_completion_tokens' instead"; a backend without the newer one ("Unrecognized request argument
 * supplied: max_completion_tokens", "max_completion_tokens is not supported").
 */
export function outputFieldOf(text) {
  const words = String(text ?? "");
  if (/use '?max_completion_tokens'? instead|'?max_tokens'? is not supported/i.test(words)) return "max_completion_tokens";
  if (/use '?max_tokens'? instead|'?max_completion_tokens'? is not supported|unrecognized request argument supplied:? '?max_completion_tokens|unknown (parameter|field|argument)\W{0,4}'?max_completion_tokens|max_completion_tokens'?\W{0,4}(is )?(not (supported|permitted|allowed)|unrecognized|unknown)/i.test(words)) return "max_tokens";
  return null;
}

/**
 * A model turning away the images a request carried (magpie's collection, 2026-11): DeepSeek's "unknown variant
 * `image_url`, expected `text`", OpenAI's "image_url is only supported by certain models", OpenRouter's "No
 * endpoints found that support image input", vLLM's "is not a multimodal model", "Model only support text
 * input", and the plain "does not support image input" / "不支持图片" of the rest.
 */
export const IMAGE_REFUSED = /unknown variant [`'"\\]*(?:image_url|input_image|image)\b|image_url is only supported by certain models|no endpoints found that support image|not a multi-?modal model|only supports? text( input)?\b|text[- ]only model|(?:does not|doesn't|do not|don't|cannot|can't|unable to) (?:support|accept|process|handle|take|read) (?:the )?(?:image|images|vision|multi-?modal)|\b(?:image|images|vision|multi-?modal|image_url|input_image)(?: (?:input|inputs|content|parts?))? (?:is |are )?(?:not supported|unsupported|not enabled|not allowed)|不支持(?:图片|图像|多模态|视觉|识图)/i;

/**
 * A model the site does not serve this key, said under a 401 or 403 (a relay or plugin's "model … not
 * supported", ModelScope's "has no provider supported"): the model, not the key — unless the words speak of
 * the sign-in ("model x: invalid token" is the token). magpie's words, 2026-11.
 */
const MODEL_UNSERVED = /model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(no such|unknown|invalid|unsupported) model|model_not_found|has no provider supported|deployment[ _]?not[ _]?found|模型.{0,12}(不存在|不支持|无权|未开通)/i;
const SIGN_IN_WORDS = /token|api.?key|credential|sign.?in|log.?in|expired|session|令牌|密钥|登录|过期/i;

/** A body over the site's byte cap in words (Command Code's "Request body is 40.1 MB, over the 32 MB limit for one request"). */
const BODY_CAP = /request[ _](body|entity|payload)( size)?( is| was)? (too large|too big|over|larger than|exceeds?|exceeded)|request body is [\d.]+ ?[kmg]i?b|(body|request|payload) (size )?(exceeds?|exceeded|is over|is larger than) (the )?(max|limit|\d)|limit for one request|maximum allowed number of bytes|(max(imum)?|request) (request |body )*size (limit )?(exceeded|of)/i;

/**
 * The output a credit balance still covers, when the refusal says so: OpenRouter's 402 "This request requires
 * more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1234" — the
 * request's size, not a balance at 0. Undefined otherwise.
 */
export function affordableOutput(text) {
  const match = /fewer max_tokens[\s\S]{0,120}?can only afford (\d+)|can only afford (\d+)/i.exec(String(text ?? ""));
  return match ? Number(match[1] ?? match[2]) : undefined;
}
/** The smallest output worth asking again with (DSH's own floor for a reply): below it the balance is spent. */
export const AFFORD_MIN = 4096;

export function classifyFailure(vendor, status, text, { plan, headers } = {}) {
  const parts = errorParts(status, text);
  const { code, type, reason, message, limitSource, errorCode } = parts;
  let resetAt;
  // What a platform's own code says more precisely than the kind's label (shown in the error's place of it).
  let label;
  const kind = (() => {
    // 0. Where the request comes from, not the key.
    if (has(/unsupported_country_region_territory|country, region, or territory not supported|not available in your (country|region)|User location is not supported/i, code, message)) return "region";
    if (vendor === "anthropic" && status === 403 && /request not allowed/i.test(message)) return "region";
    // 1. The request itself was refused: never a key problem.
    if (vendor === "openrouter" && status === 403 && /moderation|flagged/i.test(message)) return "moderation";
    if (has(/content_policy_violation|content_filter|invalid_prompt|responsible ai|safety system|flagged|PROHIBITED_CONTENT|SAFETY/i, code, type, reason) && status !== 401) return "moderation";
    // 1b. Relays built on new-api / one-api (its i18n strings, 2026-10): the token, the user's quota, the
    // group's channels. Their wording is the same on every such site, so it is read on every site.
    if (/用户额度不足|Insufficient user quota|insufficient_user_quota|预扣费额度失败|Not enough quota to pre-consume|pre_consume_token_quota_failed|订阅额度不足|Subscription quota is insufficient|令牌额度已用尽|额度已用尽|token quota (is )?(exhausted|not enough)/i.test(`${code} ${type} ${message}`)) return "no-balance";
    if (/该令牌状态不可用|token status is unavailable|令牌已过期|token (has )?expired|token_expired/i.test(`${code} ${message}`)) return "expired";
    if (/无效的令牌|^Invalid token|未提供令牌|Token not provided|token not found|用户已被封禁|user (is |has been )?banned/i.test(message)) return "invalid-key";
    if (/无权访问.{0,40}分组|No permission to access (this )?group|分组 \S+ 已被弃用|Group \S+ has been deprecated|IP 不在令牌允许|not on this token's allowlist/i.test(message)) return "forbidden";
    if (/该令牌无权访问(模型|任何模型)|has no access to (model|any models)|无可用渠道|No available channel|可用渠道不存在|model_not_found.{0,30}channel/i.test(message)) return "model-denied";
    if (/获取.{0,40}可用渠道失败|Failed to get available channel|负载已饱和|上游负载|upstream (is )?(saturated|overloaded)/i.test(message)) return "overloaded";
    if (/余额不足|欠费|账户余额|额度不足/.test(message)) return "no-balance";
    // 1c. sub2api (its gateway's billing errors, source 2026-11): a key's own 5-hour / day / 7-day spend
    // windows, a subscription's day / week / month limits and a user's platform quota are used-up windows
    // (429 `rate_limit_exceeded`, or 403 `billing_error`), never a pace to wait out; the key's total quota
    // is its money; an expired key or subscription needs the user.
    if (SUB2API_WINDOW.test(message)) {
      const wait = retryAfterMs(headers);
      if (wait) resetAt = Date.now() + wait;
      return "plan-quota";
    }
    if (/api key 额度已用完|api key quota exhausted/i.test(message)) return "no-balance";
    if (/api key 已过期|api key has expired|subscription is invalid or expired|subscription is suspended/i.test(message)) return "expired";
    // Some relay stations cap a client key's spend: 429 `billing_limit_exceeded` (type rate_limit_error)
    // "客户端 API Key 已达到用量上限" — also while some is left, when it cannot cover this request's
    // up-front reservation (its body and max_tokens at official prices). Live 2026-11-01.
    if (UPFRONT_LIMIT.test(code) || UPFRONT_WORDING.test(message)) return "no-balance";
    // 1d. A key for the site's official clients only (source 2026-11): sub2api's "Claude Code only" group without a
    // fallback group ("this group only allows Claude Code clients"), CRS's client restriction (403 "Client not
    // allowed" / "Your client is not authorized to use this API key"). The key is fine; no request from here passes.
    if (CLIENT_DENIED.test(`${code} ${message}`)) return "client-denied";
    // CRS's own limits on a key (its auth middleware, source 2026-11): a request, token or spend window says when
    // it resets ("…，将在 N 分钟后重置"); a day's or the Claude week's spend waits for the site's reset; the key's
    // total spend is its money.
    const crs = CRS_WINDOW.exec(message);
    if (crs) {
      resetAt = Date.now() + Number(crs[1]) * 60_000;
      return "plan-quota";
    }
    if (CRS_PERIOD.test(message)) return "plan-quota";
    if (CRS_TOTAL.test(message)) return "no-balance";
    // 2. The key is not accepted (or its project is gone) — unless all the refusal speaks of is the model.
    if ((status === 401 || status === 403) && MODEL_UNSERVED.test(message) && !SIGN_IN_WORDS.test(message)) return "model-denied";
    if (status === 401) return "invalid-key";
    if (has(/^(invalid_api_key|incorrect_api_key|authentication_error|invalid_authentication|unauthenticated)$/i, code, type)) return "invalid-key";
    if (has(/^(API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|ACCOUNT_STATE_INVALID|CONSUMER_SUSPENDED|API_KEY_EXPIRED)$/, reason)) return "invalid-key";
    if (has(/api key (not valid|expired)|invalid (api )?key|incorrect api key|invalid credential|has been suspended|organization has been disabled|key (is )?(blocked|disabled|revoked)/i, message)) return "invalid-key";
    // A suspended account or workspace (one suspended for its balance is read as such below).
    if ((has(/account_suspended|account_disabled/i, code, type) || has(/(account|workspace|organization).{0,40}(is|has been) suspended/i, message)) && !/balance|余额|欠费|arrear|recharge|quota|credit/i.test(message)) return "invalid-key";
    // Google words its rate limits like OpenAI's "no credits" ("You exceeded your current quota,
    // please check your plan and billing details"): read its quota ids instead. A daily quota
    // waits for midnight Pacific; a free-tier limit of 0 means the model needs billing.
    if (vendor === "gemini" && (status === 429 || type === "RESOURCE_EXHAUSTED")) {
      if (/limit: 0\b/.test(message)) return "no-balance";
      if (parts.quotaIds.some((id) => /PerDay/i.test(id))) {
        resetAt = nextPacificMidnight();
        return "plan-quota";
      }
      return "rate-limit";
    }
    // OpenCode Zen / Go name their account caps by type (as OpenCode's own client reads them).
    // Its gateway also keeps an upstream code as a "[code]" label: "Upstream request failed: [code] …".
    if (vendor === "opencode") {
      const label = /^[^:\n]+: \[([A-Za-z0-9_.-]+)\]/.exec(message)?.[1] ?? "";
      // Its free models answer only inside the OpenCode app (403 `FreeTierError`, with or without a key): no key helps.
      if (has(/^FreeTierError$/i, code, type, label) || has(/free tier can only be used from within OpenCode/i, message)) return "free-tier";
      if (has(/active OpenCode Go subscription is required|subscription is required/i, message)) return "expired";
      // A workspace setting, per model: "This Go model requires Global regions. Select Global in your workspace's Privacy settings".
      if (has(/requires Global regions|Select Global in your workspace/i, message)) return "forbidden";
      if (has(/^(GoUsageLimitError|FreeUsageLimitError|CreditLimitExceeded)$/i, code, type, label)) return "plan-quota";
      if (has(/^billing_error$/i, code, type, label)) return "no-balance";
      if (has(/^usage_not_included$/i, code, type, label)) return "forbidden";
    }
    // Cloudflare (live 2026-10-16): 1000 a bad token, 10000 a token without Workers AI, 7003 a wrong
    // account ("Could not route … object identifier is invalid") — and a model gone (5007, 5028, 7010).
    if (vendor === "cloudflare") {
      if (code === "1000" || code === "10000" || /Could not route|object identifier is invalid/i.test(message)) return "invalid-key";
      if (/daily free allocation|free allocation of [\d,]+ neurons|used up your daily/i.test(message)) {
        const now = new Date();
        resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        return "plan-quota";
      }
      if (/Workers Paid|paid plan/i.test(message)) return "forbidden";
      if (["5007", "5028", "7010"].includes(code) || /has been deprecated|No such model|Model not found/i.test(message)) return "not-found";
    }
    // Vercel AI Gateway (live 2026-10-17): its free tier serves a subset of models (403
    // `RestrictedModelsError` "Free tier users do not have access to this model", before inference;
    // an early-access model words it "requires an active Pro plan with purchased AI Gateway credits");
    // a budget caps a team, project, key or user (402 `quota_for_entity_exceeded`); free credits need a
    // payment method on file (403 `customer_verification_required`). Other 402s: no credits left.
    if (vendor === "vercel") {
      if (/free tier users do not have access|RestrictedModelsError|requires an active Pro plan|with purchased AI Gateway credits/i.test(message)) return "paid-model";
      if (has(/^quota_for_entity_exceeded$/i, code, type)) return "plan-quota";
      if (has(/^customer_verification_required$/i, code, type)) return "forbidden";
    }
    // OpenRouter's free models: so many a day per account, back at midnight UTC.
    if (vendor === "openrouter" && status === 429 && /free-models-per-day/i.test(message)) {
      const now = new Date();
      resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      return "plan-quota";
    }
    // 3. The account has no money.
    if (vendor === "openrouter" && status === 402) {
      if (limitSource === "openrouter_in_flight_budget") return "rate-limit";
      return limitSource === "openrouter_key_limit" ? "plan-quota" : "no-balance";
    }
    if (has(/^(insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|billing_not_active)$/i, code, type)) return "no-balance";
    // xAI: "Your newly created team doesn't have any credits yet. You can purchase credits on …".
    if (has(/credit balance is too low|no credits remaining|insufficient (account )?(balance|credits|funds)|used all available credits|out of credits|exceeded your current quota|add credits|billing (details|hard limit)|payment required|(does not|doesn't|do not|don't) have any credits|purchase credits|exhausted (its|your|their) credits/i, message)) return "no-balance";
    if (status === 402) return "no-balance";
    // 4. A spend cap or plan window is used up (often with a date).
    if (errorCode === "enforced_spend_limit_reached" || has(/reached your (specified )?(workspace )?API usage limits|monthly (spending|spend) limit|spending limit/i, message)) {
      resetAt = regainAt(message);
      return "plan-quota";
    }
    if (vendor === "opencode" && plan && status === 429 && /limit|quota|subscription/i.test(message)) return "plan-quota";
    if (has(/subscription (has )?(expired|is not active|inactive)|no active (subscription|plan)|does not have (an active )?subscription/i, message)) return "expired";
    // 5. Too fast right now.
    if (has(/rate_limit|rate limit|too many requests|RESOURCE_EXHAUSTED|requests per (minute|day)|tokens per minute/i, code, type, message) || paced(message)) return "rate-limit";
    if (status === 429) return "rate-limit";
    // 6. The request does not fit: the site's body-size limit (a relay behind a proxy answers 413
    //    "the request body is too large", live 2026-10-27), then the model's context window.
    if (status === 413 || has(/request body is too large|request body too large|payload too large|request entity too large|request_too_large|body size limit|failed to buffer the request body|请求体(过大|太大)/i, code, type, message) || (status !== 429 && BODY_CAP.test(message))) return "too-large";
    if (has(/context_length_exceeded|context.?(length|window)|maximum context|prompt is too long|too many tokens|exceeds the maximum number of tokens|input token count/i, code, message) || CJK_TOO_LONG.test(message)) return "context";
    if (status === 404 || has(/model_not_found|not_found_error|does not exist|no such model|unknown model|NOT_FOUND|is not found for API version/i, code, type, message)) return "not-found";
    if (status === 403) return "forbidden";
    if (status === 529 || status === 503 || has(/overloaded|capacity|UNAVAILABLE|temporarily unavailable/i, type, message) || busy(message)) return "overloaded";
    if (status === 400 || status === 422) return "bad-request";
    if (status === 0) return "transport";
    return "server";
  })();
  const after = retryAfterMs(headers) ?? parts.retryDelayMs;
  // A spend cap judged against this request's reservation: a smaller request (a ✓ probe) may still pass.
  const upfront = kind === "no-balance" && (UPFRONT_LIMIT.test(code) || UPFRONT_WORDING.test(message));
  // A key refused because the site suspended its account or workspace: no top-up or retry brings it back.
  const suspended = kind === "invalid-key" && (has(/account_suspended|account_disabled/i, code, type) || /(account|workspace|organization).{0,40}(is|has been) (suspended|disabled)|has been suspended/i.test(message));
  return {
    kind,
    code: KIND_CODES[kind],
    message: message || `HTTP ${status}`,
    vendorCode: code || reason || null,
    ...(label ? { label } : {}),
    ...(suspended ? { suspended: true } : {}),
    ...(upfront ? { upfront: true } : {}),
    ...(after ? { retryAfterMs: after } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}
