/**
 * HTTP to the sites for the plugin's own checks: JSON calls (model lists,
 * balances, one tiny request). Conversations go through gateway.js (pi-ai).
 *
 * Three ways to present a key: `bearer` (`Authorization: Bearer …`, what
 * OpenAI-compatible sites read), `anthropic` (`x-api-key` plus
 * `anthropic-version`), `both` (the two at once, for Anthropic Messages on a
 * gateway); a keyless site (a local server) sends none. Every
 * request carries a real User-Agent naming DeepSeek Harness and this plugin.
 * Plain `fetch` is used throughout, so DSH's proxy (HTTPS_PROXY in the
 * environment or `$DSH_HOME/.env`) applies.
 *
 * @module dsh-custom-models/wire
 */
import { cnError, CODES, safeJson } from "./errors.js";

export const VERSION = "0.3.0";
export const USER_AGENT = `deepseek-harness dsh-custom-models/${VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`;
export const ANTHROPIC_VERSION = "2023-06-01";

/** Default wait for a JSON call. */
const JSON_TIMEOUT_MS = 20_000;

/** The headers that present a key. */
export function authHeaders(key, auth = "bearer") {
  // A keyless site (a local server): nothing to present.
  if (!key) return auth === "anthropic" || auth === "both" ? { "anthropic-version": ANTHROPIC_VERSION } : {};
  if (auth === "anthropic") return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  // Anthropic Messages on a gateway: Anthropic's own header and the Bearer the gateways read (both answered live 2026-10-18).
  if (auth === "both") return { authorization: `Bearer ${key}`, "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  return { authorization: `Bearer ${key}` };
}

/** Request headers for one key. */
export function headersFor(key, { auth = "bearer", accept = "application/json", json = false, extra } = {}) {
  return {
    ...authHeaders(key, auth),
    "user-agent": USER_AGENT,
    accept,
    ...(json ? { "content-type": "application/json" } : {}),
    ...extra,
  };
}

/**
 * One JSON request. Never throws on an HTTP error: the caller classifies it.
 * @returns `{ status, ok, body, text, headers }`; status 0 for a transport failure.
 */
export async function requestJson(url, key, { method = "GET", body, auth = "bearer", headers, signal, timeoutMs = JSON_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: headersFor(key, { auth, json: body !== undefined, extra: headers }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, body: safeJson(text), text, headers: response.headers };
  } catch (error) {
    if (signal?.aborted) throw cnError(CODES.aborted, "request aborted");
    const timedOut = timeout.aborted;
    return { status: 0, ok: false, body: undefined, text: timedOut ? "timed out" : String(error?.cause?.code ?? error?.message ?? error), headers: undefined, timedOut };
  }
}
