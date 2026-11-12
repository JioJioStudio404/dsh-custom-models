/**
 * "获取可用模型": what a site — or a draft of one in the add dialog — offers,
 * and what kind of site it is. Every read here is free.
 *
 * - The model list: `GET <address>/models` (Bearer), or Anthropic's
 *   `GET /v1/models` (x-api-key) for a site on Anthropic Messages, falling
 *   back to the Bearer listing. Whatever a
 *   list tells is read (Hyper: context, output, vision, effort levels, prices
 *   per million; OpenRouter and Vercel: their catalogs; new-api: the endpoint
 *   types, which tell the chat models from image / video / speech ones), and
 *   the reference fills in the rest by id.
 * - The platform, from what answers: new-api / one-api publish `/api/status`
 *   (site name, quota unit) and `/api/pricing` (each model's ratios, so its
 *   price in the site's own quota); Hyper and Vercel answer `/v1/credits` for
 *   a key (Hyper with a number of Hypercredits, Vercel with USD strings);
 *   sub2api answers `/v1/usage` for a key (its `mode` and `isValid`);
 *   CRS (claude-relay-service) answers `POST /apiStats/api/user-stats` for a key (its `limits` and `usage`), asked
 *   only when nothing else told the platform;
 *   OpenRouter by its host. A model list that answers a wrong key too
 *   (Hyper's) cannot prove a key: that is noted, and validity is read
 *   elsewhere.
 *
 * Shapes checked live on 2026-10-18 (Charm Hyper, a new-api relay).
 *
 * @module dsh-custom-models/discovery
 */
import { classifyFailure } from "./dialects.js";
import { baseUrlProblem, normalizeBaseUrl } from "./endpoints.js";
import { asNumber, asString, isRecord, redact } from "./errors.js";
import { isSub2apiUsage } from "./probe.js";
import { isCrsStats } from "./relay/crs.js";
import { plazaGroupOf, plazaModelPrice, readPlaza, scalePrice } from "./relay/sub2api.js";
import { sub2apiBilling } from "./probe.js";
import { modelKey, referenceOf } from "./reference.js";
import { isSafeKey } from "./safe.js";
import { requestJson } from "./wire.js";

/** Ids in a model list that are no chat models. */
const NOT_CHAT = /embed|whisper|tts|speech|dall-e|gpt-image|image-|-image|imagen|seedream|seedance|hailuo|video|sora|(^|[/-])veo|(^|[/-])kling|(^|[/-])flux|audio|realtime|transcribe|moderation|rerank|lyria|midjourney|suno|:batch|-batch$/i;
/** new-api endpoint types a chat request can use. */
const CHAT_TYPES = new Set(["openai", "anthropic", "gemini", "openai-response", "openai-responses"]);
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** A token limit as a list states it: a whole number from 1,024 to 10 million, else undefined. */
const tokenCount = (value) => {
  const number = asNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 1_024 && number <= 10_000_000 ? number : undefined;
};

/** USD per million tokens from a per-token string (OpenRouter, Vercel). */
const perMillionOfToken = (value) => {
  const number = asNumber(value);
  return number === undefined ? undefined : Math.round(number * 1e6 * 1e6) / 1e6;
};
const round = (value) => (value === undefined ? undefined : Math.round(value * 1e6) / 1e6);

/** Reasoning levels from a list of effort names (`none` means it can be switched off). */
function reasoningOfLevels(values, { toggle = false } = {}) {
  const names = values.map((value) => String(isRecord(value) ? value.value : value).toLowerCase());
  const levels = EFFORTS.filter((level) => names.includes(level));
  const off = toggle || names.includes("none");
  if (!levels.length && !off) return null;
  return { levels: levels.length ? levels : ["high"], off, ...(names.includes("none") && !toggle ? { map: { off: "none" } } : {}) };
}

/**
 * One model of a list, as far as the list describes it; null for a model
 * that is no chat model (by its type, its endpoint types, or its id).
 */
