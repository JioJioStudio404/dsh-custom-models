/**
 * Requests the way DeepSeek Harness's own custom gateway sends them.
 *
 * DSH's 自定义模型 (`@deepseek-ai/dsh-llm-pi-ai`) hands a custom route's
 * conversation to pi-ai, whose protocol implementations — OpenAI Chat
 * Completions, OpenAI Responses and Anthropic Messages, built on the vendors'
 * own SDKs — build the request, stream the answer and read it. This module
 * does the same with the same pi-ai release and the patch DSH applies to it
 * (`vendor/pi-ai.mjs`, built by `scripts/build-vendor.mjs`), so a site
 * answers this plugin as it answers DSH's own gateway: which field caps the
 * output, where the system prompt goes, how reasoning is asked for and sent
 * back are pi-ai's decisions, as they are DSH's. A model's description (its
 * limits, image input, reasoning levels and their spellings, the flags the
 * model dialog edits) maps onto pi-ai's model and compat fields the way DSH's
 * profile does.
 *
 * Deliberate differences on Responses ({@link typedResponsesInput}): input items
 * always name their type, which Charm Hyper requires, and function tools say
 * `strict: false` (OpenAI takes a missing one as strict).
 *
 * What stays this plugin's: the key (the site's active one), the site's
 * headers, and reading a refusal. The request goes out through the plugin's
 * own fetch, which keeps a failed response's status and body — so a key out
 * of money, an invalid one or a model the key may not use is recognized as
 * before ({@link SiteRefusal}) — and reads the stream as it passes, for the
 * cost a site reports in its final usage (Hyper, OpenRouter, xAI) and for
 * what came back when nothing usable did.
 *
 * Context conversion, the replay envelope and the event translation are
 * adapted from dsh-llm-pi-ai (MIT, Copyright (c) 2026 DeepSeek).
 *
 * @module dsh-custom-models/gateway
 */
import { anthropicMessagesApi, isContextOverflow, normalizeContext, openAICompletionsApi, openAIResponsesApi } from "./vendor/pi-ai.mjs";
import { htmlTitle, KIND_CODES, KIND_LABELS } from "./dialects.js";
import { messagesBaseOf } from "./endpoints.js";
import { newWire, scanFrame } from "./authn/observe.js";
import { asNumber, asString, cnError, CODES, isRecord, safeJson } from "./errors.js";
import { clean, imagesToOffload, loadImage } from "./request.js";
import { USER_AGENT } from "./wire.js";

