/**
 * The harness adapter: one DSH route per site (`custom-<id>`) and one for the
 * switch groups (`custom-groups`), duck-typed `LlmAdapter`.
 *
 * Nothing switches by itself. A request goes out on the site's active key —
 * the one the user chose — and a switch group's request goes to the member
 * the user chose; a refusal is recorded on that key (no money, invalid,
 * expired) or on that model (gone, not for this key) and reported with what
 * to switch by hand. A relay's model may not be what its name says, so
 * moving a conversation to another site or key is the user's call.
 *
 * The request itself is built, sent and read the way DSH's own custom
 * gateway does it (gateway.js, over the same pi-ai release DSH ships).
 *
 * @module dsh-custom-models/adapter
 */
import { classifyFailure, KIND_LABELS, resolveEffort } from "./dialects.js";
import { displayNameOf, endpointById, endpointOfRoute, GROUP_NAME, GROUP_ROUTE } from "./endpoints.js";
import { cnError, CODES, redact } from "./errors.js";
import { SiteRefusal, streamSite } from "./gateway.js";
import { completeModel, estimateCost, findModel, toModelInfo } from "./models.js";
import { statusFromFailure } from "./probe.js";
import { requestTarget } from "./request.js";

const TAB = "「自定义」标签页";
/** Refusals that say something about the key, not the request. */
const KEY_KINDS = new Set(["invalid-key", "expired", "no-balance", "plan-quota"]);
/** Refusals that say the model cannot be had here (for now). */
const MODEL_KINDS = new Set(["not-found", "model-denied", "paid-model", "free-tier"]);

export class CustomAdapter {
  #keys;
  #settings;
  #attachments;
  #fetch;
  #log;
  #onModelsChanged;
  #onUsed;
  #idleMs;
  /** Models that failed as unavailable in this process, per site. */
  #unusable = new Map();

  /**
   * @param {object} options - `keys` (KeyStore), `settings` (SettingsStore), `attachments`,
   * `fetchImpl`, `log`, `onModelsChanged()`, `onUsed(keyId)`, `idleMs`.
   */
  constructor({ keys, settings, attachments, fetchImpl = fetch, log = () => {}, onModelsChanged = () => {}, onUsed = () => {}, idleMs = 600_000 }) {
    this.#keys = keys;
    this.#settings = settings;
    this.#attachments = attachments ?? (() => undefined);
    this.#fetch = fetchImpl;
    this.#log = log;
    this.#onModelsChanged = onModelsChanged;
    this.#onUsed = onUsed;
    this.#idleMs = idleMs;
  }