export function parseListItem(item, { pricing } = {}) {
  if (!isRecord(item)) return null;
  const id = asString(item.id) ?? asString(item.name)?.replace(/^models\//, "");
  // `__proto__` and its like name no model (and would name no entry in the plugin's records: safe.js).
  if (!id || id.length > 200 || !isSafeKey(id.trim())) return null;
  if (asString(item.type) && !["language", "chat", "model", "text"].includes(item.type)) return null;
  const types = Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types.map(String) : null;
  if (types && types.length && !types.some((type) => CHAT_TYPES.has(type))) return null;
  if (Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes("generateContent")) return null;
  if (NOT_CHAT.test(id)) return null;
  const out = { id };
  const name = asString(item.display_name) ?? asString(item.displayName) ?? (asString(item.name) && item.name !== id && !item.name.startsWith("models/") ? item.name : undefined);
  if (name) out.name = name.replace(/^[^:]{2,30}:\s+/, "");
  // A relay station's catalog states its limits under `metadata`: `context_limit` is the window (a
  // 437K-token request was served where `context_budget` said 328K), `output_budget` the output, and
  // `context_budget` the size its own client compacts at — kept as a suggestion only.
  const meta = isRecord(item.metadata) ? item.metadata : {};
  const context = asNumber(item.context_window) ?? asNumber(item.context_length) ?? asNumber(item.max_context_length) ?? asNumber(item.inputTokenLimit) ?? asNumber(item.limit?.context) ?? asNumber(item.context)
    ?? tokenCount(meta.context_limit) ?? tokenCount(meta.context_window_tokens) ?? tokenCount(meta.contextWindowTokens) ?? tokenCount(item.contextWindowTokens) ?? tokenCount(item.context_window_tokens) ?? tokenCount(item.contextLength);
  if (context) out.context = context;
  const output = asNumber(item.max_output_tokens) ?? asNumber(item.top_provider?.max_completion_tokens) ?? asNumber(item.outputTokenLimit) ?? asNumber(item.limit?.output) ?? asNumber(item.max_tokens)
    ?? tokenCount(meta.output_budget) ?? tokenCount(meta.max_output_tokens);
  if (output) out.output = output;
  const suggested = tokenCount(meta.context_budget);
  if (suggested && context && suggested < context) out.contextSuggested = suggested;
  const input = Array.isArray(item.architecture?.input_modalities) ? item.architecture.input_modalities : Array.isArray(item.modalities?.input) ? item.modalities.input : null;
  if (item.capabilities?.vision === true || input?.includes("image") || (Array.isArray(item.tags) && item.tags.includes("vision"))) out.image = true;
  else if (item.capabilities?.vision === false || input) out.image = false;
  // Reasoning: Hyper's effort levels, Vercel's options, OpenRouter's parameter list.
  if (isRecord(item.reasoning) && Array.isArray(item.reasoning.effort_levels)) out.reasoning = reasoningOfLevels(item.reasoning.effort_levels);
  else if (Array.isArray(item.reasoning_options)) {
    const effort = item.reasoning_options.find((option) => option?.type === "effort" && Array.isArray(option.values));
    out.reasoning = reasoningOfLevels(effort?.values ?? ["low", "medium", "high"], { toggle: item.reasoning_options.some((option) => option?.type === "toggle") });
  } else if (Array.isArray(item.supported_parameters) && item.supported_parameters.includes("reasoning")) out.reasoning = { levels: ["low", "medium", "high"], off: true };
  if (out.reasoning === null) delete out.reasoning;
  // Prices: Hyper per million (numbers), OpenRouter (prompt / completion) and Vercel (input / output) per token (strings).
  const price = isRecord(item.pricing) ? item.pricing : null;
  if (price) {
    const perToken = typeof price.input === "string" || typeof price.prompt === "string" || price.completion !== undefined;
    const read = perToken ? perMillionOfToken : (value) => round(asNumber(value));
    const inputPrice = read(price.input ?? price.prompt);
    const outputPrice = read(price.output ?? price.completion);
    if (inputPrice !== undefined && outputPrice !== undefined && inputPrice >= 0 && outputPrice >= 0) {
      out.cost = { input: inputPrice, output: outputPrice, cacheRead: read(price.cache_hit ?? price.input_cache_read) ?? 0, cacheWrite: read(price.cache_create ?? price.input_cache_write) ?? 0 };
    }
  }
  // new-api: the price in the site's own quota, from its ratios (1 = $2 per million tokens); sub2api: its plaza's.
  const ratio = pricing?.get(id);
  if (!out.cost && ratio) {
    const { endpoints: _endpoints, platform: _platform, ...cost } = ratio;
    out.cost = cost;
  }
  // The protocols the relay serves it in (the list's own types, else its pricing's).
  const served = types ?? ratio?.endpoints ?? (ratio?.platform === "anthropic" ? ["anthropic"] : ratio?.platform === "openai" ? ["openai-response"] : null);
  const protocol = protocolOfTypes(id, served);
  if (protocol) out.protocol = protocol;
  const chatTypes = (served ?? []).filter((type) => CHAT_TYPES.has(type));
  if (chatTypes.length) out.endpoints = [...new Set(chatTypes.map((type) => (type === "openai-responses" ? "openai-response" : type)))];
  return out;
}

/**
 * A list's chat models, from any of the shapes above. A list that names the
 * reasoning levels of some models (Hyper) says, by its silence, that the
 * others take none: those get `reasoning: false` (no reasoning field is sent).
 */
export function parseModelList(body, options) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  const seen = new Set();
  const models = list.map((item) => parseListItem(item, options)).filter((item) => item && !seen.has(item.id) && seen.add(item.id));
  if (models.some((model) => model.reasoning)) for (const model of models) model.reasoning ??= false;
  return models;
}