/** Bytes as MB with one decimal ("3.2 MB"). */
export const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The site protocols, as pi-ai's (and DSH's custom gateway's) wire protocols. */
export const API_OF = Object.freeze({ chat: "openai-completions", responses: "openai-responses", messages: "anthropic-messages" });
const FACTORIES = { "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi, "anthropic-messages": anthropicMessagesApi };
const apis = new Map();
const apiFor = (api) => {
  if (!apis.has(api)) apis.set(api, FACTORIES[api]());
  return apis.get(api);
};

/** pi-ai's thinking levels, in escalation order. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** pi-ai prices a request from these; this plugin counts costs itself (models.js). */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** The replay envelope this plugin's answers carry (version 1 was the plugin's own protocols'). */
export const REPLAY_KIND = "custom-models";
export const REPLAY_VERSION = 2;
/** pi-ai's Chat Completions reasoning fields: a thinking block's "signature" there is one of these names. */
const PLAIN_REASONING_FIELDS = new Set(["reasoning", "reasoning_content", "reasoning_text"]);

/**
 * A site's refusal (a non-2xx answer), for the adapter to read: `{ status,
 * text, headers, images }` — `images`, the refused request's image sizes
 * (base64, oldest first), tells a body-size refusal what can go.
 */
export class SiteRefusal extends Error {
  constructor({ status, text, headers, images = [], bodyBytes }) {
    super(`HTTP ${status}`);
    this.name = "SiteRefusal";
    this.status = status;
    this.text = text;
    this.headers = headers;
    this.images = images;
    this.bodyBytes = bodyBytes;
  }
}

/**
 * pi-ai's level map for one model's reasoning (`{ levels, off, map }`): a
 * level it does not offer is `null`; one with its own spelling maps to it;
 * `xhigh` and `max` must be named to be offered (pi-ai's rule).
 */
export function thinkingLevelMap(reasoning) {
  const offered = new Set(Array.isArray(reasoning?.levels) ? reasoning.levels : []);
  const map = {};
  for (const level of LEVELS) {
    const wire = asString(reasoning?.map?.[level]);
    if (level === "off") {
      if (!reasoning?.off) map.off = null;
      else if (wire) map.off = wire;
    } else if (!offered.has(level)) map[level] = null;
    else if (wire) map[level] = wire;
    else if (level === "xhigh" || level === "max") map[level] = level;
  }
  return map;
}

/**
 * pi-ai compat switches from a model's flags; the rest is pi-ai's own
 * detection from the address, as for DSH's custom routes.
 */
export function compatOf(model, api) {
  const flags = isRecord(model?.flags) ? model.flags : {};
  const compat = {};
  if (api === "openai-completions") {
    if (["deepseek", "qwen", "openrouter"].includes(flags.thinkingFormat)) compat.thinkingFormat = flags.thinkingFormat;
    else if (flags.thinkingFormat === "effort") compat.thinkingFormat = "openai";
    if (flags.reasoningOnAssistant === true) compat.requiresReasoningContentOnAssistantMessages = true;
    if (flags.maxTokensField === "max_completion_tokens" || flags.maxTokensField === "max_tokens") compat.maxTokensField = flags.maxTokensField;
    // DeepSeek's chat API has no max_completion_tokens and ignores it (its default output then applies,
    // 8K without thinking); pi-ai names it so for any address but deepseek.com, such as a relay serving DeepSeek.
    else if (/deepseek/i.test(String(model?.id ?? ""))) compat.maxTokensField = "max_tokens";
  }
  if (api === "anthropic-messages" && flags.adaptive === true) compat.forceAdaptiveThinking = true;
  return Object.keys(compat).length ? compat : undefined;
}

/**
 * The pi-ai model one request uses (undefined: a protocol this plugin no
 * longer serves — Gemini went to dsh-intl-models). `provider` is the route the
 * request came on, as DSH's replay checks it.
 */
export function piModelOf(endpoint, model, route) {
  const api = API_OF[model.protocol ?? endpoint.protocol];
  if (!api) return undefined;
  // `none`: the model takes no reasoning field at all.
  const thinks = isRecord(model.reasoning) && model.flags?.thinkingFormat !== "none";
  const compat = compatOf(model, api);
  return {
    id: model.id,
    name: model.name ?? model.id,
    api,
    provider: route,
    baseUrl: api === "anthropic-messages" ? messagesBaseOf(endpoint, model) : endpoint.baseUrl,
    input: model.image ? ["text", "image"] : ["text"],
    cost: NO_COST,
    contextWindow: model.context,
    maxTokens: model.output,
    reasoning: thinks,
    ...(thinks ? { thinkingLevelMap: thinkingLevelMap(model.reasoning) } : {}),
    ...(compat ? { compat } : {}),
  };
}

// ----------------------------------------------------------------- replay

function parseArguments(raw) {
  if (isRecord(raw)) return raw;
  const parsed = safeJson(String(raw ?? "{}"));
  return isRecord(parsed) ? parsed : {};
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** The durable replay state of one finished answer: response facts plus one entry per block. */
export function replayStateOf(message, { site, requested, keyId }) {
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      api: message.api,
      site,
      // The key (its store id, never the secret): signatures and sealed reasoning belong to its account.
      ...(asString(keyId) ? { key: keyId } : {}),
      provider: message.provider,
      model: requested,
      realModel: message.model,
      ...(asString(message.responseModel) ? { responseModel: message.responseModel } : {}),
      ...(asString(message.responseId) ? { responseId: message.responseId } : {}),
      ...(asString(message.providerThinkingLevel) ? { providerThinkingLevel: message.providerThinkingLevel } : {}),
      stopReason: message.stopReason,
    },
    blocks: message.content.map((block) => {
      if (block.type === "thinking") return { type: "reasoning", ...(block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}), ...(block.redacted !== undefined ? { redacted: block.redacted } : {}) };
      if (block.type === "toolCall") return { type: "tool-call", ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}), ...(block.namespace !== undefined ? { namespace: block.namespace } : {}) };
      return { type: "text", ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}) };
    }),
  };
}

