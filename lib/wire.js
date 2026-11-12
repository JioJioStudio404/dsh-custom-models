/**
 * HTTP to the sites for the plugin's own checks: JSON calls (model lists,
 * balances, one tiny request). Conversations go through gateway.js (pi-ai).
 *
 * Three ways to present a key: `bearer` (`Authorization: Bearer …`, what
 * OpenAI-compatible sites read), `anthropic` (`x-api-key` plus
 * `anthropic-version`), `both` (the two at once, for Anthropic Messages on a
 * gateway); a keyless site (a local server) sends none. Every
 * request carries DeepSeek Harness's own User-Agent product token, as DSH's
 * own adapters send it (`deepseek-harness/<version>`, its LLM package's
 * `attributionHeaders()`: every provider request must carry it), then this
 * plugin's. Relay stations that serve listed coding clients only tell DSH by
 * that token (live 2026-11-10: `deepseek-harness dsh-custom-models/…`, the
 * token without its version, was refused as an unsupported client).
 * Plain `fetch` is used throughout, so DSH's proxy (HTTPS_PROXY in the
 * environment or `$DSH_HOME/.env`) applies.
 *
 * @module dsh-custom-models/wire
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { cnError, CODES, safeJson } from "./errors.js";

export const VERSION = "0.8.0";

/**
 * DeepSeek Harness's own version — its LLM package's, the one DSH's adapters name — read where the host process
 * resolves it: from its entry (the desktop host, the CLI), else from its working directory (the profile). Null
 * outside DSH (a test).
 */
export function harnessVersion({ argv = process.argv, cwd = process.cwd() } = {}) {
  for (const from of [argv?.[1], join(cwd, "package.json")]) {
    if (typeof from !== "string" || !from) continue;
    try {
      const version = createRequire(from)("@deepseek-ai/dsh-llm/package.json")?.version;
      if (typeof version === "string" && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version)) return version;
    } catch {
      /* not resolvable from there */
    }
  }
  return null;
}

/** The version named when the host's cannot be read: the oldest DeepSeek Harness this plugin runs on (my choice). */
const HARNESS_FALLBACK = "0.2.2";
export const HARNESS_VERSION = harnessVersion() ?? HARNESS_FALLBACK;
export const USER_AGENT = `deepseek-harness/${HARNESS_VERSION} dsh-custom-models/${VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`;
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
 * A response body read up to `maxBytes`: past that the read stops at once (the rest is never held in memory) and
 * `tooLarge` is set. A body that cannot be streamed is read whole and measured.
 * @returns `{ bytes: Buffer, tooLarge: boolean }`
 */
export async function readCapped(response, maxBytes) {
  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > maxBytes ? { bytes: Buffer.alloc(0), tooLarge: true } : { bytes, tooLarge: false };
  }
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.alloc(0), tooLarge: true };
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return { bytes: Buffer.concat(chunks), tooLarge: false };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Redirects followed within one origin at most. */
const MAX_REDIRECTS = 5;

/** The answer that stands for a redirect not followed: the site's status, a body saying why. */
function refusedRedirect(response, target) {
  const message = target
    ? `站点将请求重定向至其他来源（${target}）；为避免密钥随请求发往该来源，未跟随该重定向`
    : "站点的重定向未被跟随（次数过多，或请求内容无法重发）";
  return new Response(JSON.stringify({ error: { message, type: "redirect_refused" } }), {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "application/json" },
  });
}

/**
 * fetch that follows a redirect only within the request's origin (scheme, host and port). The headers that present a
 * key go with every hop that is followed — Node's fetch drops `Authorization` on a cross-origin redirect but keeps
 * `x-api-key` and a site's own headers — so a redirect to another origin, or from HTTPS to HTTP, is not followed: it
 * comes back as the site's answer with its status, its body saying why. The same host from HTTP to HTTPS is followed
 * (an upgrade: the key stays with the host). 307 and 308 repeat the request as it was;
 * 303, and 301 / 302 after a POST, continue with a GET (as fetch does). A body that is not text (a stream) is not
 * sent twice.
 * @param {Function} fetchImpl - the fetch to call (DSH's proxy applies to the global one).
 */
export async function fetchSameOrigin(fetchImpl, url, init = {}) {
  let current = String(url);
  let method = String(init.method ?? "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current, { ...init, method, body, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.("location") : null;
    if (!location) return response;
    let target;
    try {
      target = new URL(location, current);
    } catch {
      return response;
    }
    try {
      await response.body?.cancel();
    } catch {
      /* nothing to drain */
    }
    const from = new URL(current);
    // The same origin, or the same host moving from HTTP to HTTPS (the key stays with the host, now encrypted; my choice).
    const upgrade = from.protocol === "http:" && target.protocol === "https:" && from.hostname === target.hostname;
    if (target.origin !== from.origin && !upgrade) return refusedRedirect(response, target.origin);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    const replayable = body === undefined || body === null || typeof body === "string";
    if (hop >= MAX_REDIRECTS || !replayable) return refusedRedirect(response, null);
    current = target.href;
  }
}

/**
 * One JSON request. Never throws on an HTTP error: the caller classifies it. Redirects are followed within the
 * site's origin only ({@link fetchSameOrigin}).
 * @returns `{ status, ok, body, text, headers }`; status 0 for a transport failure.
 */
export async function requestJson(url, key, { method = "GET", body, auth = "bearer", headers, signal, timeoutMs = JSON_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchSameOrigin(fetchImpl, url, {
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
