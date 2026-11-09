/**
 * A model's real window, as the site shows it when its list does not.
 *
 * - **Headers**: some answers carry it (a relay station passes xAI's
 *   `x-grok-context-window: 256000` through, live 2026-11-01).
 * - **Refusals**: a request over the window is refused in words that often
 *   state it — vLLM / OpenAI "This model's maximum context length is 1048576
 *   tokens" (a relay station, live), Anthropic "prompt is too long: 250000 tokens >
 *   200000 maximum".
 * - **A probe**: a one-line prompt asking for an impossible output
 *   (`max_tokens` 10 million) is refused before any generation, in those same
 *   words — free. Where the refusal names no window but is plainly about the
 *   request's size ("exceeds this model's maximum context length", or a
 *   gateway's 503 "the model is unavailable" for a request no backend fits —
 *   a relay station, live), the largest output the site still serves is searched
 *   for (about 17 requests: refusals are free, a served one is cut off at its
 *   first byte), and the window is that plus the prompt — snapped to the
 *   common window it lands on (a relay station, live: GLM-5.3 and Kimi-K3 1,048,576;
 *   Qwen3.8-27B 262,144; Gemma 4 and Muse 131,072). A site that clamps the
 *   output and answers tells nothing; neither does a refusal of the output
 *   limit (a relay station's "valid range of max_tokens"), of the key's money
 *   (a relay station's reservation) or a rate limit. A probe never marks the key: it
 *   is no request of the user's.
 *
 * What is learned is the site's own word on the model (`contextFrom:
 * "measured"`): below a window the site's list states, above the reference
 * catalog's figure, never over the user's edit.
 *
 * @module dsh-custom-models/context
 */
import { messagesBaseOf } from "./endpoints.js";
import { asNumber, isRecord } from "./errors.js";
import { requestHeaders } from "./gateway.js";

/** How a window was learned. */
export const MEASURED_FROM = Object.freeze(["header", "error", "probe", "search"]);
/** The probe's version: models probed by an older one are probed again once (0.4.3: the search). */
export const PROBE_VERSION = 2;
/** The output a probe asks for: more than any window. */
const PROBE_OUTPUT = 10_000_000;
/** The output a model surely fits (a search starts from it). */
const SMALL_OUTPUT = 64;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_PROMPT = "Reply with one word: ok";
/** Windows models come in: a search's figure (the prompt aside) lands just under one of them. */
const COMMON_WINDOWS = [8_192, 16_384, 32_768, 40_960, 65_536, 128_000, 131_072, 163_840, 196_608, 200_000, 202_752, 204_800, 256_000, 262_144, 327_680, 400_000, 500_000, 512_000, 524_288, 1_000_000, 1_048_576, 2_000_000, 2_097_152];

/** A window as text states it: a whole number from 1,024 to 10 million, else undefined. */
const windowOf = (text) => {
  const number = asNumber(String(text ?? "").replace(/[,_\s]/g, ""));
  return number !== undefined && Number.isInteger(number) && number >= 1_024 && number <= 10_000_000 ? number : undefined;
};

