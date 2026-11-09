/**
 * Passive scanning: what one answer's wire and numbers say, kept as one small
 * observation — never the conversation. The gateway hands every data frame of
 * a streamed answer to {@link scanFrame} (cheap tests first; a frame is parsed
 * only when it may carry an id, a tool call, a signature or usage), and the
 * adapter builds the {@link observation} when the answer ends.
 *
 * An observation keeps: ids as a salted hash plus their form (letters, digits,
 * length) and first characters, the model the site echoed, the signals and
 * the stub the rule pack matched, header names (no values), usage numbers,
 * timing, characters and tokens, tool-call health, and a hash of the answer's
 * opening and of the last user message (to see one answer given to different
 * questions). Prompts and answers themselves are not kept.
 *
 * @module dsh-custom-models/authn/observe
 */
import { createHash, randomBytes } from "node:crypto";
import { matchSignals, matchStub } from "./rules.js";

/** A per-process salt: hashes compare within this run and the store, and say nothing outside it. */
let salt = randomBytes(16).toString("hex");
/** The store's own salt (kept with the observations, so hashes compare across restarts). */
export function useSalt(value) {
  if (typeof value === "string" && /^[0-9a-f]{32}$/.test(value)) salt = value;
  return salt;
}
export const hashOf = (value) => createHash("sha256").update(`${salt}\u0000${value}`).digest("hex").slice(0, 16);

/** An id's form: letters a/A, digits 9, the rest kept (`gen-1794188755-xs7d…` → `aaa-9999999999-aa9a…`). */
export function shapeOf(value) {
  return String(value ?? "").slice(0, 64).replace(/[0-9]/g, "9").replace(/[a-z]/g, "a").replace(/[A-Z]/g, "A");
}

/** An id's first characters, as far as they are the same for every id of its kind (up to 10, before the random part). */
export function prefixOf(value) {
  const text = String(value ?? "");
  const match = /^[A-Za-z]+(?:[_-][A-Za-z]+)*[_-](?:\d\d_)?/.exec(text);
  return (match ? match[0] : text.slice(0, 4)).slice(0, 16);
}

/** A fresh record of one answer's wire (the gateway's trace carries it). */
export const newWire = () => ({ frames: 0, id: null, ids: new Set(), echo: null, fingerprint: null, tier: null, toolId: null, toolIds: 0, signature: null, signatureLength: 0, thinking: false, redacted: false, encrypted: false, usageFields: null, stop: null });

const first = (pattern, text) => {
  const match = pattern.exec(text);
  return match ? match[1] : null;
};
const safe = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Read one data frame (the JSON text of an SSE `data:` line) into the wire record. */
export function scanFrame(wire, payload) {
  if (!wire || typeof payload !== "string" || payload.length === 0 || payload === "[DONE]") return;
  wire.frames += 1;
  const head = payload.slice(0, 400);
  if (wire.id === null) wire.id = first(/"id"\s*:\s*"([^"]{1,200})"/, head);
  if (/"chat\.completion\.chunk"/.test(head) && wire.ids.size < 8) {
    // Every Chat frame repeats the answer's id. Two or three ids in one answer: frames of different answers stitched
    // together; a new id on every frame is a converter's way (one-api's Gemini adapter), no sign of anything.
    const id = first(/^\{\s*"id"\s*:\s*"([^"]{1,200})"/, head);
    if (id) wire.ids.add(id);
  }
  if (wire.echo === null) wire.echo = first(/"model"\s*:\s*"([^"]{1,200})"/, head);
  if (wire.fingerprint === null && payload.includes("system_fingerprint")) wire.fingerprint = first(/"system_fingerprint"\s*:\s*"([^"]{1,120})"/, payload);
  if (wire.tier === null && payload.includes("service_tier")) wire.tier = first(/"service_tier"\s*:\s*"([^"]{1,40})"/, payload);
  if (payload.includes("redacted_thinking")) wire.redacted = true;
  if (payload.includes("encrypted_content")) wire.encrypted = true;
  if (!wire.thinking && /"thinking_delta"|"reasoning_content"\s*:\s*"[^"]|"reasoning"\s*:\s*"[^"]/.test(payload)) wire.thinking = true;
  if (payload.includes("signature_delta")) {
    const frame = safe(payload);
    const signature = frame?.delta?.signature;
    if (typeof signature === "string" && signature.length) {
      if (wire.signature === null) wire.signature = signature.slice(0, 8);
      wire.signatureLength += signature.length;
    }
  } else if (/"signature"\s*:\s*"[^"]/.test(payload)) {
    // Some relays put the signature on the block itself (its start or stop frame).
    const frame = safe(payload);
    const signature = frame?.content_block?.signature ?? frame?.delta?.signature;
    if (typeof signature === "string" && signature.length) {
      if (wire.signature === null) wire.signature = signature.slice(0, 8);
      wire.signatureLength += signature.length;
    }
  }
  if (/"tool_calls"|"tool_use"|"function_call"/.test(payload)) {
    const frame = safe(payload);
    const ids = [];
    for (const call of frame?.choices?.[0]?.delta?.tool_calls ?? []) if (typeof call?.id === "string" && call.id) ids.push(call.id);
    if (frame?.type === "content_block_start" && frame.content_block?.type === "tool_use" && typeof frame.content_block.id === "string") ids.push(frame.content_block.id);
    if (frame?.type === "response.output_item.added" && frame.item?.type === "function_call") ids.push(frame.item.call_id ?? frame.item.id);
    for (const id of ids.filter((value) => typeof value === "string" && value)) {
      wire.toolIds += 1;
      wire.toolId ??= id;
    }
  }
  if (/"usage"\s*:\s*\{/.test(payload)) {
    const frame = safe(payload);
    const usage = frame?.usage ?? frame?.response?.usage ?? frame?.message?.usage;
    if (usage && typeof usage === "object") wire.usageFields = [...new Set([...(wire.usageFields ?? []), ...Object.keys(usage)])].slice(0, 30);
  }
  const stop = first(/"(?:finish_reason|stop_reason)"\s*:\s*"([^"]{1,40})"/, payload);
  if (stop) wire.stop = stop;
}