/**
 * new-api's `/api/pricing`: each model's price per million tokens in the site's quota unit (1 = $2 per million at
 * ratio 1), at the group's ratio — the key's own group when known (its log tells, relay/), else `default`:
 * - `quota_type` 1: a fixed price per call (`model_price`, in quota dollars) — `perRequest`;
 * - `create_cache_ratio`: what writing the cache costs; `cache_ratio`: reading it;
 * - `billing_expr`: the site bills by an expression of its own (tiers) — not run here (`expr`; the site's log
 *   tells what each request was billed);
 * - `supported_endpoint_types`: the protocols the site serves the model in.
 */
export function newApiPricing(body, group = "default") {
  const map = new Map();
  const list = Array.isArray(body?.data) ? body.data : [];
  const known = isRecord(body?.group_ratio) && asNumber(body.group_ratio[group]) !== undefined;
  const name = known ? group : "default";
  const groupRatio = asNumber(body?.group_ratio?.[name]) ?? 1;
  for (const item of list) {
    if (!isRecord(item) || !asString(item.model_name)) continue;
    const endpoints = Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types.map(String).slice(0, 12) : null;
    const extra = { unit: "quota", group: name, ...(asString(item.billing_expr) ? { expr: true } : {}), ...(endpoints?.length ? { endpoints } : {}) };
    if (asNumber(item.quota_type) === 1) {
      const each = asNumber(item.model_price);
      if (each !== undefined && each >= 0) map.set(item.model_name, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, perRequest: round(each * groupRatio), ...extra });
      continue;
    }
    const ratio = asNumber(item.model_ratio);
    if (ratio === undefined) continue;
    const input = round(ratio * 2 * groupRatio);
    map.set(item.model_name, { input, output: round(input * (asNumber(item.completion_ratio) ?? 1)), cacheRead: round(input * (asNumber(item.cache_ratio) ?? 1)), cacheWrite: round(input * (asNumber(item.create_cache_ratio) ?? 0)), ...extra });
  }
  return map;
}

/**
 * The protocol a relay's endpoint types suggest for a model (new-api's `supported_endpoint_types`; sub2api's group
 * platform): the only one it is served in; Messages for a Claude model served in both; Responses for GPT-5 and later
 * (and o-series, Codex) served in both. None when the types leave the choice open.
 */
export function protocolOfTypes(id, types) {
  if (!Array.isArray(types) || types.length === 0) return undefined;
  const has = (type) => types.includes(type);
  const chat = has("openai");
  const messages = has("anthropic");
  const responses = has("openai-response") || has("openai-responses");
  if (messages && !chat && !responses) return "messages";
  if (responses && !chat && !messages) return "responses";
  if (messages && /claude/i.test(id)) return "messages";
  if (responses && /(^|\/)(gpt-([5-9]|\d{2})|o[1-9]\b|o[1-9]-|codex)/i.test(id)) return "responses";
  return undefined;
}

/**
 * sub2api's prices for a key: its plaza (public; off on some sites) for the group the key is in (found by the key's
 * group multiplier and the models it lists), each base price times the key's rate (its billing read). Null when the
 * plaza is off.
 */