/**
 * Another provider's (or another model's) turn: its text, reasoning and tool calls, nothing passed off as
 * this model's. The reasoning is handed over as DSH's gateway hands it, and pi-ai 1.3.0 leaves it out
 * (thinking from another model); 1.1.0 sent it on as text, which the new model read as part of the reply.
 */
function foreignAssistant(message) {
  const content = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "text") content.push({ type: "text", text: String(block.text ?? "") });
    else if (block?.type === "reasoning") content.push({ type: "thinking", thinking: String(block.text ?? "") });
    else if (block?.type === "tool-call") content.push({ type: "toolCall", id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: parseArguments(block.arguments) });
  }
  return {
    role: "assistant",
    content,
    api: "dsh-foreign",
    provider: String(message.source?.provider ?? "unknown"),
    model: String(message.source?.model ?? "unknown"),
    usage: emptyUsage(),
    stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
  };
}

/**
 * One assistant turn as pi-ai history: replayed natively (ids, signatures)
 * when this plugin produced it for the same site, route, model and protocol;
 * else as provider-neutral content (a version-1 envelope, another provider's
 * turn, a switch group's other member). A turn another key made (its account
 * signed it), or any turn when `unsigned`, keeps its text, reasoning text and
 * tool calls but none of its signatures or sealed reasoning.
 */
export function toPiAssistant(message, { site, route, requested, piModel, keyId, unsigned = false }) {
  const state = message?.source?.replayState;
  const response = isRecord(state?.response) ? state.response : null;
  const blocks = Array.isArray(state?.blocks) ? state.blocks : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  const same = response && blocks && response.kind === REPLAY_KIND && response.version === REPLAY_VERSION
    && response.site === site && response.provider === route && response.model === requested
    && response.realModel === piModel.id && response.api === piModel.api
    && message.source?.provider === route && message.source?.model === requested
    && blocks.length === content.length && blocks.every((entry, index) => isRecord(entry) && entry.type === content[index]?.type)
    && ["stop", "length", "toolUse"].includes(response.stopReason);
  if (!same) return foreignAssistant(message);
  const signed = !unsigned && (response.key === undefined || response.key === keyId);
  return {
    role: "assistant",
    content: content.flatMap((block, index) => {
      const replay = blocks[index];
      if (block.type === "reasoning") {
        // A redacted block is nothing but its sealed payload.
        // Chat Completions keeps the name of its reasoning field there (reasoning_content): no signature, it stays.
        if (!signed) return replay.redacted === true ? [] : [{ type: "thinking", thinking: String(block.text ?? ""), ...(PLAIN_REASONING_FIELDS.has(replay.thinkingSignature) ? { thinkingSignature: replay.thinkingSignature } : {}) }];
        return [{ type: "thinking", thinking: String(block.text ?? ""), ...(asString(replay.thinkingSignature) ? { thinkingSignature: replay.thinkingSignature } : {}), ...(typeof replay.redacted === "boolean" ? { redacted: replay.redacted } : {}) }];
      }
      if (block.type === "tool-call") return [{ type: "toolCall", id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: parseArguments(block.arguments), ...(signed && asString(replay.thoughtSignature) ? { thoughtSignature: replay.thoughtSignature } : {}), ...(asString(replay.namespace) ? { namespace: replay.namespace } : {}) }];
      return [{ type: "text", text: String(block.text ?? ""), ...(signed && asString(replay.textSignature) ? { textSignature: replay.textSignature } : {}) }];
    }),
    api: piModel.api,
    provider: route,
    model: piModel.id,
    ...(asString(response.responseModel) ? { responseModel: response.responseModel } : {}),
    ...(asString(response.responseId) ? { responseId: response.responseId } : {}),
    ...(asString(response.providerThinkingLevel) ? { providerThinkingLevel: response.providerThinkingLevel } : {}),
    usage: emptyUsage(),
    stopReason: response.stopReason,
    timestamp: 0,
  };
}

// ---------------------------------------------------------------- context

const flatText = (content) => (typeof content === "string" ? content : (Array.isArray(content) ? content : []).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join(""));

/** A user (or tool result) content list as pi-ai content: text, and images when the model takes them. */
async function userContent(blocks, context) {
  const content = [];
  for (const block of typeof blocks === "string" ? [{ type: "text", text: blocks }] : Array.isArray(blocks) ? blocks : []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) content.push({ type: "text", text: clean(block.text) });
    else if (block?.type === "image") {
      const image = await loadImage(block, context);
      if (!image.placeholder) context.sizes?.push(image.data.length);
      content.push(image.placeholder ? { type: "text", text: image.placeholder } : { type: "image", data: image.data, mimeType: image.mediaType });
    }
  }
  return content.every((part) => part.type === "text") ? content.map((part) => part.text).join("") : content;
}