  providerInfo(route) {
    if (route === GROUP_ROUTE) return { id: route, name: GROUP_NAME };
    const endpoint = endpointOfRoute(route);
    return { id: route, name: endpoint ? displayNameOf(endpoint) : route };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  /** The size and byte budget an image is sent at (DSH 0.2.1 calls this directly). */
  imageRequestTarget(_route, _model, image) {
    return requestTarget(image);
  }

  /** Why a model failed as unavailable on a site in this process, or null. */
  unusable(siteId, modelId) {
    return this.#unusable.get(siteId)?.get(modelId) ?? null;
  }

  /** Every model this process found unavailable, per site (the tab shows them). */
  unusableModels() {
    return Object.fromEntries([...this.#unusable].map(([site, models]) => [site, Object.fromEntries(models)]));
  }

  /** Forget that a site's models failed (the user changed its models or key). */
  clearUnusable(siteId) {
    if (this.#unusable.delete(siteId)) this.#onModelsChanged();
  }

  #markUnusable(siteId, modelId, reason) {
    if (!this.#unusable.has(siteId)) this.#unusable.set(siteId, new Map());
    this.#unusable.get(siteId).set(modelId, reason);
    this.#onModelsChanged();
  }

  /**
   * A route's models: a site's added ones (minus those found unavailable), or
   * one per switch group whose chosen member is on a site switched on.
   */
  async listModels(route) {
    if (route === GROUP_ROUTE) {
      const out = [];
      for (const group of await this.#settings.groups()) {
        const target = await this.#groupTarget(group);
        if (target && target.site.enabled !== false) out.push(toModelInfo(GROUP_ROUTE, target.model, { id: group.id, name: group.name }));
      }
      return out;
    }
    const endpoint = endpointOfRoute(route);
    const site = endpoint ? await this.#settings.site(endpoint.id) : undefined;
    if (!site || site.enabled === false) return [];
    return site.models.filter((model) => !this.unusable(site.id, model.id)).map((model) => toModelInfo(route, completeModel(model)));
  }

  /** Metadata for one exact id, added or not. */
  async resolveModel(route, modelId) {
    if (route === GROUP_ROUTE) {
      const group = (await this.#settings.groups()).find((item) => item.id === modelId);
      const target = group ? await this.#groupTarget(group) : undefined;
      if (!target) throw cnError(CODES.unknownModel, `${GROUP_NAME}「${modelId}」不存在或没有可用成员，请在${TAB}检查`);
      return toModelInfo(GROUP_ROUTE, target.model, { id: group.id, name: group.name });
    }
    const endpoint = endpointOfRoute(route);
    const site = endpoint ? await this.#settings.site(endpoint.id) : undefined;
    return toModelInfo(route, findModel(site, modelId));
  }

  async prepareCall(route, model, signal) {
    const info = await this.resolveModel(route, model, signal);
    return { model: info, stream: (options) => this.stream({ ...options, provider: route, model }) };
  }

  /** The member serving a switch group now: its site and model. */
  async #groupTarget(group) {
    const member = group.members[group.active] ?? group.members[0];
    if (!member) return undefined;
    const site = await this.#settings.site(member.site);
    if (!site || !endpointById(site.id)) return undefined;
    return { site, model: findModel(site, member.model), group };
  }

  /**
   * Stream one call.
   * @param {object} options - harness GenerateOptions (+ provider, model).
   */
  async *stream(options) {
    let target;
    if (options.provider === GROUP_ROUTE) {
      const group = (await this.#settings.groups()).find((item) => item.id === options.model);
      target = group ? await this.#groupTarget(group) : undefined;
      if (!target) throw cnError(CODES.unknownModel, `${GROUP_NAME}「${options.model}」不存在或没有可用成员，请在${TAB}检查`);
    } else {
      const endpoint = endpointOfRoute(options.provider);
      const site = endpoint ? await this.#settings.site(endpoint.id) : undefined;
      if (!site) throw cnError(CODES.unknownModel, `unknown route "${options.provider}"`);
      target = { site, model: findModel(site, options.model) };
    }
    // A site switched off sends nothing (a conversation may still name its model).
    if (target.site.enabled === false) {
      throw cnError(CODES.badRequest, `${target.group ? `${GROUP_NAME}「${target.group.name}」选定的站点` : "站点"}「${target.site.name}」已关闭，请在${TAB}打开它${target.group ? "，或改选其他成员" : ""}`, { kind: "site-off", endpoint: target.site.id });
    }
    const endpoint = endpointById(target.site.id);
    const record = await this.#keyFor(target.site);
    const effort = resolveEffort(target.model, options.reasoningEffort, options.purpose);
    const where = target.group ? `${GROUP_NAME}「${target.group.name}」→ ${endpoint.name}` : displayNameOf(endpoint);
    try {
      yield* this.#streamWith(record, endpoint, target.model, effort, options, where);
    } catch (error) {
      if (options.signal?.aborted || error?.started) throw error;
      if (MODEL_KINDS.has(error?.kind)) this.#markUnusable(target.site.id, target.model.id, error.message);
      if (record.id && KEY_KINDS.has(error?.kind)) {
        const now = Date.now();
        await this.#keys.patch(record.id, { ...statusFromFailure({ kind: error.kind, message: error.message, resetAt: error.resetAt }, now), checkedAt: new Date(now).toISOString() }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (record.id) this.#onUsed(record.id);
    }
  }

  /** The key a site's request goes out on: the active one (the user's choice), or none for a keyless site. */
  async #keyFor(site) {
    const active = await this.#keys.active(site.id);
    if (active) return active;
    if (site.keyless) return { id: null, key: "" };
    throw cnError(CODES.missing, `${site.name} 还没有 Key，请在${TAB}添加。`);
  }

  /** The error for a site's refusal: what it means for the key or the model, and what to do by hand. */
  #refusal(refusal, endpoint, record, where) {
    const failure = classifyFailure(endpoint.platform, refusal.status, refusal.text, { headers: refusal.headers });
    const advice = KEY_KINDS.has(failure.kind) ? `（请在${TAB}换一个 Key，或充值后点 ✓ 重新检测）`
      : MODEL_KINDS.has(failure.kind) ? `（这个站点现在用不了这个模型；可在${TAB}换用其他站点或模型）`
        : failure.kind === "forbidden" ? `（请检查这个 Key 在站点上的分组或权限）` : "";
    return cnError(failure.code, `${where}：${KIND_LABELS[failure.kind] ?? "请求失败"}（${refusal.status}）：${failure.message}${advice}`, {
      status: refusal.status,
      retryAfterMs: failure.retryAfterMs,
      kind: failure.kind,
      keyId: record.id ?? undefined,
      endpoint: endpoint.id,
      resetAt: failure.resetAt,
      vendorCode: failure.vendorCode,
    });
  }

  /** One attempt, the way DSH's custom gateway makes it (gateway.js). */
  async *#streamWith(record, endpoint, model, effort, options, where) {
    let usage;
    let started = false;
    const report = {};
    try {
      for await (const chunk of streamSite({
        endpoint,
        model,
        effort,
        options,
        key: record.key,
        keyless: !record.id,
        where,
        fetchImpl: this.#fetch,
        attachments: this.#attachments(),
        idleMs: this.#idleMs,
        report,
      })) {
        if (chunk.type === "usage") usage = chunk.usage;
        if (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") started = true;
        yield chunk;
      }
    } catch (error) {
      if (error instanceof SiteRefusal) throw this.#refusal(error, endpoint, record, where);
      // Output already reached the conversation: nothing is marked (the stream broke, not the key).
      if (started && error && typeof error === "object") Object.defineProperty(error, "started", { value: true });
      throw error;
    }
    if (!record.id) return;
    // What the request cost: the site's own figure when it gives one, else the model's prices.
    const cost = Number.isFinite(report.cost) ? report.cost : estimateCost(model, usage);
    this.#keys.noteUsage(record.id, usage, cost, model.id).catch((error) => this.#log("warn", `usage not counted: ${redact(error?.message ?? error)}`));
  }
}