async function sub2apiPrices({ origin, key, headers, fetchImpl, signal, listed }) {
  const ask = (url, withKey) => requestJson(url, withKey ? key : null, { headers, fetchImpl, signal, timeoutMs: 20_000 });
  const plaza = readPlaza(await ask(`${origin}/api/v1/model-plaza`, false));
  if (!plaza.groups) return null;
  const billing = key ? await ask(`${origin}/v1/sub2api/billing`, true) : null;
  const rates = billing?.ok ? sub2apiBilling(billing.body) : null;
  const ids = (Array.isArray(listed?.data) ? listed.data : []).map((item) => (isRecord(item) ? asString(item.id) : null)).filter(Boolean);
  const group = plazaGroupOf(plaza, { modelIds: ids, groupRate: rates?.group ?? null });
  const rate = rates?.resolved ?? group?.rate ?? 1;
  const map = new Map();
  for (const id of ids) {
    const found = plazaModelPrice(plaza, id, { group });
    if (!found?.price) continue;
    const peak = rates?.peak ?? group?.peak ?? null;
    map.set(id, { ...scalePrice(found.price, rate), unit: "USD", rate, ...(found.group ? { group: found.group } : {}), ...(found.estimated ? { estimated: true } : {}), ...(peak ? { peak: { ...peak, zone: rates?.timezone ?? "UTC" } } : {}), ...(found.platform ? { platform: found.platform } : {}) });
  }
  return map;
}

/** What `/api/status` says of a new-api / one-api site (public), or null. */
export function newApiStatus(body) {
  const data = isRecord(body?.data) ? body.data : null;
  if (!data || (data.quota_per_unit === undefined && data.system_name === undefined)) return null;
  return {
    name: asString(data.system_name) ?? null,
    quotaPerUnit: asNumber(data.quota_per_unit) ?? 500000,
    display: asString(data.quota_display_type) ?? (data.display_in_currency === false ? "TOKENS" : "USD"),
    rate: asNumber(data.usd_exchange_rate) ?? null,
  };
}

/** The model-list request for a site on a protocol. */
function listRequests(baseUrl, protocol) {
  const bearer = { url: `${baseUrl}/models`, auth: "bearer" };
  if (protocol === "messages") return [{ url: `${baseUrl.replace(/\/v1$/i, "")}/v1/models?limit=1000`, auth: "both" }, bearer];
  return [bearer];
}

/**
 * Discover a site: its platform and its chat models, each described as far
 * as the site and the reference tell.
 * @param {object} draft - `{ baseUrl, protocol, key?, headers?, allowHttp? }` (`allowHttp`: the user confirmed a public plain-HTTP address).
 * @returns `{ ok, platform, platformInfo, modelsPublic, keyAccepted, models, error? }`.
 */