/**
 * The harness request as a pi-ai context: the request's system text and the
 * leading system messages become the system prompt; later system and
 * developer notes stay in place as system messages (pi-ai folds them in for
 * models that take none mid-conversation); tools are the declared ones.
 * `imageSizes`, when given, receives each image sent (its base64 length) in
 * the order DSH counts them: message by message, oldest first.
 */
export async function toPiContext(options, { site, route, requested, piModel, attachments, imageMaxBytes, imageSizes, keyId, unsigned }) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const system = [typeof options.system === "string" ? options.system : flatText(options.system)];
  let start = 0;
  while (start < messages.length && messages[start]?.role === "system") system.push(flatText(messages[start++].content));
  const imageContext = { model: { image: piModel.input.includes("image") }, attachments, signal: options.signal, ...(imageMaxBytes ? { maxBytes: imageMaxBytes } : {}), sizes: imageSizes };
  const toolNames = new Map();
  const out = [];
  for (const message of messages.slice(start)) {
    switch (message?.role) {
      case "system":
      case "developer": {
        // Tool additions and removals are not offered to this route (its models declare no tool updates): only the text travels.
        const text = clean(flatText(message.content));
        if (text) out.push({ role: "system", content: [{ type: "text", text }], timestamp: 0 });
        break;
      }
      case "assistant": {
        const assistant = toPiAssistant(message, { site, route, requested, piModel, keyId, unsigned });
        for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
        out.push(assistant);
        break;
      }
      case "tool": {
        const content = await userContent(message.content, imageContext);
        out.push({
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: toolNames.get(message.toolCallId) ?? "unknown",
          content: typeof content === "string" ? [{ type: "text", text: content || "(no output)" }] : content,
          isError: message.isError === true,
          timestamp: 0,
        });
        break;
      }
      default:
        out.push({ role: "user", content: await userContent(message?.content, imageContext), timestamp: 0 });
    }
  }
  const tools = (Array.isArray(options.tools) ? options.tools : []).filter((tool) => tool?.name && !tool.deferLoading).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  const systemPrompt = system.filter(Boolean).map(clean).join("\n\n");
  return { ...(systemPrompt ? { systemPrompt } : {}), messages: out, ...(tools.length ? { tools } : {}) };
}

// ------------------------------------------------------------------- wire

/**
 * The fetch pi-ai's SDKs use: the plugin's own (DSH's proxy applies as to
 * every other request of the plugin), with the key presented as before (a
 * keyless site sends none; Anthropic Messages also as a Bearer token, which
 * gateways read), keeping what a refusal said and watching the stream.
 */
function siteFetch(fetchImpl, trace, { keyless, key, api }) {
  return async (input, init = {}) => {
    const headers = {};
    new Headers(init.headers ?? {}).forEach((value, name) => { headers[name] = value; });
    if (keyless) {
      delete headers.authorization;
      delete headers["x-api-key"];
    } else if (api === "anthropic-messages" && !headers.authorization && key) headers.authorization = `Bearer ${key}`;
    const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? input);
    if (typeof init.body === "string") trace.bodyBytes = init.body.length;
    const response = await fetchImpl(url, { ...init, headers });
    trace.status = response.status;
    if (!response.ok) {
      trace.failure = { status: response.status, text: await response.clone().text().catch(() => ""), headers: response.headers, images: trace.images ?? [], bodyBytes: trace.bodyBytes };
      return response;
    }
    trace.headers = response.headers;
    return observe(response, trace);
  };
}

/** The cost a final usage reports: OpenRouter's number, Hyper's `{ usd }`, xAI's ticks. */
function reportedCost(usage) {
  if (!isRecord(usage)) return undefined;
  const ticks = asNumber(usage.cost_in_usd_ticks);
  return asNumber(usage.cost) ?? asNumber(usage.cost?.usd) ?? (ticks !== undefined ? ticks / 1e10 : undefined);
}