/** Whether a text is mostly Chinese / Japanese / Korean (`zh`), mostly not (`en`), or mixed. */
export function languageOf(text) {
  const value = String(text ?? "");
  let wide = 0;
  let latin = 0;
  let other = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) wide += 1;
    else if (/[A-Za-z]/.test(char)) latin += 1;
    else if (/\p{L}/u.test(char)) other += 1;
  }
  const total = wide + latin + other;
  if (total < 20) return null;
  if (wide / total >= 0.7) return "zh";
  if (latin / total >= 0.95) return "en";
  return "mix";
}

/** A text's canonical opening (case, spaces and punctuation folded), for "the same answer". */
const opening = (text) => String(text ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, " ").trim().slice(0, 200);

/** The last user message's text in a harness request (hashed only). */
export function lastUserText(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "")).join("\n");
  }
  return "";
}

/** Whether a harness request carries images (their tokens are not in the plugin's estimate). */
export function hasImages(options) {
  const seen = (value) => (Array.isArray(value) ? value.some(seen) : value && typeof value === "object" ? value.type === "image" || seen(value.content) : false);
  return (Array.isArray(options?.messages) ? options.messages : []).some((message) => seen(message?.content));
}

/** The tools a request offers, by name, with their required parameters. */
export function toolsOf(options) {
  const out = new Map();
  for (const tool of Array.isArray(options?.tools) ? options.tools : []) {
    if (typeof tool?.name !== "string") continue;
    const schema = tool.parameters ?? tool.inputSchema ?? tool.input_schema;
    out.set(tool.name, { required: Array.isArray(schema?.required) ? schema.required.filter((name) => typeof name === "string") : [], properties: schema && typeof schema.properties === "object" ? schema.properties : null });
  }
  return out;
}

/** Whether a finished tool call fits the request's tools: a known name, a JSON object with the required fields of the right basic type. */
export function toolCallHealth(tools, name, argumentsText) {
  const tool = tools.get(name);
  if (!tool) return tools.size ? "unknown" : "ok";
  const value = safe(argumentsText);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "bad";
  for (const field of tool.required) if (!(field in value)) return "bad";
  for (const [field, given] of Object.entries(value)) {
    const type = tool.properties?.[field]?.type;
    if (typeof type !== "string" || given === null) continue;
    const ok = type === "string" ? typeof given === "string"
      : type === "number" ? typeof given === "number"
        : type === "integer" ? Number.isInteger(given)
          : type === "boolean" ? typeof given === "boolean"
            : type === "array" ? Array.isArray(given)
              : type === "object" ? typeof given === "object" && !Array.isArray(given) : true;
    if (!ok) return "bad";
  }
  return "ok";
}

