/**
 * The user's sites (API providers), as the endpoints the gateway, checks
 * and the adapter read.
 *
 * A site is what the add dialog asks for — an id, a display name, the API
 * address, the protocol its models speak by default, optional request headers
 * — plus what the plugin found out about it (`platform`: new-api, Hyper,
 * Vercel, OpenRouter or a plain OpenAI-compatible one; whether its model list
 * is public) and the models the user added. The settings store keeps the
 * sites; this module holds their current endpoints for synchronous lookups
 * ({@link setSites}).
 *
 * Every site is one DSH route `custom-<id>` with many keys; the user's switch
 * groups share one more route, {@link GROUP_ROUTE}.
 *
 * @module dsh-custom-models/endpoints
 */

/**
 * The protocols a site (or one of its models) may be stored with. `gemini`
 * is only read back: a site added with it before 0.2.0 keeps it until the
 * user picks another (Gemini is dsh-intl-models' now).
 */
export const PROTOCOL_IDS = Object.freeze(["chat", "responses", "messages", "gemini"]);
/** The protocols a site may be given: the ones DSH's own custom gateway serves. */
export const OFFERED_PROTOCOLS = Object.freeze(["chat", "responses", "messages"]);
export const PROTOCOL_NAMES = Object.freeze({ chat: "OpenAI Chat Completions", responses: "OpenAI Responses", messages: "Anthropic Messages", gemini: "Google Gemini（已不支持）" });

/** What a site's platform lets a key see (detected when it is added). */
export const PLATFORMS = Object.freeze(["generic", "newapi", "hyper", "vercel", "openrouter"]);
export const PLATFORM_NAMES = Object.freeze({ generic: "OpenAI 兼容", newapi: "new-api", hyper: "Charm Hyper", vercel: "Vercel AI Gateway", openrouter: "OpenRouter" });

const PREFIX = "custom-";
/** The route of the switch groups. */
export const GROUP_ROUTE = "custom-groups";
export const GROUP_NAME = "切换组";

/** A site id: lowercase letters first, then letters, digits and dashes (it names a route and a key file entry). */
export const SITE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** An API address as the protocols use it: no trailing slash, no `/chat/completions` pasted with it. */
export function normalizeBaseUrl(value) {
  let url = String(value ?? "").trim();
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(chat\/completions|responses|messages|completions)$/i, "");
  return url.replace(/\/+$/, "");
}