export async function discover({ baseUrl: raw, protocol = "chat", key, headers, allowHttp = false }, { fetchImpl = fetch, signal, group } = {}) {
  const problem = baseUrlProblem(raw, { allowHttp });
  if (problem) return { ok: false, error: problem };
  const baseUrl = normalizeBaseUrl(raw);
  const origin = new URL(baseUrl).origin;
  const host = new URL(baseUrl).hostname;
  const call = (url, options = {}) => requestJson(url, options.key === undefined ? key : options.key, { auth: options.auth ?? "bearer", headers, fetchImpl, signal, timeoutMs: 20_000 });
  const [status, credits, pricing, usage] = await Promise.all([
    call(`${origin}/api/status`, { key: null }),
    key ? call(`${origin}/v1/credits`) : Promise.resolve(null),
    call(`${origin}/api/pricing`, { key: null }),
    key ? call(`${origin}/v1/usage`) : Promise.resolve(null),
  ]);
  const sub2api = usage?.ok === true && isSub2apiUsage(usage.body);
  let platform = "generic";
  let platformInfo = null;
  const relay = status.ok ? newApiStatus(status.body) : null;
  if (/(^|\.)openrouter\.ai$/.test(host)) platform = "openrouter";
  else if (host === "ai-gateway.vercel.sh") platform = "vercel";
  else if (relay) {
    platform = "newapi";
    platformInfo = relay;
  } else if (sub2api) {
    platform = "sub2api";
  } else if (credits?.ok && isRecord(credits.body) && credits.body.balance !== undefined) {
    platform = typeof credits.body.balance === "string" || credits.body.total_used !== undefined ? "vercel" : "hyper";
  }
  // CRS: its statistics read takes the key in the body (as its own page sends it); asked when nothing else told.
  let crsAccepted = false;
  if (platform === "generic" && key) {
    const stats = await requestJson(`${origin}/apiStats/api/user-stats`, null, { method: "POST", body: { apiKey: key }, headers, fetchImpl, signal, timeoutMs: 20_000 });
    if (stats.ok && isCrsStats(stats.body)) {
      platform = "crs";
      crsAccepted = true;
    }
  }
  let prices = platform === "newapi" && pricing.ok ? newApiPricing(pricing.body, group ?? "default") : null;
  let listed;
  let lastError;
  for (const request of listRequests(baseUrl, protocol)) {
    const response = await call(request.url, { auth: request.auth });
    if (response.ok) {
      listed = response;
      break;
    }
    lastError = response;
  }
  if (!listed) {
    // The site's own words follow (a suspended workspace, a wrong key), so the dialog says what happened.
    const failure = lastError?.status ? classifyFailure(platform, lastError.status, lastError.text ?? "") : null;
    const said = failure && failure.message !== `HTTP ${lastError.status}` ? `：${redact(failure.message).slice(0, 300)}` : "";
    const message = failure?.suspended ? `站点已停用该账户（${lastError.status}）${said}`
      : lastError?.status === 401 || lastError?.status === 403 ? `Key 无效，或该站点不允许此 Key 查询模型列表（${lastError.status}）${said}`
        : lastError?.status ? `模型列表获取失败（HTTP ${lastError.status}）${said}` : `无法连接该地址：${redact(lastError?.text ?? "")}`;
    return { ok: false, platform, platformInfo, keyAccepted: lastError?.status === 401 || failure?.suspended ? false : null, error: message, status: lastError?.status ?? 0 };
  }
  // A list that answers without a key cannot prove one; a balance read can (Hyper refuses a wrong key there).
  const anonymous = key ? await call(`${baseUrl}/models`, { key: null }) : { ok: true };
  const modelsPublic = anonymous.ok === true;
  // sub2api: its plaza's prices at the key's own rate (its billing read), and the group's platform.
  if (platform === "sub2api") prices = await sub2apiPrices({ origin, key, headers, fetchImpl, signal, listed: listed.body });
  const models = parseModelList(listed.body, { pricing: prices }).map((model) => describe(model, { platform }));
  const keyAccepted = !key ? null : !modelsPublic || sub2api || crsAccepted ? true : credits?.ok ? true : credits?.status === 401 || credits?.status === 403 ? false : null;
  return { ok: true, platform, platformInfo, modelsPublic, keyAccepted, models };
}

/**
 * How a model is switched off on a platform whose list names no levels (no platform in this build needs one).
 */
const OFF_WIRE = Object.freeze({});

/** A model's reasoning with the platform's spelling of "off" added where the model can be switched off. */
function withOffWire(reasoning, platform) {
  const wire = OFF_WIRE[platform];
  if (!wire || !isRecord(reasoning) || reasoning.off !== true || isRecord(reasoning.map) && reasoning.map.off) return reasoning;
  return { ...reasoning, map: { ...(isRecord(reasoning.map) ? reasoning.map : {}), off: wire } };
}

/**
 * A listed model with the gaps filled from the reference: `source` says
 * where its description came from (`site` when the list described it).
 * @param {object} [options] - `platform`: the site's, for its spelling of "off".
 */
export function describe(listed, { platform } = {}) {
  const reference = referenceOf(listed.id);
  const described = listed.context !== undefined || listed.reasoning !== undefined || listed.cost !== undefined;
  const reasoning = listed.reasoning === false ? false : withOffWire(listed.reasoning ?? reference?.reasoning, platform);
  return {
    id: listed.id,
    name: listed.name ?? reference?.name ?? listed.id,
    ...(listed.protocol ? { protocol: listed.protocol } : {}),
    ...(listed.endpoints ? { endpoints: listed.endpoints } : {}),
    ...((listed.context ?? reference?.context) ? { context: listed.context ?? reference.context, contextFrom: listed.context ? "site" : "reference" } : {}),
    ...(listed.contextSuggested ? { contextSuggested: listed.contextSuggested } : {}),
    ...((listed.output ?? reference?.output) ? { output: listed.output ?? reference.output } : {}),
    image: listed.image ?? reference?.image === true,
    // The site's own word on reasoning (false: it takes none) beats the reference.
    ...(reasoning === false ? { reasoning: false } : reasoning ? { reasoning } : {}),
    ...(listed.cost ? { cost: listed.cost } : {}),
    ...(reference?.flags ? { flags: { ...reference.flags } } : {}),
    source: described ? "site" : reference ? "reference" : "manual",
    known: Boolean(reference),
    key: modelKey(listed.id),
  };
}