/** Wordings that state the window (the number is the window's, never the request's). */
const WINDOW_WORDINGS = [
  /maximum context length (?:is|of) ([\d,]+) tokens?/i,
  /context (?:window|length) (?:is|of) ([\d,]+) tokens?/i,
  /exceeds? (?:the |this )?(?:model'?s? )?(?:maximum )?context (?:window|length) of ([\d,]+)/i,
  /max_model_len(?: is| of|=| =)? ?([\d,]+)/i,
  /prompt is too long: [\d,]+ tokens? > ([\d,]+) maximum/i,
];

/** The window a refusal's text states, or undefined (an output limit, a key's money: nothing). */
export function contextFromText(text) {
  const value = String(text ?? "");
  for (const pattern of WINDOW_WORDINGS) {
    const match = pattern.exec(value);
    if (match) return windowOf(match[1]);
  }
  return undefined;
}

/** Header names that carry a window (a relay station's `x-grok-context-window`, and the same shape elsewhere). */
const WINDOW_HEADER = /^x-(?:[a-z0-9]+-)?(?:context-window|context-length|max-context-length)$/i;

/** The window an answer's headers state, or undefined. */
export function contextFromHeaders(headers) {
  if (!headers) return undefined;
  let found;
  const visit = (value, name) => {
    if (found === undefined && WINDOW_HEADER.test(name)) found = windowOf(value);
  };
  if (typeof headers.forEach === "function") headers.forEach(visit);
  else if (isRecord(headers)) for (const [name, value] of Object.entries(headers)) visit(value, name);
  return found;
}

/**
 * Whether a refusal is about the request's size alone, so a smaller one would be served: the window
 * in words without a figure, a body too large, or a gateway with no backend for it (a relay station's 503
 * "the model is unavailable"). Never an output limit's wording, a key's money or a rate limit.
 */
export function sizeRefusal(status, text) {
  const value = String(text ?? "");
  if (/max_tokens|max_completion_tokens|max_output_tokens|output tokens|completion tokens|range of/i.test(value)) return false;
  if (status === 413) return true;
  if (status === 503) return /unavailable|not available/i.test(value);
  if (status === 400 || status === 422) return /context|too long|exceed/i.test(value);
  return false;
}

/** The window a search's largest served output points to: the common window just above it, else that output itself. */
export function snapWindow(served) {
  const common = COMMON_WINDOWS.find((window) => window >= served && window - served <= Math.max(512, window * 0.005));
  return common ?? windowOf(served);
}

/** The probe request's body in a protocol, asking for `output` tokens (streamed: a served one is cut at its first byte). */
function probeBody(protocol, model, output) {
  if (protocol === "messages") return { model: model.id, max_tokens: output, stream: true, messages: [{ role: "user", content: PROBE_PROMPT }] };
  if (protocol === "responses") return { model: model.id, input: PROBE_PROMPT, max_output_tokens: output, stream: true };
  return { model: model.id, messages: [{ role: "user", content: PROBE_PROMPT }], max_tokens: output, stream: true };
}

/**
 * Ask the site for one model's window.
 * @param {object} endpoint - the site's endpoint (endpoints.js).
 * @param {object} model - `{ id, protocol? }`.
 * @param {string} [key] - the site's key in use (none for a keyless site).
 * @returns `{ context, from, settled, requests }`: `from` is `probe` (stated), `search` (found by size),
 * `header`; `settled` false when the answer was a passing state (the model down, a rate limit, a timeout)
 * worth asking again later.
 */
export async function probeContext(endpoint, model, key, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const protocol = model.protocol ?? endpoint.protocol;
  if (!["chat", "responses", "messages"].includes(protocol)) return { context: undefined, settled: true, requests: 0, note: "protocol" };
  const url = protocol === "messages" ? `${messagesBaseOf(endpoint, model)}/v1/messages` : protocol === "responses" ? `${endpoint.baseUrl}/responses` : `${endpoint.baseUrl}/chat/completions`;
  const headers = { "content-type": "application/json", ...requestHeaders(endpoint.headers) };
  if (key) {
    headers.authorization = `Bearer ${key}`;
    if (protocol === "messages") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
  }
  let requests = 0;
  /** One request asking for `output` tokens: served (cut off at once), or refused with its words. */
  const attempt = async (output) => {
    requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(probeBody(protocol, model, output)), signal: controller.signal });
      if (response.ok) {
        const header = contextFromHeaders(response.headers);
        controller.abort();
        return { served: true, header };
      }
      return { served: false, status: response.status, text: await response.text().catch(() => "") };
    } catch (error) {
      return { served: false, status: 0, text: error?.name === "AbortError" ? "timeout" : "transport" };
    } finally {
      clearTimeout(timer);
    }
  };
  const passing = (status) => status === 0 || status === 408 || status === 429 || (status >= 500 && status !== 503);
  const first = await attempt(PROBE_OUTPUT);
  // The site took it (clamping the output): no word on the window, unless its headers carry one.
  if (first.served) return first.header ? { context: first.header, from: "header", settled: true, requests } : { context: undefined, settled: true, requests, note: "answered" };
  const stated = contextFromText(first.text);
  if (stated) return { context: stated, from: "probe", settled: true, requests };
  if (!sizeRefusal(first.status, first.text)) return { context: undefined, settled: !passing(first.status), requests, note: `refused ${first.status}` };
  // Refused for its size, the window unnamed: the largest output still served tells it.
  const small = await attempt(SMALL_OUTPUT);
  if (!small.served) return { context: undefined, settled: false, requests, note: `small request refused ${small.status}` };
  let low = SMALL_OUTPUT;
  let high = PROBE_OUTPUT;
  while (high - low > Math.max(16, Math.floor(low * 0.0005)) && requests < 40) {
    const middle = Math.floor((low + high) / 2);
    const step = await attempt(middle);
    if (step.served) low = middle;
    // Only the same refusal marks the boundary; anything else (a rate limit, an outage) ends the search unsettled.
    else if (step.status === first.status && sizeRefusal(step.status, step.text)) high = middle;
    else return { context: undefined, settled: false, requests, note: `search stopped ${step.status}` };
  }
  const context = snapWindow(low);
  return context ? { context, from: "search", settled: true, requests } : { context: undefined, settled: true, requests, note: "too small" };
}
