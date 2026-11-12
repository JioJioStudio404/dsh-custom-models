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
import { baseUrlProblem, displayNameOf, endpointById, GROUP_NAME, httpsVariant, isPublicHttp, normalizeBaseUrl, OFFERED_PROTOCOLS, PLATFORM_NAMES, PROTOCOL_IDS, PROTOCOL_NAMES, PUBLIC_HTTP_PROBLEM, routeOf, RESERVED_SITE_IDS, SITE_ID_PATTERN, suggestSiteId } from "./endpoints.js";
import { asString, cnError, CODES, isRecord, redact, registerSecret } from "./errors.js";
import { defaultMaxTokensOf, effectiveModel, SITE_DEFAULT_CONTEXT, siteDefaultContext, suggestGroupId, switchLimitOf } from "./models.js";
import { PROBE_VERSION, probeContext } from "./context.js";
import { applyDiscovery, DESCRIBE_VERSION } from "./refresh.js";
import { usageReport } from "./usage.js";
import { relayReport } from "./relay/sync.js";
import { DEFAULT_IMAGE_BUDGET, DEFAULT_IMAGE_MAX_BYTES, imageLimitsOf } from "./request.js";
import { coerceHeaders, coerceModel } from "./store.js";
import { requestJson, VERSION } from "./wire.js";

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
  // Model authenticity checks (authn/).
  "authnSession", "authnReport", "authnTrack", "authnSettings", "authnProbe", "authnCancel", "authnRules", "authnClear", "setSiteAuthn", "setSiteAccount",
]);

/** At most this many keys in one paste. */
const MAX_KEYS_PER_ADD = 50;
/** An address's origin (scheme, host, port), or null when it is no URL. */
const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

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

