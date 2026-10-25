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
 * One deliberate difference: Responses input items always name their type
 * ({@link typedResponsesInput}), which Charm Hyper requires.
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
import { asNumber, asString, cnError, CODES, isRecord, safeJson } from "./errors.js";
import { clean, loadImage } from "./request.js";
import { USER_AGENT } from "./wire.js";

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

/** A site's refusal (a non-2xx answer), for the adapter to read: `{ status, text, headers }`. */
export class SiteRefusal extends Error {
  constructor({ status, text, headers }) {
    super(`HTTP ${status}`);
    this.name = "SiteRefusal";
    this.status = status;
    this.text = text;
    this.headers = headers;
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
export function replayStateOf(message, { site, requested }) {
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      api: message.api,
      site,
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

/** Another provider's (or another model's) turn: its text, reasoning and tool calls, nothing passed off as this model's. */
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
 * turn, a switch group's other member).
 */
export function toPiAssistant(message, { site, route, requested, piModel }) {
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
  return {
    role: "assistant",
    content: content.map((block, index) => {
      const replay = blocks[index];
      if (block.type === "reasoning") return { type: "thinking", thinking: String(block.text ?? ""), ...(asString(replay.thinkingSignature) ? { thinkingSignature: replay.thinkingSignature } : {}), ...(typeof replay.redacted === "boolean" ? { redacted: replay.redacted } : {}) };
      if (block.type === "tool-call") return { type: "toolCall", id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: parseArguments(block.arguments), ...(asString(replay.thoughtSignature) ? { thoughtSignature: replay.thoughtSignature } : {}), ...(asString(replay.namespace) ? { namespace: replay.namespace } : {}) };
      return { type: "text", text: String(block.text ?? ""), ...(asString(replay.textSignature) ? { textSignature: replay.textSignature } : {}) };
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
 */
export async function toPiContext(options, { site, route, requested, piModel, attachments }) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const system = [typeof options.system === "string" ? options.system : flatText(options.system)];
  let start = 0;
  while (start < messages.length && messages[start]?.role === "system") system.push(flatText(messages[start++].content));
  const imageContext = { model: { image: piModel.input.includes("image") }, attachments, signal: options.signal };
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
        const assistant = toPiAssistant(message, { site, route, requested, piModel });
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
    const response = await fetchImpl(url, { ...init, headers });
    trace.status = response.status;
    if (!response.ok) {
      trace.failure = { status: response.status, text: await response.clone().text().catch(() => ""), headers: response.headers };
      return response;
    }
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
 * first), the cost in its final usage; a body that is not a stream is kept
 * (a relay's page or error with a 200).
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
  const decoder = new TextDecoder();
  let buffer = "";
  const scan = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    trace.frames += 1;
    if (trace.firstFrame === undefined) trace.firstFrame = payload.slice(0, 240);
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
 * The one change to pi-ai's request: Responses input items written in
 * OpenAI's short form (`{ role, content }`) get their `type: "message"`,
 * which OpenAI reads the same and Charm Hyper requires (it refuses an item
 * without it; checked live 2026-10-18).
 */
export function typedResponsesInput(params) {
  if (!Array.isArray(params?.input)) return undefined;
  return { ...params, input: params.input.map((item) => (isRecord(item) && item.role && item.type === undefined ? { type: "message", ...item } : item)) };
}

/** Request headers: the plugin's identity (as DSH sends its own), then the site's (a site's own User-Agent wins). */
function requestHeaders(siteHeaders) {
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
    return title ? `站点没有按流式回答，返回了网页：${title}` : `站点没有按流式回答（${trace.nonStream.type || "未知类型"}）：${String(trace.nonStream.text ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
  }
  if (!trace.frames) return "站点返回了 200，但流里没有任何数据";
  return `站点的流里没有正文、思考或工具调用（${trace.frames} 个数据帧，第一帧：${trace.firstFrame}）`;
}

const mapUsage = (usage) => ({
  inputTokens: usage?.input ?? 0,
  outputTokens: usage?.output ?? 0,
  totalTokens: usage?.totalTokens ?? 0,
  ...(usage?.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
  ...(usage?.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
});

/**
 * Stream one call to one site, as DSH's custom gateway would: harness chunks
 * out, the finish carrying this plugin's replay state. A refusal before any
 * output throws {@link SiteRefusal} (the adapter reads it); any other failure
 * throws a classifiable error.
 * @param {object} input - `{ endpoint, model (complete), effort, options, key, keyless, where, fetchImpl, attachments, idleMs, report }`; `report.cost` receives a cost the site reported.
 */
export async function* streamSite({ endpoint, model, effort, options, key, keyless = false, where, fetchImpl = fetch, attachments, idleMs = 600_000, report = {} }) {
  const route = options.provider;
  const piModel = piModelOf(endpoint, model, route);
  if (!piModel) {
    throw cnError(CODES.badRequest, `${where}：这个${model.protocol ? "模型" : "站点"}的协议是 Google Gemini，自定义插件已不再支持；Gemini 请在「国际模型」插件里使用，或在「自定义」标签页改用 OpenAI 兼容协议`, { kind: "bad-request", endpoint: endpoint.id });
  }
  const context = await toPiContext(options, { site: endpoint.id, route, requested: options.model, piModel, attachments });
  const trace = {};
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
    ...(piModel.api === "openai-responses" ? { onPayload: typedResponsesInput } : {}),
    fetch: siteFetch(fetchImpl, trace, { keyless: keyless || !key, key, api: piModel.api }),
  });
  const iterator = events[Symbol.asyncIterator]();
  const toolIds = new Map();
  let finished = false;
  try {
    while (true) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => reject(cnError(CODES.timeout, `${where}：${Math.round(idleMs / 1000)} 秒没有收到数据，已中断`, { kind: "timeout", endpoint: endpoint.id })), idleMs);
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
          yield { type: "block-end", index: event.contentIndex, block: { type: "tool-call", id: event.toolCall.id, name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments ?? {}) } };
          break;
        case "done": {
          const message = event.message;
          if (isContextOverflow(message, piModel.contextWindow)) throw cnError(CODES.context, `${where}：${KIND_LABELS.context ?? "超出上下文长度"}（${model.id}）`, { kind: "context", endpoint: endpoint.id });
          if (message.stopReason === "stop" && message.content.length === 0) throw cnError(CODES.empty, `${where} 没有返回内容（${model.id}）：${emptyDetail(trace)}`, { kind: "empty", endpoint: endpoint.id });
          if (trace.cost !== undefined) report.cost = trace.cost;
          yield { type: "usage", usage: mapUsage(message.usage) };
          const reason = message.stopReason === "length" ? { kind: "max-tokens" } : message.stopReason === "toolUse" ? { kind: "tool-calls" } : { kind: "stop" };
          yield { type: "finish", reason, replayState: replayStateOf(message, { site: endpoint.id, requested: options.model }) };
          finished = true;
          return;
        }
        case "error": {
          const message = event.error ?? {};
          if (options.signal?.aborted || message.stopReason === "aborted") throw cnError(CODES.aborted, `${where}：请求已取消`, { kind: "aborted", endpoint: endpoint.id });
          if (trace.failure) throw new SiteRefusal(trace.failure);
          const text = String(message.errorMessage ?? "请求失败");
          if (isContextOverflow(message, piModel.contextWindow)) throw cnError(CODES.context, `${where}：${KIND_LABELS.context ?? "超出上下文长度"}：${text}`, { kind: "context", endpoint: endpoint.id });
          const detail = trace.nonStream ? emptyDetail(trace) : text;
          const kind = trace.nonStream ? "server" : wordedKind(text);
          throw cnError(KIND_CODES[kind] ?? CODES.server, `${where}：${KIND_LABELS[kind] ?? "请求失败"}：${detail}`, { kind, endpoint: endpoint.id });
        }
        default:
          break;
      }
    }
    throw cnError(CODES.transport, `${where}：连接在回答结束前中断${trace.failure ? `（HTTP ${trace.failure.status}）` : ""}`, { kind: "transport", endpoint: endpoint.id });
  } finally {
    if (!finished) {
      consumer.abort("custom-models: stream consumer stopped");
      iterator.return?.(undefined)?.catch?.(() => {});
    }
  }
}