/**
 * Pass a 2xx answer through while reading it: the data frames (how many, the
 * first), whether any carried token usage, the cost in its final usage; a
 * body that is not a stream is kept (a relay's page or error with a 200).
 */
function observe(response, trace) {
  const type = response.headers.get("content-type") ?? "";
  if (!response.body) return response;
  if (!/event-stream/i.test(type)) {
    trace.nonStream = { type };
    response.clone().text().then((text) => { trace.nonStream.text = text; }, () => {});
    return response;
  }
  trace.frames = 0;
  trace.usageSeen = false;
  const decoder = new TextDecoder();
  let buffer = "";
  const scan = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    trace.frames += 1;
    if (trace.firstFrame === undefined) trace.firstFrame = payload.slice(0, 240);
    // Model authenticity checks (authn/): the answer's id, echo, tool-call ids, signature, usage fields.
    if (trace.wire) {
      try {
        scanFrame(trace.wire, payload);
      } catch {
        /* a frame scanning cannot read stays the answer's own business */
      }
    }
    // Chat's `usage`, Responses' `response.usage`, Messages' `message.usage` / `usage` (`null` is none).
    if (/"usage"\s*:\s*\{/.test(payload)) {
      trace.usageSeen = true;
      // Chat's cache hits under any vendor's name, for withCacheHits.
      if (/"(prompt_cache_hit_tokens|cached_tokens)"/.test(payload)) {
        const frame = safeJson(payload);
        const usage = frame?.usage ?? frame?.choices?.[0]?.usage;
        if (usage && typeof usage === "object") trace.chatUsage = usage;
      }
    }
    if (!/"(cost|cost_in_usd_ticks)"/.test(payload)) return;
    const frame = safeJson(payload);
    const cost = reportedCost(frame?.usage) ?? reportedCost(frame?.response?.usage) ?? reportedCost(frame?.message?.usage);
    if (cost !== undefined) trace.cost = cost;
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        scan(buffer.slice(0, at).trim());
        buffer = buffer.slice(at + 1);
      }
    },
    flush() {
      if (buffer.trim()) scan(buffer.trim());
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * The changes to pi-ai's Responses request: input items written in OpenAI's
 * short form (`{ role, content }`) get their `type: "message"`, which OpenAI
 * reads the same and Charm Hyper requires (it refuses an item without it;
 * checked live 2026-10-18); and a function tool without `strict` says false.
 */
export function typedResponsesInput(params) {
  if (!isRecord(params)) return undefined;
  const input = Array.isArray(params.input) ? params.input.map((item) => (isRecord(item) && item.role && item.type === undefined ? { type: "message", ...item } : item)) : params.input;
  // A function tool without a strict field is a strict one to OpenAI's Responses API: every parameter turns
  // required and the model fills the optional ones (pi-ai 1.3.0 leaves the field out for these models).
  const tools = Array.isArray(params.tools) ? params.tools.map((tool) => (isRecord(tool) && tool.type === "function" && tool.strict === undefined ? { ...tool, strict: false } : tool)) : params.tools;
  return { ...params, input, ...(tools !== undefined ? { tools } : {}) };
}

/**
 * Chat Completions for a model that wants its reasoning back (`reasoningOnAssistant`): an assistant turn of a
 * tool loop (its tool calls, or the reply after a tool result) without reasoning goes with a space. pi-ai sends
 * an empty one, which DeepSeek takes, but a relay that drops empty fields passes none on and DeepSeek refuses
 * the request ("The `reasoning_content` in the thinking mode must be passed back"); a space it takes
 * (magpie, checked against api.deepseek.com 2026-11-02). Other replies stay as they are.
 */
export function reasoningOnToolTurns(params) {
  if (!isRecord(params) || !Array.isArray(params.messages)) return undefined;
  let afterTool = false;
  const messages = params.messages.map((message) => {
    if (!isRecord(message)) return message;
    if (message.role === "tool") afterTool = true;
    else if (message.role === "user") afterTool = false;
    const calls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (message.role !== "assistant" || !(calls || afterTool)) return message;
    return typeof message.reasoning_content === "string" && message.reasoning_content.length > 0 ? message : { ...message, reasoning_content: " " };
  });
  return { ...params, messages };
}

/** Request headers: the plugin's identity (as DSH sends its own), then the site's (a site's own User-Agent wins). */
export function requestHeaders(siteHeaders) {
  const own = isRecord(siteHeaders) ? siteHeaders : {};
  const named = Object.keys(own).some((name) => name.toLowerCase() === "user-agent");
  return { ...(named ? {} : { "user-agent": USER_AGENT }), ...own };
}

/** What a failure pi-ai reported in words (no HTTP answer to read) means. */
function wordedKind(text) {
  if (/content_filter|sensitive/i.test(text)) return "moderation";
  if (/\b429\b|rate.?limit/i.test(text)) return "rate-limit";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return "timeout";
  if (/\b5\d\d\b|network_error/i.test(text)) return "server";
  if (/stream ended (?:before|without)\b|\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|other side closed|\bterminated\b|premature close/i.test(text)) return "transport";
  if (/\b4\d\d\b|invalid.?request/i.test(text)) return "bad-request";
  return "server";
}

/** Why a finished answer had nothing in it, from what the stream carried. */
function emptyDetail(trace) {
  if (trace.nonStream) {
    const title = htmlTitle(trace.nonStream.text);
    return title ? `站点未以流式方式响应，返回的是网页：${title}` : `站点未以流式方式响应（${trace.nonStream.type || "未知类型"}）：${String(trace.nonStream.text ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
  }
  if (!trace.frames) return "站点返回 200，但数据流为空";
  return `站点的数据流中无正文、思考内容或工具调用（${trace.frames} 个数据帧，首帧：${trace.firstFrame}）`;
}

const mapUsage = (usage) => ({
  inputTokens: usage?.input ?? 0,
  outputTokens: usage?.output ?? 0,
  totalTokens: usage?.totalTokens ?? 0,
  ...(usage?.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
  ...(usage?.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
});

/**
 * pi-ai takes Chat's `prompt_tokens_details.cached_tokens` first, even when
 * it reads 0 beside the site's real count (DeepSeek's
 * `prompt_cache_hit_tokens`, Moonshot's top-level `cached_tokens`), and
 * DSH then shows 0 % cache hits. The largest of the three is the hits; the
 * rest of the prompt stays input, so the total is unchanged.
 */
function withCacheHits(usage, raw) {
  const hits = Math.max(0, ...[raw?.prompt_tokens_details?.cached_tokens, raw?.prompt_cache_hit_tokens, raw?.cached_tokens].map(asNumber).filter((value) => value !== undefined));
  const read = usage?.cacheRead ?? 0;
  if (!usage || hits <= read) return usage;
  return { ...usage, cacheRead: hits, input: Math.max(0, (usage.input ?? 0) - (hits - read)) };
}

/**
 * Whether an answer's usage is the site's: some frame carried usage and it
 * counts something. A site that sends none leaves pi-ai's zeros, and zeros
 * would tell DSH the request was empty (its context meter reads ~0 %, its
 * speed 0 tok/s); left out, DSH prices the request itself. So is a usage
 * that counts no output for an answer that has some: DSH's session speed
 * sums output over decode time, and one such step drags it toward 0.
 */
function usageReported(trace, usage, content) {
  const counted = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0) + (usage?.output ?? 0) > 0;
  const answered = (Array.isArray(content) ? content : []).some((block) => block?.type === "toolCall" || (typeof block?.text === "string" && block.text.trim()) || (typeof block?.thinking === "string" && block.thinking.trim()));
  if (answered && !((usage?.output ?? 0) > 0)) return false;
  return counted && trace.usageSeen !== false;
}

/**
 * Stream one call to one site, as DSH's custom gateway would: harness chunks
 * out, the finish carrying this plugin's replay state. A refusal before any
 * output throws {@link SiteRefusal} (the adapter reads it); any other failure
 * throws a classifiable error. A request whose images exceed the site's
 * budget is not sent: DSH is asked to replace the oldest ones with text. A
 * finished tool call whose arguments are no JSON object fails the answer at
 * its end (`MALFORMED_RESPONSE`, as DSH's gateway): no tool runs on a guess.
 * @param {object} input - `{ endpoint, model (complete), effort, options, key, keyless, where, fetchImpl, attachments, idleMs, images, report }`;
 *   `images` is `{ budget, maxBytes }`; `report.cost` receives a cost the site reported, `report.usageReported` whether it reported usage.
 */
export async function* streamSite({ endpoint, model, effort, options, key, keyless = false, where, fetchImpl = fetch, attachments, idleMs = 600_000, images = {}, report = {}, keyId, unsigned = false, observeWire = false }) {
  const route = options.provider;
  const piModel = piModelOf(endpoint, model, route);
  if (!piModel) {
    throw cnError(CODES.badRequest, `${where}：该${model.protocol ? "模型" : "站点"}使用 Google Gemini 协议，本插件已停止支持；请通过 Intl_Ex 插件使用 Gemini，或在「Custom」标签页改用 OpenAI 兼容协议`, { kind: "bad-request", endpoint: endpoint.id });
  }
  const imageSizes = [];
  const context = await toPiContext(options, { site: endpoint.id, route, requested: options.model, piModel, attachments, imageMaxBytes: images.maxBytes, imageSizes, keyId, unsigned });
  const imageBytes = imageSizes.reduce((sum, size) => sum + size, 0);
  if (Number.isFinite(images.budget) && imageBytes > images.budget) {
    const offloadImages = imagesToOffload(imageSizes, images.budget);
    throw cnError(CODES.imageOffload, `${where}：本次请求的图片共 ${megabytes(imageBytes)}，超出该站点的图片总额度 ${megabytes(images.budget)}；DeepSeek Harness 将把最早的 ${offloadImages} 张图片替换为文字说明后重试`, { kind: "image-offload", offloadImages, endpoint: endpoint.id });
  }
  // What passive scanning reads of this answer (authn/; only while model checks are on): its wire, and the protocol.
  const trace = { images: imageSizes, ...(observeWire ? { wire: newWire() } : {}) };
  report.wire = trace.wire;
  report.protocol = piModel.api === "anthropic-messages" ? "messages" : piModel.api === "openai-responses" ? "responses" : "chat";
  // An answer's usage above the window means a silent overflow only for a window the site or the user stated;
  // a capped reference figure is a guess, and a site that served more simply has the room.
  const overflowWindow = model.contextOrigin === "reference" || model.contextOrigin === "none" ? undefined : piModel.contextWindow;
  const consumer = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, consumer.signal]) : consumer.signal;
  const level = piModel.reasoning && effort && effort !== "off" ? effort : undefined;
  // As pi-ai's Models.streamSimple (DSH's path): the system prompt and tools become the transcript's leading system message;
  // a custom route's auth adds nothing beyond the request's own key.
  const events = apiFor(piModel.api).streamSimple(piModel, normalizeContext(context), {
    // pi-ai's SDKs insist on a key; a keyless site's placeholder never leaves (siteFetch drops it).
    apiKey: keyless || !key ? "keyless" : key,
    ...(level ? { reasoning: level } : {}),
    ...(typeof options.temperature === "number" && model.flags?.noTemperature !== true ? { temperature: options.temperature } : {}),
    ...(Number.isInteger(options.maxTokens) && options.maxTokens > 0 ? { maxTokens: Math.min(options.maxTokens, piModel.maxTokens) } : {}),
    ...(options.sessionId !== undefined && options.sessionId !== null ? { sessionId: String(options.sessionId) } : {}),
    signal,
    headers: requestHeaders(endpoint.headers),
    maxRetries: 0,
    ...(piModel.api === "openai-responses" ? { onPayload: typedResponsesInput }
      : piModel.api === "openai-completions" && piModel.reasoning && piModel.compat?.requiresReasoningContentOnAssistantMessages ? { onPayload: reasoningOnToolTurns } : {}),
    fetch: siteFetch(fetchImpl, trace, { keyless: keyless || !key, key, api: piModel.api }),
  });
  const iterator = events[Symbol.asyncIterator]();
  const toolIds = new Map();
  // The first finished tool call whose arguments pi-ai could not read as a JSON object (it says so since 1.3.0).
  let argumentsError;
  let finished = false;
  try {
    while (true) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => reject(cnError(CODES.timeout, `${where}：${Math.round(idleMs / 1000)} 秒内未收到数据，请求已中断`, { kind: "timeout", endpoint: endpoint.id })), idleMs);
        timer.unref?.();
      });
      let step;
      try {
        step = await Promise.race([iterator.next(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) break;
      const event = step.value;
      switch (event.type) {
        case "text_start": yield { type: "block-start", index: event.contentIndex, blockType: "text" }; break;
        case "text_delta": yield { type: "text-delta", index: event.contentIndex, text: event.delta }; break;
        case "text_end": yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } }; break;
        case "thinking_start": yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" }; break;
        case "thinking_delta": yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta }; break;
        case "thinking_end": yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } }; break;
        case "toolcall_start": {
          const partial = event.partial?.content?.[event.contentIndex];
          toolIds.set(event.contentIndex, { id: partial?.type === "toolCall" ? partial.id : "", name: partial?.type === "toolCall" ? partial.name : "" });
          yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
          break;
        }
        case "toolcall_delta": {
          const known = toolIds.get(event.contentIndex);
          yield { type: "tool-call-delta", index: event.contentIndex, id: known?.id ?? "", ...(known?.name ? { name: known.name } : {}), argumentsDelta: event.delta };
          break;
        }
        case "toolcall_end":
          // Not handed to DSH as `{}` (1.1.0 ran the tool so): the answer fails at its end.
          if (event.toolCall.argumentsError !== undefined) {
            argumentsError ??= `Tool call "${event.toolCall.name}": ${event.toolCall.argumentsError}`;
            break;
          }
          yield { type: "block-end", index: event.contentIndex, block: { type: "tool-call", id: event.toolCall.id, name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments ?? {}) } };
          break;
        case "done": {
          const message = event.message;
          // As DSH's gateway: unreadable tool arguments fail the answer after its usage, before its stop is read;
          // an answer cut off at its output limit keeps that reason (DSH drops the unfinished call).
          const malformed = argumentsError !== undefined && message.stopReason !== "length";
          if (!malformed && isContextOverflow(message, overflowWindow)) throw cnError(CODES.context, `${where}：${KIND_LABELS.context ?? "超出上下文窗口"}（${model.id}）`, { kind: "context", endpoint: endpoint.id });
          if (message.stopReason === "stop" && message.content.length === 0) throw cnError(CODES.empty, `${where}：未返回任何内容（${model.id}）：${emptyDetail(trace)}`, { kind: "empty", endpoint: endpoint.id });
          if (trace.cost !== undefined) report.cost = trace.cost;
          // Reasoning tokens the usage counts (hidden ones too), for model checks.
          if (Number.isFinite(message.usage?.reasoning)) report.reasoningTokens = message.usage.reasoning;
          if (trace.headers) report.headers = trace.headers;
          report.usageReported = usageReported(trace, message.usage, message.content);
          if (report.usageReported) yield { type: "usage", usage: mapUsage(withCacheHits(message.usage, trace.chatUsage)) };
          if (malformed) throw cnError(CODES.malformed, `${where}：模型返回的工具调用参数格式错误，未执行任何工具（${model.id}）：${argumentsError}`, { kind: "malformed", endpoint: endpoint.id });
          const reason = message.stopReason === "length" ? { kind: "max-tokens" } : message.stopReason === "toolUse" ? { kind: "tool-calls" } : { kind: "stop" };
          yield { type: "finish", reason, replayState: replayStateOf(message, { site: endpoint.id, requested: options.model, keyId }) };
          finished = true;
          return;
        }
        case "error": {
          const message = event.error ?? {};
          if (options.signal?.aborted || message.stopReason === "aborted") throw cnError(CODES.aborted, `${where}：请求已取消`, { kind: "aborted", endpoint: endpoint.id });
          if (trace.failure) throw new SiteRefusal(trace.failure);
          const text = String(message.errorMessage ?? "请求失败");
          if (isContextOverflow(message, overflowWindow)) throw cnError(CODES.context, `${where}：${KIND_LABELS.context ?? "超出上下文窗口"}：${text}`, { kind: "context", endpoint: endpoint.id });
          const detail = trace.nonStream ? emptyDetail(trace) : text;
          const kind = trace.nonStream ? "server" : wordedKind(text);
          throw cnError(KIND_CODES[kind] ?? CODES.server, `${where}：${KIND_LABELS[kind] ?? "请求失败"}：${detail}`, { kind, endpoint: endpoint.id });
        }
        default:
          break;
      }
    }
    throw cnError(CODES.transport, `${where}：连接在响应完成前中断${trace.failure ? `（HTTP ${trace.failure.status}）` : ""}`, { kind: "transport", endpoint: endpoint.id });
  } finally {
    if (!finished) {
      consumer.abort("custom-models: stream consumer stopped");
      iterator.return?.(undefined)?.catch?.(() => {});
    }
  }
}