/** Whether a site's answers carry usage: per model where known (false, true, or "mixed"), else the site's last word. */
function usageReportedOf(site) {
  const known = site.models.map((model) => model.usageReported).filter((value) => typeof value === "boolean");
  if (known.length === 0) return typeof site.usageReported === "boolean" ? site.usageReported : null;
  if (known.every((value) => value === false)) return false;
  return known.some((value) => value === false) ? "mixed" : true;
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
    // Taking part in model authenticity checks (authn/; off by hand).
    authn: site.authn !== false,
    // Plain HTTP: to a public host only after the user confirmed it; whether DSH proxies it.
    plainHttp: String(site.baseUrl).startsWith("http:"),
    publicHttp: isPublicHttp(site.baseUrl),
    allowHttp: site.allowHttp === true,
    httpProxied: String(site.baseUrl).startsWith("http:") ? httpProxied() : null,
    showsBalance: Boolean(endpoint?.check?.funds),
    addedAt: site.addedAt,
    detectedAt: site.detectedAt,
    // The site's limits: what the user set (null: the default applies), what a 413 taught, and what applies now.
    limits: {
      defaultContext: site.defaultContext ?? null,
      imageBudget: site.imageBudget ?? null,
      imageBudgetLearned: site.imageBudgetLearned ?? null,
      imageMaxBytes: site.imageMaxBytes ?? null,
      applied: { defaultContext: siteDefaultContext(site), imageBudget: imageLimitsOf(site).budget, imageMaxBytes: imageLimitsOf(site).maxBytes },
      defaults: { defaultContext: SITE_DEFAULT_CONTEXT, imageBudget: DEFAULT_IMAGE_BUDGET, imageMaxBytes: DEFAULT_IMAGE_MAX_BYTES },
    },
    // false: no answer carries token usage (DSH then prices requests itself); "mixed": some models' do not.
    usageReported: usageReportedOf(site),
    models: site.models.map((model) => {
      const full = effectiveModel(model, site);
      const maxTokens = defaultMaxTokensOf(full);
      return {
        id: model.id,
        name: full.name,
        protocol: model.protocol ?? null,
        // The protocols the relay serves it in (null: the site does not say).
        endpoints: model.endpoints ?? null,
        // The context requests and DSH use; where it came from; the reference's own figure when capped.
        context: full.context ?? null,
        contextOrigin: full.contextOrigin,
        contextListed: full.contextListed ?? null,
        // The window the site suggests working within (shown only).
        contextSuggested: model.contextSuggested ?? null,
        // How a window the site showed was learned: header, error, probe.
        contextMeasured: model.contextFrom === "measured" ? model.contextMeasured ?? null : null,
        // Whether this model's answers carry token usage (null: not seen yet).
        usageReported: typeof model.usageReported === "boolean" ? model.usageReported : null,
        // Where DSH compacts by default: min(80 % of the window, window − default output − 65,536).
        compactAt: full.context ? Math.max(0, Math.floor(Math.min(full.context * 0.8, full.context - maxTokens - 65_536))) : null,
        // DSH 0.2.2 refuses a midway switch to it: its window cannot hold the default compaction headroom.
        switchLimit: switchLimitOf(full),
        output: full.output ?? null,
        image: full.image === true,
        // The site refused this model's images (learned): it is offered as text only.
        imageRefused: model.imageRefused === true,
        reasoning: full.reasoning ?? null,
        cost: model.cost ?? null,
        // The price the user set (estimates use it before the site's `cost`).
        price: model.price ?? null,
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
 * @param {object} deps - `{ keys, settings, adapter, checker, usage, authn, onRoutesChanged, onModelsChanged, log, fetchImpl }` (`usage`: the UsageLedger; `authn`: model authenticity checks).
 * @returns the Remote service.
 */
/** A switch group's switch limit is its selected member's: DSH sees the group route with that member's window. */
function groupSwitchLimit(group, sites) {
  const member = group.members[group.active] ?? group.members[0];
  const site = sites.find((item) => item.id === member?.site);
  const model = site?.models.find((item) => item.id === member?.model);
  return model ? switchLimitOf(effectiveModel(model, site)) : null;
}

export function createCustomModelsService({ keys, settings, adapter, checker, usage, authn, relay, onRoutesChanged = () => {}, onModelsChanged = () => {}, log = () => {}, fetchImpl = fetch }) {
  async function status() {
    const [summary, state, days, relayState, records] = await Promise.all([keys.summary(), settings.read(), usage ? usage.days().catch(() => null) : null, relay ? relay.store.read().catch(() => null) : null, keys.keys()]);
    for (const record of await keys.keys()) registerSecret(record.key);
    for (const site of state.sites) {
      const account = await keys.account(site.id);
      if (account?.token) registerSecret(account.token);
    }
    const unusable = adapter.unusableModels();
    return {
      ...summary,
      // The host half running (the page compares its own: a link install updates the page on reload, the host on restart).
      version: VERSION,
      sites: state.sites.map((site) => siteView(site, unusable)),
      // What each site's models used (today, 7 and 30 days, the last 30 days one by one), priced now.
      usage: days ? usageReport(days, state.sites) : null,
      // What relay systems tell beside the balance (relay/): what the site billed, the key's group, the site's figures.
      relay: relayState ? relayReport(relayState, state.sites, records) : null,
      groups: state.groups.map((group) => ({ ...group, route: "custom-groups", switchLimit: groupSwitchLimit(group, state.sites) })),
      groupName: GROUP_NAME,
      protocols: OFFERED_PROTOCOLS.map((id) => ({ id, name: PROTOCOL_NAMES[id] })),
      // Model checks on (authn/): the page shows a site's "take part" switch only then.
      authnEnabled: authn?.enabled?.() === true,
    };
  }

  /**
   * Ask the site for the windows of its added models (all, or `modelIds`) that neither its list nor the
   * user states: in the background, three at a time, one run per site. A probe is refused for free where
   * the site checks the output against the window; it never marks a key. `pendingOnly`: only models not
   * asked with the current probe yet (after a start). A model whose answer was settled is marked asked.
   */
  const probing = new Map();
  function probeWindows(siteId, modelIds, { pendingOnly = false } = {}) {
    if (probing.has(siteId)) return probing.get(siteId);
    const run = (async () => {
      const site = await settings.site(siteId);
      const endpoint = endpointById(siteId);
      if (!site || !endpoint || site.enabled === false) return 0;
      const active = await keys.active(siteId);
      if (!active && !site.keyless) return 0;
      const targets = site.models.filter((model) => (!modelIds || modelIds.includes(model.id)) && model.contextFrom !== "site" && model.contextFrom !== "user" && (!pendingOnly || (model.contextProbe ?? 0) < PROBE_VERSION));
      let learned = 0;
      for (let index = 0; index < targets.length; index += 3) {
        const results = await Promise.all(targets.slice(index, index + 3).map(async (model) => ({ model, result: await probeContext(endpoint, model, active?.key, { fetchImpl }) })));
        for (const { model, result } of results) {
          const fresh = (await settings.site(siteId))?.models.find((item) => item.id === model.id);
          if (!fresh) continue;
          const asked = result.settled ? { contextProbe: PROBE_VERSION } : {};
          const takes = result.context && fresh.contextFrom !== "site" && fresh.contextFrom !== "user" && !(fresh.contextFrom === "measured" && fresh.context === result.context);
          if (takes) learned += 1;
          const patch = { ...asked, ...(takes ? { context: result.context, contextFrom: "measured", contextMeasured: result.from } : {}) };
          if (Object.keys(patch).length) await settings.updateModel(siteId, model.id, patch, { keepSource: true });
          log("info", `${siteId}/${model.id}: window probe ${result.context ? `${result.context} (${result.from})` : result.note ?? "nothing"}, ${result.requests} request(s)${result.settled ? "" : ", asked again later"}`);
        }
      }
      log("info", `${siteId}: ${targets.length} window probe(s), ${learned} learned`);
      if (learned) onModelsChanged();
      return learned;
    })().catch((error) => {
      log("warn", `${siteId}: window probes failed: ${redact(error?.message ?? error)}`);
      return 0;
    }).finally(() => probing.delete(siteId));
    probing.set(siteId, run);
    return run;
  }

  const requireSite = async (siteId) => {
    const site = await settings.site(siteId);
    if (!site) throw cnError(CODES.badRequest, `站点 ${siteId} 不存在`);
    return site;
  };

  /** Add keys to a site and check each (validity and balance; a public model list gets one tiny request). */
  async function addKeysTo(site, text, label) {
    const found = parseKeyLines(text);
    if (found.length === 0) throw cnError(CODES.badRequest, "未识别到 API Key（每行填写一个）");
    if (found.length > MAX_KEYS_PER_ADD) throw cnError(CODES.badRequest, `单次最多添加 ${MAX_KEYS_PER_ADD} 个 Key`);
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
      // A saved relay site is priced at its active key's group (new-api: its log tells which).
      const active = request.siteId ? await keys.active(request.siteId) : null;
      const group = active && relay && !request.key ? (await relay.store.read()).keys[active.id]?.log?.group ?? undefined : undefined;
      const found = { ...(await discover(draft, { fetchImpl, group })), ...(publicHttp ? { httpsAlternative: alternative } : {}) };
      if (request.siteId && found.ok) {
        // What a saved site turned out to be is kept (its platform decides how balances are read),
        // and the models it already has are described again from its list (edits stay).
        if (await applyDiscovery(settings, request.siteId, found)) onModelsChanged();
        // And the site is asked for the windows its list does not state.
        void probeWindows(request.siteId);
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
        throw cnError(CODES.badRequest, protocol === "gemini" ? "已停止支持 Gemini 协议：请通过 Intl_Ex 插件使用 Gemini，并将该站点改为 OpenAI 兼容协议" : `不支持的协议 ${protocol}`);
      }
      const name = asString(request.name?.trim?.()) ? request.name.trim().slice(0, 60) : existing?.name ?? new URL(baseUrl).host;
      const detected = isRecord(request.detected) ? request.detected : null;
      // The site's limits: a number sets one, null goes back to the default. A budget the user sets
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
        // Models chosen from a list read just now are described the current way.
        ...(detected ? { platform: detected.platform, platformInfo: detected.platformInfo ?? undefined, modelsPublic: detected.modelsPublic === true, detectedAt: new Date().toISOString(), ...(existing ? {} : { describedVersion: DESCRIBE_VERSION }) } : {}),
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
          // The account token was given for the site's former origin: it is not sent to another (the user sets it again).
          if (originOf(baseUrl) !== originOf(existing.baseUrl) && (await keys.account(siteId))) {
            await keys.setAccount(siteId, {});
            await relay?.store.update((state) => { if (state.sites[siteId]) delete state.sites[siteId].account; }).catch(() => undefined);
          }
          for (const record of await keys.keysFor(siteId)) await keys.patch(record.id, { status: "unknown", statusMessage: null, balance: undefined, limitedUntil: undefined, limitedReason: undefined, limitedScope: undefined, probedAt: undefined });
        }
      } else {
        siteId = asString(request.newId) ? request.newId.trim() : suggestSiteId(/[a-z]/i.test(name) ? name : baseUrl, sites.map((site) => site.id));
        if (!SITE_ID_PATTERN.test(siteId)) throw cnError(CODES.badRequest, "Provider ID 须以小写字母开头，仅可包含小写字母、数字和连字符（最长 40 个字符）");
        if (RESERVED_SITE_IDS.includes(siteId)) throw cnError(CODES.badRequest, `Provider ID ${siteId} 为保留名称，请使用其他 ID`);
        if (sites.some((site) => site.id === siteId)) throw cnError(CODES.badRequest, `Provider ID ${siteId} 已被占用`);
        const result = await settings.addSite({ id: siteId, models: [], headers: {}, platform: "generic", ...fields });
        if (!result?.ok) throw cnError(CODES.badRequest, result?.error ?? "站点保存失败");
      }
      if (Array.isArray(request.models) && request.models.length) await settings.addModels(siteId, request.models);
      let addedKeys = [];
      if (asString(request.keys) && parseKeyLines(request.keys).length) addedKeys = await addKeysTo(await settings.site(siteId), request.keys);
      onRoutesChanged();
      onModelsChanged();
      if (Array.isArray(request.models) && request.models.length) void probeWindows(siteId, request.models.map((model) => model.id));
      return { ...(await status()), saved: siteId, addedKeys };
    },

    async removeSite(request) {
      await requireSite(request.siteId);
      await settings.removeSite(request.siteId);
      await keys.removeSite(request.siteId);
      await usage?.removeSite(request.siteId).catch((error) => log("warn", `usage of ${request.siteId} not forgotten: ${redact(error?.message ?? error)}`));
      // Its model check records go with it, as its usage does (a site added again under the same id starts afresh).
      await authn?.clear({ siteId: request.siteId }).catch((error) => log("warn", `model checks of ${request.siteId} not forgotten: ${redact(error?.message ?? error)}`));
      await relay?.store.removeSite(request.siteId).catch((error) => log("warn", `relay data of ${request.siteId} not forgotten: ${redact(error?.message ?? error)}`));
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
      if (models.length === 0) throw cnError(CODES.badRequest, "无待添加的模型");
      await settings.addModels(request.siteId, models);
      adapter.clearUnusable(request.siteId);
      onModelsChanged();
      void probeWindows(request.siteId, models.map((model) => model.id));
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
      // Images ticked again: a refusal learned before is the user's to overrule.
      if (patch.image === true) patch.imageRefused = null;
      const checked = coerceModel({ id: request.modelId, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)) });
      const next = {};
      for (const [field, value] of Object.entries(patch)) next[field] = value === null ? null : checked?.[field];
      // A price alone leaves the description the site's (it keeps following the site's list).
      const keepSource = Object.keys(patch).length > 0 && Object.keys(patch).every((field) => field === "price");
      if (!(await settings.updateModel(request.siteId, request.modelId, next, { keepSource }))) throw cnError(CODES.badRequest, `站点上不存在模型 ${request.modelId}`);
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
      await relay?.store.removeKey(request.keyId).catch(() => undefined);
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
      // What the relay tells beside the balance follows: read now for one site's or one key's check (always by hand); the
      // page's own refresh of every key (every 5 minutes while shown) keeps each read's interval.
      if (relay && request.mode !== "validity") {
        const force = Boolean(request.siteId) || (Array.isArray(request.keyIds) && request.keyIds.length > 0);
        for (const record of chosen) await relay.sync.refreshKey(record.id, { force }).catch(() => undefined);
        for (const siteId of new Set(chosen.map((record) => record.endpoint))) await relay.sync.refreshSite(siteId, { force }).catch(() => undefined);
      }
      return { ...(await status()), checked };
    },

    /** Add a switch group, or change one (`id`): its name, its members (site + model), the one serving it. */
    async saveGroup(request) {
      const sites = await settings.sites();
      const members = request.members.filter((member) => sites.some((site) => site.id === member.site));
      if (members.length === 0) throw cnError(CODES.badRequest, "切换组至少需要一个成员（站点上的模型）");
      const groups = await settings.groups();
      const name = asString(request.name?.trim?.()) ? request.name.trim().slice(0, 60) : members[0].model;
      const id = request.id && groups.some((group) => group.id === request.id) ? request.id : suggestGroupId(name, groups.map((group) => group.id));
      const active = Number.isInteger(request.active) && request.active >= 0 && request.active < members.length ? request.active : 0;
      const result = await settings.saveGroup({ id, name, members, active });
      if (!result?.ok) throw cnError(CODES.badRequest, result?.error ?? "切换组保存失败");
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

    // ---- model authenticity checks (authn/): these return their own answers, not the status.

    /** What one conversation's status bar shows: its route and model (DSH's model selection). */
    async authnSession(request) {
      return requireAuthn().session({ sessionId: request.sessionId, route: request.route, model: request.model });
    },

    /** The 模型核验 page: every site's models, the settings, the rule pack. */
    async authnReport() {
      return requireAuthn().report();
    },

    /** Scan one conversation or not (it then no longer follows the default). */
    async authnTrack(request) {
      return requireAuthn().track({ sessionId: request.sessionId, on: request.on });
    },

    /** Change the settings (fields given replace the stored ones). */
    async authnSettings(request) {
      const next = await requireAuthn().saveSettings(request.patch ?? {});
      if (request.patch?.passive === true || request.patch?.active === true || request.patch?.enabled === true) void authn.scheduledUpdate().catch(() => undefined);
      return { settings: next };
    },

    /** Start an active check (`quick` or `signature`) on one site's model. */
    async authnProbe(request) {
      return requireAuthn().probe({ siteId: request.siteId, modelId: request.modelId, kind: request.kind });
    },

    async authnCancel(request) {
      return requireAuthn().cancel({ siteId: request.siteId, modelId: request.modelId });
    },

    /** The rule pack: `check` for an update now, `rollback` to the plugin's own. */
    async authnRules(request) {
      return { rules: await requireAuthn().rules({ action: request.action }) };
    },

    /** Forget what was observed and checked: one model's, one site's, or all. */
    async authnClear(request) {
      const cleared = await requireAuthn().clear({ siteId: request.siteId, modelId: request.modelId });
      // The site log's facts of those models go with their records.
      await relay?.store.clearFacts({ siteId: request.siteId, modelId: request.modelId }).catch(() => undefined);
      return cleared;
    },

    /**
     * A new-api site's read-only account token (a personal access token with profile:read, usage:read and
     * wallet:read; or the older system token with its user id): the account's balance and subscriptions are read with
     * it. An empty token removes it. Never sent to the page; only to the site's own address, for reads.
     */
    async setSiteAccount(request) {
      const site = await requireSite(request.siteId);
      if (site.platform !== "newapi") throw cnError(CODES.badRequest, "账户访问令牌仅适用于 new-api 站点");
      const token = typeof request.token === "string" ? request.token.trim() : "";
      if (!(await keys.setAccount(site.id, { token, userId: request.userId ?? undefined, origin: originOf(site.baseUrl) }))) throw cnError(CODES.badRequest, "账户访问令牌格式不正确");
      if (token) {
        registerSecret(token);
        await relay?.sync.refreshKey((await keys.keysFor(site.id))[0]?.id ?? "", { force: true }).catch(() => undefined);
        await relay?.sync.refreshAccount?.(site.id).catch(() => undefined);
      } else await relay?.store.update((state) => { if (state.sites[site.id]) delete state.sites[site.id].account; }).catch(() => undefined);
      return status();
    },

    /** Let one site take part in model authenticity checks, or not. */
    async setSiteAuthn(request) {
      await requireSite(request.siteId);
      await settings.updateSite(request.siteId, { authn: request.on === true ? undefined : false });
      return status();
    },
  };

  function requireAuthn() {
    if (!authn) throw cnError(CODES.badRequest, "模型核验不可用");
    return authn;
  }

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
  // For the self-test: the window probes still running.
  Object.defineProperty(remote, "settled", { value: () => Promise.all([...probing.values()]), enumerable: false });
  // After a start (index.js): every site switched on asks for the windows of models not asked with this probe yet.
  Object.defineProperty(remote, "probePending", {
    enumerable: false,
    value: async () => {
      for (const site of await settings.sites()) if (site.enabled !== false) await probeWindows(site.id, undefined, { pendingOnly: true });
    },
  });
  Object.defineProperty(remote, "typertRemote", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service: remote, serviceKey: SERVICE_KEY, namespace: "customModels" },
  });
  return remote;
}
