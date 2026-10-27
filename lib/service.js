/**
 * The `customModels` Remote service the browser half calls: sites (add,
 * edit, remove, order), "获取可用模型" for a saved site or a draft, the
 * models added to each site, their keys (add, check, switch by hand, order,
 * remove), and the switch groups (the member serving each, chosen by hand).
 * Every call returns the whole state, so the tab re-renders from one answer.
 *
 * @module dsh-custom-models/service
 */
import { discover } from "./discovery.js";
import { baseUrlProblem, displayNameOf, endpointById, GROUP_NAME, httpsVariant, isPublicHttp, normalizeBaseUrl, OFFERED_PROTOCOLS, PLATFORM_NAMES, PROTOCOL_IDS, PROTOCOL_NAMES, PUBLIC_HTTP_PROBLEM, routeOf, SITE_ID_PATTERN, suggestSiteId } from "./endpoints.js";
import { asString, cnError, CODES, isRecord, redact, registerSecret } from "./errors.js";
import { defaultMaxTokensOf, effectiveModel, SITE_DEFAULT_CONTEXT, siteDefaultContext, suggestGroupId } from "./models.js";
import { DEFAULT_IMAGE_BUDGET, DEFAULT_IMAGE_MAX_BYTES, imageLimitsOf } from "./request.js";
import { coerceHeaders, coerceModel } from "./store.js";
import { requestJson } from "./wire.js";

/** How long the HTTPS form of a plain-HTTP address gets to answer. */
const HTTPS_PROBE_MS = 6_000;

/**
 * Whether DSH routes plain-HTTP requests through a proxy: DSH's dispatcher
 * proxies each scheme by its own variable, so `http://` uses HTTP_PROXY (or
 * ALL_PROXY) and goes direct when only HTTPS_PROXY is set.
 */
export function httpProxied(env = process.env) {
  return ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((name) => typeof env[name] === "string" && env[name].trim() !== "");
}

/**
 * Does the address also answer over HTTPS? Any HTTP answer counts (a 401 or
 * 404 still proves a TLS server with a valid certificate is there); a refused
 * connection, a timeout or a certificate error does not.
 * @returns the HTTPS address, or null.
 */
async function httpsAlternative(baseUrl, key, { headers, fetchImpl }) {
  const candidate = httpsVariant(baseUrl);
  if (!candidate) return null;
  const response = await requestJson(`${candidate}/models`, key, { headers, fetchImpl, timeoutMs: HTTPS_PROBE_MS }).catch(() => ({ status: 0 }));
  return response.status > 0 ? candidate : null;
}

const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
/** The host service key behind `ctx.remote.customModels`. */
export const SERVICE_KEY = "customModelsKeys";

export const REMOTE_METHODS = Object.freeze([
  "status", "discoverModels", "saveSite", "removeSite", "reorderSites", "setSiteEnabled",
  "addModels", "removeModels", "updateModel",
  "addKeys", "updateKey", "removeKey", "switchKey", "reorderKeys", "checkKeys",
  "saveGroup", "removeGroup", "switchGroup",
]);

/** At most this many keys in one paste. */
const MAX_KEYS_PER_ADD = 50;