/**
 * One answer as kept.
 * @param {object} input - `pack` (compiled rules), `protocol`, `sessionId`, `wire` (scanFrame's record),
 *   `headers` (a Headers object or null), `ok`, `kind` (a failure's kind), `usage` (harness usage or null),
 *   `estimate` (input tokens the plugin estimated), `images`, `text` (visible answer, or its first part, read here only),
 *   `chars` (the whole visible answer's length, when `text` is only its first part),
 *   `reasoningChars`, `reasoningTokens` (hidden or not, as the usage says), `ttftMs`, `decodeMs`, `maxTokens` (only when no
 *   reasoning was asked: a reasoning request's real limit includes its budget), `tools` ({ calls, bad, unknown }),
 *   `argumentChars` (the length of the tool calls' arguments), `question` (last user text, hashed),
 *   `now`.
 */
export function observation({ pack, protocol, sessionId, wire = newWire(), headers = null, ok = true, kind = null, usage = null, estimate = null, images = false, text = "", chars = null, reasoningChars = 0, reasoningTokens = 0, ttftMs = null, decodeMs = null, maxTokens = null, tools = null, argumentChars = 0, question = "", now = Date.now() }) {
  const headerNames = [];
  try {
    headers?.forEach?.((_, name) => { if (name !== "set-cookie" && headerNames.length < 60) headerNames.push(name.toLowerCase()); });
  } catch {
    /* no headers */
  }
  const wireView = { ...wire, headers: headerNames };
  const signals = pack ? matchSignals(pack, wireView, protocol) : [];
  const visible = String(text ?? "");
  const out = {
    t: now,
    ...(sessionId ? { s: String(sessionId).slice(0, 120) } : {}),
    p: protocol,
    ok: ok ? 1 : 0,
    ...(kind ? { k: String(kind).slice(0, 30) } : {}),
  };
  if (wire.id) Object.assign(out, { ih: hashOf(`id:${wire.id}`), is: shapeOf(wire.id), ip: prefixOf(wire.id) });
  if (wire.ids instanceof Set && wire.ids.size >= 2 && wire.ids.size <= 3) out.ic = 1;
  if (wire.echo) out.e = String(wire.echo).slice(0, 120);
  if (wire.fingerprint) out.fp = String(wire.fingerprint).slice(0, 60);
  if (wire.tier) out.tr = String(wire.tier).slice(0, 30);
  if (wire.toolId) Object.assign(out, { tp: prefixOf(wire.toolId), ts: shapeOf(wire.toolId) });
  if (wire.thinking) out.th = 1;
  if (wire.signature !== null) out.sg = { h: wire.signature, n: wire.signatureLength };
  if (wire.redacted) out.rd = 1;
  if (wire.encrypted) out.ec = 1;
  if (signals.length) out.sm = signals;
  if (ok) {
    // A notice is a whole short answer: one with a tool call is the model's own words.
    const stub = pack && !tools?.calls ? matchStub(pack, visible) : null;
    if (stub) out.st = stub;
    const open = opening(visible);
    if (open.length >= 20) Object.assign(out, { hh: hashOf(`a:${open}`), hl: visible.length });
    if (question) out.qh = hashOf(`q:${String(question).slice(-2000)}`);
    const lang = languageOf(visible);
    if (lang) out.lg = lang;
    out.vc = Number.isInteger(chars) && chars >= visible.length ? chars : visible.length;
    if (reasoningChars > 0) out.rc = reasoningChars;
    if (Number.isFinite(reasoningTokens) && reasoningTokens > 0) out.rt = reasoningTokens;
    if (usage) {
      out.in = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      out.out = usage.outputTokens ?? 0;
      if (usage.cacheReadTokens) out.cr = usage.cacheReadTokens;
    }
    if (Number.isFinite(estimate) && estimate > 0) out.est = Math.round(estimate);
    if (images) out.img = 1;
    if (Number.isFinite(ttftMs)) out.ft = Math.round(ttftMs);
    if (Number.isFinite(decodeMs) && decodeMs > 0) out.dm = Math.round(decodeMs);
    if (Number.isInteger(maxTokens) && maxTokens > 0) out.mx = maxTokens;
    if (tools && tools.calls) Object.assign(out, { tc: tools.calls, ...(tools.bad ? { tb: tools.bad } : {}), ...(tools.unknown ? { tu: tools.unknown } : {}) });
    if (Number.isInteger(argumentChars) && argumentChars > 0) out.ac = argumentChars;
    if (wire.stop) out.sr = String(wire.stop).slice(0, 30);
  } else if (Number.isFinite(estimate) && estimate > 0) out.est = Math.round(estimate);
  return out;
}