/** Host names that only resolve on this machine or a local network. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".home.arpa", ".corp"];

/**
 * Whether a host is this machine, a private network or an overlay network:
 * loopback, RFC 1918, CGNAT / Tailscale (100.64.0.0/10), link-local, IPv6
 * unique-local and link-local, `.local`-style names, and single-label names
 * (`nas`, `ollama-box`). Plain HTTP to such a host stays off the internet.
 * @param {string} hostname - `URL.hostname` (IPv6 may keep its brackets).
 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a === 0;
  }
  if (host.includes(":")) {
    return host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
      || /^::ffff:(127|10|192\.168)\./.test(host);
  }
  // A single-label name (no dot) is a LAN or hosts-file name, never a public DNS name.
  return !host.includes(".");
}

/** Whether an address is plain HTTP to a public host: unencrypted across the internet. */
export function isPublicHttp(value) {
  try {
    const url = new URL(normalizeBaseUrl(value));
    return url.protocol === "http:" && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

/** The same address over HTTPS, or null when it is not plain HTTP. */
export function httpsVariant(value) {
  try {
    const url = new URL(normalizeBaseUrl(value));
    if (url.protocol !== "http:") return null;
    url.protocol = "https:";
    // An explicit port is the HTTP server's; HTTPS on that site would be on its default port.
    url.port = "";
    return normalizeBaseUrl(url.toString());
  } catch {
    return null;
  }
}

/** The refusal for public HTTP that was not confirmed (the dialog asks first). */
export const PUBLIC_HTTP_PROBLEM = "这是公网 http 地址（不加密）：确认「我知道这个站点不加密」后才能使用";

/**
 * Why an address cannot be used, or null. HTTPS anywhere; plain HTTP to this
 * machine, a private or overlay network (Ollama, LM Studio, a LAN gateway,
 * Tailscale) as it is; plain HTTP to a public host only once the user
 * confirmed it for this site (`allowHttp`) — the key, the conversation and the
 * model's replies, tool calls included, cross the internet unencrypted.
 * @param {string} value - the address.
 * @param {{allowHttp?: boolean}} [options]
 */
export function baseUrlProblem(value, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(normalizeBaseUrl(value));
  } catch {
    return "API 地址格式不对";
  }
  if (url.username || url.password) return "API 地址不能带用户名或密码";
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "API 地址要以 http:// 或 https:// 开头";
  if (isPrivateHost(url.hostname)) return null;
  return allowHttp ? null : PUBLIC_HTTP_PROBLEM;
}

/** The endpoint one site is. */
export function endpointOf(site) {
  const baseUrl = normalizeBaseUrl(site.baseUrl);
  const platform = PLATFORMS.includes(site.platform) ? site.platform : "generic";
  return {
    id: site.id,
    vendor: "custom",
    platform,
    name: site.name || site.id,
    plan: null,
    baseUrl,
    // Anthropic Messages lives at `<origin>/v1/messages` when the address ends in /v1, else under the address.
    messagesBase: baseUrl.replace(/\/v1$/i, ""),
    // Messages: both ways of presenting the key (Anthropic's x-api-key, the gateways' Bearer).
    messagesAuth: "both",
    protocol: PROTOCOL_IDS.includes(site.protocol) ? site.protocol : "chat",
    headers: site.headers && typeof site.headers === "object" ? { ...site.headers } : {},
    keyless: site.keyless === true,
    enabled: site.enabled !== false,
    // Plain HTTP (no TLS): to a public host only when the user confirmed it for this site.
    plainHttp: baseUrl.startsWith("http:"),
    publicHttp: isPublicHttp(baseUrl),
    // A model list that answers without a valid key cannot prove one.
    modelsPublic: site.modelsPublic === true,
    check: { validity: platform, funds: platform === "generic" ? null : platform, probe: "request" },
    liveModels: true,
  };
}

let SITES = new Map();

/** Replace the known sites (the settings store calls this on every read and write). */
export function setSites(sites) {
  SITES = new Map((Array.isArray(sites) ? sites : []).filter((site) => site && SITE_ID_PATTERN.test(site.id)).map((site) => [site.id, Object.freeze(endpointOf(site))]));
}

/** One site's endpoint by id, or undefined. */
export const endpointById = (id) => SITES.get(id);
/** Every known site id, in the user's order. */
export const siteIds = () => [...SITES.keys()];

/** The DSH route of a site. */
export const routeOf = (siteId) => `${PREFIX}${siteId}`;

/** The site behind a DSH route, or undefined (the group route is no site). */
export function endpointOfRoute(route) {
  if (typeof route !== "string" || !route.startsWith(PREFIX) || route === GROUP_ROUTE) return undefined;
  return SITES.get(route.slice(PREFIX.length));
}

/** The picker's group name: the site plus a marker that it is this plugin's multi-key route. */
export const displayNameOf = (endpoint) => `${endpoint.name}（多 Key）`;

/** The Anthropic Messages host of a model on a site. */
export const messagesBaseOf = (endpoint, entry) => entry?.base ?? endpoint.messagesBase ?? endpoint.baseUrl;

/** A site id from a display name or an address ("Charm Hyper" → "charm-hyper"), unique among `taken`. */
export function suggestSiteId(text, taken = []) {
  let base = String(text ?? "").toLowerCase();
  try {
    if (/^https?:\/\//.test(base)) base = new URL(base).hostname.replace(/^(api|www)\./, "").split(".").slice(0, -1).join("-") || new URL(base).hostname;
  } catch {
    /* plain text */
  }
  base = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 32) || "site";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}