/** Keys in pasted text: one per line (or separated by spaces / commas), `#` comments and `名称: key` prefixes allowed. */
export function parseKeyLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    // An address pasted with the keys (the site's own page often shows both) is no key.
    if (!line || line.startsWith("#") || /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue;
    for (const token of line.replace(/^[^:：\s]{1,30}[:：]\s*(?=\S{16,})/, "").split(/[\s,，;；]+/)) {
      const key = token.trim().replace(/^["'`]|["'`]$/g, "");
      if (key.length >= 8 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key) && !/^https?:/i.test(key) && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

/** What the tab shows of a site (no secrets). */
function siteView(site, unusable) {
  const endpoint = endpointById(site.id);
  return {
    id: site.id,
    route: routeOf(site.id),
    name: site.name,
    displayName: endpoint ? displayNameOf(endpoint) : site.name,
    baseUrl: site.baseUrl,
    host: (() => {
      try {
        return new URL(site.baseUrl).host;
      } catch {
        return site.baseUrl;
      }
    })(),
    protocol: site.protocol,
    platform: site.platform,
    platformName: PLATFORM_NAMES[site.platform] ?? site.platform,
    platformInfo: site.platformInfo ?? null,
    headers: site.headers,
    modelsPublic: site.modelsPublic,
    keyless: site.keyless,
    enabled: site.enabled !== false,
    // Plain HTTP: to a public host only after the user confirmed it; whether DSH proxies it.
    plainHttp: String(site.baseUrl).startsWith("http:"),
    publicHttp: isPublicHttp(site.baseUrl),
    allowHttp: site.allowHttp === true,
    httpProxied: String(site.baseUrl).startsWith("http:") ? httpProxied() : null,
    showsBalance: Boolean(endpoint?.check?.funds),
    addedAt: site.addedAt,
    detectedAt: site.detectedAt,
    // The site's limits: what the user set (null: DSH's default applies), what a 413 taught, and what applies now.
    limits: {
      defaultContext: site.defaultContext ?? null,
      imageBudget: site.imageBudget ?? null,
      imageBudgetLearned: site.imageBudgetLearned ?? null,
      imageMaxBytes: site.imageMaxBytes ?? null,
      applied: { defaultContext: siteDefaultContext(site), imageBudget: imageLimitsOf(site).budget, imageMaxBytes: imageLimitsOf(site).maxBytes },
      defaults: { defaultContext: SITE_DEFAULT_CONTEXT, imageBudget: DEFAULT_IMAGE_BUDGET, imageMaxBytes: DEFAULT_IMAGE_MAX_BYTES },
    },
    // false: a finished answer carried no token usage (DSH then prices requests itself).
    usageReported: typeof site.usageReported === "boolean" ? site.usageReported : null,
    models: site.models.map((model) => {
      const full = effectiveModel(model, site);
      const maxTokens = defaultMaxTokensOf(full);
      return {
        id: model.id,
        name: full.name,
        protocol: model.protocol ?? null,
        // The context requests and DSH use; where it came from; the reference's own figure when capped.
        context: full.context ?? null,
        contextOrigin: full.contextOrigin,
        contextListed: full.contextListed ?? null,
        // Where DSH compacts by default: min(80 % of the window, window − default output − 65,536).
        compactAt: full.context ? Math.max(0, Math.floor(Math.min(full.context * 0.8, full.context - maxTokens - 65_536))) : null,
        output: full.output ?? null,
        image: full.image === true,
        reasoning: full.reasoning ?? null,
        cost: model.cost ?? null,
        flags: model.flags ?? null,
        source: model.source,
        unusable: unusable?.[site.id]?.[model.id] ?? null,
        // What was stored, for the edit dialog (the rest is filled in from the reference).
        own: model,
      };
    }),
  };
}

/**
 * @param {object} deps - `{ keys, settings, adapter, checker, onRoutesChanged, onModelsChanged, log, fetchImpl }`.
 * @returns the Remote service.
 */
export function createCustomModelsService({ keys, settings, adapter, checker, onRoutesChanged = () => {}, onModelsChanged = () => {}, log = () => {}, fetchImpl = fetch }) {
  async function status() {
    const [summary, state] = await Promise.all([keys.summary(), settings.read()]);
    for (const record of await keys.keys()) registerSecret(record.key);
    const unusable = adapter.unusableModels();
    return {
      ...summary,
      sites: state.sites.map((site) => siteView(site, unusable)),
      groups: state.groups.map((group) => ({ ...group, route: "custom-groups" })),
      groupName: GROUP_NAME,
      protocols: OFFERED_PROTOCOLS.map((id) => ({ id, name: PROTOCOL_NAMES[id] })),
    };
  }

  const requireSite = async (siteId) => {
    const site = await settings.site(siteId);
    if (!site) throw cnError(CODES.badRequest, `站点 ${siteId} 不存在`);
    return site;
  };

  /** Add keys to a site and check each (validity and balance; a public model list gets one tiny request). */
  async function addKeysTo(site, text, label) {
    const found = parseKeyLines(text);
    if (found.length === 0) throw cnError(CODES.badRequest, "没有找到 API Key（每行一个）");
    if (found.length > MAX_KEYS_PER_ADD) throw cnError(CODES.badRequest, `一次最多添加 ${MAX_KEYS_PER_ADD} 个 Key`);
    const added = [];
    for (const key of found) {
      registerSecret(key);
      const { record, created } = await keys.add({ endpoint: site.id, key, label: found.length === 1 ? label : undefined, source: "paste" });
      added.push({ id: record.id, created });
    }
    // The first key added to a site with no active key becomes active (the store does that); checks run after.
    for (const item of added) await checker.check(item.id, { mode: "auto" }).catch(() => undefined);
    const summary = await keys.summary();
    return added.map((item) => {
      const view = summary.keys.find((key) => key.id === item.id);
      return { ok: true, id: item.id, created: item.created, masked: view?.masked, status: view?.status, statusMessage: view?.statusMessage, balance: view?.balance ?? null, probeError: view?.probeError ?? null };
    });
  }

  const service = {
    status,

    /**
     * "获取可用模型" for a saved site (`siteId`, its active key unless one is given) or a draft
     * (`baseUrl`, `protocol`, `key`, `headers`).
     */
    async discoverModels(request) {
      let draft;
      if (request.siteId) {
        const site = await requireSite(request.siteId);
        const active = await keys.active(site.id);
        draft = { baseUrl: request.baseUrl ?? site.baseUrl, protocol: request.protocol ?? site.protocol, headers: request.headers ?? site.headers, key: request.key ?? active?.key, allowHttp: request.allowHttp ?? site.allowHttp === true };
      } else {
        if (!asString(request.baseUrl)) throw cnError(CODES.badRequest, "请先填写 API 地址");
        draft = { baseUrl: request.baseUrl, protocol: request.protocol ?? "chat", headers: coerceHeaders(request.headers), key: asString(request.key) ? parseKeyLines(request.key)[0] : undefined, allowHttp: request.allowHttp === true };
      }
      if (draft.key) registerSecret(draft.key);
      // Public plain HTTP: first see whether the same site answers over HTTPS (many do), and
      // offer that instead; without the user's confirmation nothing is sent over plain HTTP.
      const publicHttp = isPublicHttp(draft.baseUrl);
      const alternative = publicHttp ? await httpsAlternative(normalizeBaseUrl(draft.baseUrl), draft.key, { headers: draft.headers, fetchImpl }) : null;
      if (publicHttp && !draft.allowHttp) {
        return { ...(await status()), discovered: { ok: false, models: [], error: PUBLIC_HTTP_PROBLEM, needsHttpConfirm: true, httpsAlternative: alternative } };
      }
      const found = { ...(await discover(draft, { fetchImpl })), ...(publicHttp ? { httpsAlternative: alternative } : {}) };
      if (request.siteId && found.ok) {
        // What a saved site turned out to be is kept (its platform decides how balances are read).
        await settings.updateSite(request.siteId, { platform: found.platform, platformInfo: found.platformInfo ?? undefined, modelsPublic: found.modelsPublic, detectedAt: new Date().toISOString() });
      }
      const added = request.siteId ? new Set((await settings.site(request.siteId))?.models.map((model) => model.id)) : new Set();
      return { ...(await status()), discovered: { ...found, models: (found.models ?? []).map((model) => ({ ...model, added: added.has(model.id) })), error: found.error ? redact(found.error) : null } };
    },

    /**
     * Add a site, or change one (`id` of a saved site). A new site may bring its keys (`keys`, one
     * per line) and its models (`models`, as discovered and chosen); `detected` carries what
     * "获取可用模型" found (platform, quota unit, whether the model list is public).
     */
    async saveSite(request) {
      const sites = await settings.sites();
      const existing = request.id ? sites.find((site) => site.id === request.id) : undefined;
      const baseUrl = normalizeBaseUrl(request.baseUrl ?? existing?.baseUrl);
      // Public plain HTTP needs this site's own confirmation (kept with the site; dropped once
      // the address is HTTPS or private again).
      const allowHttp = isPublicHttp(baseUrl) && (request.allowHttp ?? existing?.allowHttp) === true;
      const problem = baseUrlProblem(baseUrl, { allowHttp });
      if (problem) throw cnError(CODES.badRequest, problem);
      const protocol = request.protocol ?? existing?.protocol ?? "chat";
      // A protocol given now must be one DSH's custom gateway serves; a Gemini site saved before 0.2.0 may keep its own until changed.
      if (request.protocol !== undefined ? !OFFERED_PROTOCOLS.includes(protocol) : !PROTOCOL_IDS.includes(protocol)) {
        throw cnError(CODES.badRequest, protocol === "gemini" ? "Gemini 协议已不支持：Gemini 请在「国际模型」插件里使用，这个站点请改用 OpenAI 兼容协议" : `不支持的协议 ${protocol}`);
      }
      const name = asString(request.name?.trim?.()) ? request.name.trim().slice(0, 60) : existing?.name ?? new URL(baseUrl).host;
      const detected = isRecord(request.detected) ? request.detected : null;
      // The site's limits: a number sets one, null goes back to DSH's default. A budget the user sets
      // replaces the one a 413 taught; `resetImageBudget` drops the taught one alone.
      const limits = {};
      for (const field of ["defaultContext", "imageBudget", "imageMaxBytes"]) if (request[field] !== undefined) limits[field] = request[field];
      if (request.imageBudget !== undefined || request.resetImageBudget === true) limits.imageBudgetLearned = null;
      const fields = {
        name,
        baseUrl,
        protocol,
        ...(request.headers !== undefined ? { headers: coerceHeaders(request.headers) } : {}),
        ...(typeof request.keyless === "boolean" ? { keyless: request.keyless } : {}),
        allowHttp,
        ...limits,
        ...(detected ? { platform: detected.platform, platformInfo: detected.platformInfo ?? undefined, modelsPublic: detected.modelsPublic === true, detectedAt: new Date().toISOString() } : {}),
      };
      let siteId;
      if (existing) {
        siteId = existing.id;
        const moved = baseUrl !== existing.baseUrl;
        // Another address may be another platform: it is found out again when nothing was detected.
        if (moved && !detected) Object.assign(fields, { platform: "generic", platformInfo: undefined, modelsPublic: false });
        await settings.updateSite(siteId, fields);
        if (moved) {
          adapter.clearUnusable(siteId);
          for (const record of await keys.keysFor(siteId)) await keys.patch(record.id, { status: "unknown", statusMessage: null, balance: undefined, limitedUntil: undefined, limitedReason: undefined, limitedScope: undefined, probedAt: undefined });
        }
      } else {
        siteId = asString(request.newId) ? request.newId.trim() : suggestSiteId(/[a-z]/i.test(name) ? name : baseUrl, sites.map((site) => site.id));
        if (!SITE_ID_PATTERN.test(siteId)) throw cnError(CODES.badRequest, "Provider ID 要以小写字母开头，只能有小写字母、数字和连字符（最长 40）");
        if (sites.some((site) => site.id === siteId)) throw cnError(CODES.badRequest, `Provider ID ${siteId} 已被使用`);
        const result = await settings.addSite({ id: siteId, models: [], headers: {}, platform: "generic", ...fields });
        if (!result?.ok) throw cnError(CODES.badRequest, result?.error ?? "站点没有保存");
      }
      if (Array.isArray(request.models) && request.models.length) await settings.addModels(siteId, request.models);
      let addedKeys = [];
      if (asString(request.keys) && parseKeyLines(request.keys).length) addedKeys = await addKeysTo(await settings.site(siteId), request.keys);
      onRoutesChanged();
      onModelsChanged();
      return { ...(await status()), saved: siteId, addedKeys };
    },

    async removeSite(request) {
      await requireSite(request.siteId);
      await settings.removeSite(request.siteId);
      await keys.removeSite(request.siteId);
      adapter.clearUnusable(request.siteId);
      onRoutesChanged();
      return status();
    },

    async reorderSites(request) {
      await settings.reorderSites(request.siteIds);
      onRoutesChanged();
      return status();
    },

    /** Switch a site on or off by hand: off, its models leave the model picker; its keys and models stay. */
    async setSiteEnabled(request) {
      await requireSite(request.siteId);
      await settings.updateSite(request.siteId, { enabled: request.enabled });
      onRoutesChanged();
      onModelsChanged();
      return status();
    },

    async addModels(request) {
      await requireSite(request.siteId);
      const models = request.models.map(coerceModel).filter(Boolean);
      if (models.length === 0) throw cnError(CODES.badRequest, "没有要添加的模型");
      await settings.addModels(request.siteId, models);
      adapter.clearUnusable(request.siteId);
      onModelsChanged();
      return status();
    },

    async removeModels(request) {
      await requireSite(request.siteId);
      await settings.removeModels(request.siteId, request.modelIds);
      onModelsChanged();
      onRoutesChanged();
      return status();
    },

    /** Edit one model: fields given replace the stored ones, `null` clears one (back to the site's or the reference's). */
    async updateModel(request) {
      const site = await requireSite(request.siteId);
      const patch = { ...request.patch };
      // The dialog sends every field: a context left as shown keeps its origin (a capped reference
      // figure stays capped); a changed one is the user's word; null goes back to the site's or the reference's.
      if (Object.hasOwn(patch, "context")) {
        const stored = site.models.find((model) => model.id === request.modelId);
        if (patch.context === null) patch.contextFrom = null;
        else if (stored && patch.context === effectiveModel(stored, site).context) delete patch.context;
        else patch.contextFrom = "user";
      }
      const checked = coerceModel({ id: request.modelId, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)) });
      const next = {};
      for (const [field, value] of Object.entries(patch)) next[field] = value === null ? null : checked?.[field];
      if (!(await settings.updateModel(request.siteId, request.modelId, next))) throw cnError(CODES.badRequest, `站点上没有模型 ${request.modelId}`);
      adapter.clearUnusable(request.siteId);
      onModelsChanged();
      return status();
    },

    async addKeys(request) {
      const site = await requireSite(request.siteId);
      const added = await addKeysTo(site, request.text, request.label);
      adapter.clearUnusable(site.id);
      onRoutesChanged();
      return { ...(await status()), added };
    },

    async updateKey(request) {
      if (!(await keys.update(request.keyId, { label: request.label }))) throw cnError(CODES.badRequest, "Key 不存在");
      return status();
    },

    async removeKey(request) {
      if (!(await keys.remove(request.keyId))) throw cnError(CODES.badRequest, "Key 不存在");
      onRoutesChanged();
      return status();
    },

    /** Make one key its site's active key: the only way keys switch here. */
    async switchKey(request) {
      const record = await keys.get(request.keyId);
      if (!record) throw cnError(CODES.badRequest, "Key 不存在");
      await keys.setActive(record.id);
      adapter.clearUnusable(record.endpoint);
      return status();
    },

    async reorderKeys(request) {
      await keys.reorder(request.siteId, request.keyIds);
      return status();
    },

    /**
     * Re-check keys (named ones, one site's, or all — every site switched on): `mode` validity /
     * funds / auto; `deep` adds one tiny request.
     */
    async checkKeys(request) {
      const all = await keys.keys();
      const on = new Set((await settings.sites()).filter((site) => site.enabled !== false).map((site) => site.id));
      const chosen = Array.isArray(request.keyIds) && request.keyIds.length ? all.filter((record) => request.keyIds.includes(record.id))
        : request.siteId ? all.filter((record) => record.endpoint === request.siteId) : all.filter((record) => on.has(record.endpoint));
      const checked = [];
      for (const record of chosen) checked.push(await checker.check(record.id, { mode: request.mode ?? "auto", deep: request.deep === true }));
      return { ...(await status()), checked };
    },

    /** Add a switch group, or change one (`id`): its name, its members (site + model), the one serving it. */
    async saveGroup(request) {
      const sites = await settings.sites();
      const members = request.members.filter((member) => sites.some((site) => site.id === member.site));
      if (members.length === 0) throw cnError(CODES.badRequest, "切换组至少要有一个成员（站点上的模型）");
      const groups = await settings.groups();
      const name = asString(request.name?.trim?.()) ? request.name.trim().slice(0, 60) : members[0].model;
      const id = request.id && groups.some((group) => group.id === request.id) ? request.id : suggestGroupId(name, groups.map((group) => group.id));
      const active = Number.isInteger(request.active) && request.active >= 0 && request.active < members.length ? request.active : 0;
      const result = await settings.saveGroup({ id, name, members, active });
      if (!result?.ok) throw cnError(CODES.badRequest, result?.error ?? "切换组没有保存");
      onRoutesChanged();
      onModelsChanged();
      return { ...(await status()), savedGroup: id };
    },

    async removeGroup(request) {
      await settings.removeGroup(request.groupId);
      onRoutesChanged();
      return status();
    },

    /** Choose the member serving a switch group from the next request on. */
    async switchGroup(request) {
      if (!(await settings.setGroupActive(request.groupId, request.index))) throw cnError(CODES.badRequest, "切换组或成员不存在");
      onModelsChanged();
      return status();
    },
  };

  // SRC discovery reads the methods from the PROTOTYPE and derives wire
  // parameters from each signature: plain identifiers, `signal` last.
  const prototype = {};
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) }))),
    }),
  });
  const wrap = (method) => async function remote(request, signal) {
    try {
      return await service[method](isRecord(request) ? request : {}, signal);
    } catch (error) {
      log("warn", `${method} failed: ${redact(error?.message ?? error)}`);
      const failure = new Error(redact(error?.message ?? error));
      failure.isDSHRemoteError = true;
      failure.code = `custom-models/${String(error?.code ?? "error").toLowerCase()}`;
      failure.details = {};
      throw failure;
    }
  };
  for (const method of REMOTE_METHODS) {
    Object.defineProperty(prototype, method, { value: wrap(method), writable: true, configurable: true });
  }
  const remote = Object.create(prototype);
  Object.defineProperty(remote, "typertRemote", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service: remote, serviceKey: SERVICE_KEY, namespace: "customModels" },
  });
  return remote;
}
