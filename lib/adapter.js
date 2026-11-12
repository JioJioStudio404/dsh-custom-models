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
import { affordableOutput, AFFORD_MIN, classifyFailure, IMAGE_REFUSED, KIND_LABELS, outputFieldOf, REASONING_BACK, REPLAY_REFUSED, resolveEffort } from "./dialects.js";
import { displayNameOf, endpointById, endpointOfRoute, GROUP_DISPLAY_NAME, GROUP_NAME, GROUP_ROUTE } from "./endpoints.js";
import { cnError, CODES, redact } from "./errors.js";
import { megabytes, SiteRefusal, streamSite } from "./gateway.js";
import { effectiveModel, estimateCost, findModel, surchargeOf, toModelInfo } from "./models.js";
import { statusFromFailure } from "./probe.js";
import { imageLimitsOf, imagesToOffload, MIN_LEARNED_IMAGE_BUDGET, requestTarget } from "./request.js";
import { estimateRequestTokens, estimateTokens, requestEntry } from "./usage.js";
import { contextFromHeaders, contextFromText } from "./context.js";
import { hasImages, lastUserText, observation, toolCallHealth, toolsOf } from "./authn/observe.js";

const TAB = "「Custom」标签页";
/** Refusals that say something about the key, not the request. */
const KEY_KINDS = new Set(["invalid-key", "expired", "no-balance", "plan-quota", "client-denied"]);
/** Refusals that say the model cannot be had here (for now). */
const MODEL_KINDS = new Set(["not-found", "model-denied", "paid-model", "free-tier"]);
/** Whether a request on this model carries a reasoning field (it offers levels and is not set to send none). */
const sendsReasoning = (model) => Boolean(model?.reasoning && typeof model.reasoning === "object" && model.flags?.thinkingFormat !== "none");
/** An attempt that replays no signatures or sealed reasoning (after the site refused them). */
const UNSIGNED = Symbol("dsh-custom-models.unsigned");
/** An attempt made after a refusal taught the model a request flag (no second lesson in one request). */
const LEARNED = Symbol("dsh-custom-models.learned");
/** An attempt asking only the output the credit covers. */
const AFFORDED = Symbol("dsh-custom-models.afforded");
/** Refusals before anything was sent (images over the site's budget): no failure of the site's. */
const UNSENT_KINDS = new Set(["image-offload"]);

/**
 * The retry DSH runs (its dsh-llm-retry plugin) for this plugin's routes, in its resolved form: the failures it
 * retries by default (an empty answer, a rate limit, a server error such as a gateway's 502 / 524, a timeout, a broken
 * connection), 8 times over about two minutes — 1, 2, 4, 8, 16, then 30 seconds apart, ±10 % — where DSH's default
 * gives up after 5 within about 15 seconds; a site's Retry-After up to 30 seconds is waited (DSH's default: 10). DSH
 * shows each wait and the user can stop it. Its numbers are my choice.
 */
export const RETRY_POLICY = Object.freeze({
  mode: "normal",
  maxRetries: 8,
  retryableCodes: Object.freeze(["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]),
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.1,
});

export class CustomAdapter {
  #keys;
  #settings;
  #attachments;
  #fetch;
  #log;
  #onModelsChanged;
  #onUsed;
  #idleMs;
  #usage;
  #authn;
  /** Requests running per site (site id → count). */
  #inFlight = new Map();
  /** Models that failed as unavailable in this process, per site. */
  #unusable = new Map();

  /**
   * @param {object} options - `keys` (KeyStore), `settings` (SettingsStore), `attachments`,
   * `fetchImpl`, `log`, `onModelsChanged()`, `onUsed(keyId)`, `idleMs`, `usage` (the UsageLedger each request is counted in),
   * `authn` (model authenticity checks: each answer of a tracked conversation is observed).
   */
  constructor({ keys, settings, attachments, fetchImpl = fetch, log = () => {}, onModelsChanged = () => {}, onUsed = () => {}, idleMs = 600_000, usage, authn }) {
    this.#keys = keys;
    this.#settings = settings;
    this.#attachments = attachments ?? (() => undefined);
    this.#fetch = fetchImpl;
    this.#log = log;
    this.#onModelsChanged = onModelsChanged;
    this.#onUsed = onUsed;
    this.#idleMs = idleMs;
    this.#usage = usage;
    this.#authn = authn;
  }

  providerInfo(route) {
    if (route === GROUP_ROUTE) return { id: route, name: GROUP_DISPLAY_NAME };
    const endpoint = endpointOfRoute(route);
    return { id: route, name: endpoint ? displayNameOf(endpoint) : route };
  }

  /**
   * DSH's own retry for this plugin's routes ({@link RETRY_POLICY}): longer than its default, since a relay station's
   * gateway fails for a while (a Cloudflare 524 while its upstream is slow) more often than a vendor's API.
   */
  providerRetryPolicy() {
    return RETRY_POLICY;
  }

  imageRequestPricing() {
    return undefined;
  }

  /** The size and byte budget an image is sent at (DSH 0.2.1 calls this directly, without waiting). */
  imageRequestTarget(route, model, image) {
    return requestTarget(image, undefined, imageLimitsOf(this.#cachedSiteOf(route, model)).maxBytes);
  }

  /** The site a route (and a switch group's model id) goes to, as last read: synchronous. */
  #cachedSiteOf(route, model) {
    if (route === GROUP_ROUTE) {
      const group = this.#settings.cachedGroups?.().find((item) => item.id === model);
      const member = group ? (group.members[group.active] ?? group.members[0]) : undefined;
      return member ? this.#settings.cachedSite?.(member.site) : undefined;
    }
    const endpoint = endpointOfRoute(route);
    return endpoint ? this.#settings.cachedSite?.(endpoint.id) : undefined;
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
    return site.models.filter((model) => !this.unusable(site.id, model.id)).map((model) => toModelInfo(route, effectiveModel(model, site)));
  }

  /** Metadata for one exact id, added or not. */
  async resolveModel(route, modelId) {
    if (route === GROUP_ROUTE) {
      const group = (await this.#settings.groups()).find((item) => item.id === modelId);
      const target = group ? await this.#groupTarget(group) : undefined;
      if (!target) throw cnError(CODES.unknownModel, `${GROUP_NAME}「${modelId}」不存在或无可用成员，请在${TAB}检查`);
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
      if (!target) throw cnError(CODES.unknownModel, `${GROUP_NAME}「${options.model}」不存在或无可用成员，请在${TAB}检查`);
    } else {
      const endpoint = endpointOfRoute(options.provider);
      const site = endpoint ? await this.#settings.site(endpoint.id) : undefined;
      if (!site) throw cnError(CODES.unknownModel, `unknown route "${options.provider}"`);
      target = { site, model: findModel(site, options.model) };
    }
    // A site switched off sends nothing (a conversation may still name its model).
    if (target.site.enabled === false) {
      throw cnError(CODES.badRequest, `${target.group ? `${GROUP_NAME}「${target.group.name}」当前选定的站点` : "站点"}「${target.site.name}」已停用，请在${TAB}启用该站点${target.group ? "，或改选其他成员" : ""}`, { kind: "site-off", endpoint: target.site.id });
    }
    const endpoint = endpointById(target.site.id);
    const record = await this.#keyFor(target.site);
    const effort = resolveEffort(target.model, options.reasoningEffort, options.purpose);
    // The user's own requests on this site, counted while they run (a background check waits for them).
    this.#inFlight.set(target.site.id, (this.#inFlight.get(target.site.id) ?? 0) + 1);
    const where = target.group ? `${GROUP_NAME}「${target.group.name}」→ ${displayNameOf(endpoint)}` : displayNameOf(endpoint);
    try {
      yield* this.#streamWith(record, target.site, endpoint, target.model, effort, options, where);
    } catch (error) {
      if (!options.signal?.aborted && !UNSENT_KINDS.has(error?.kind)) {
        this.#usage?.record(target.site.id, target.model.id, { failures: 1 });
        this.#observe(target.site, target.model, options, { ok: false, kind: error?.kind ?? "error" });
      }
      if (options.signal?.aborted || error?.started) throw error;
      if (MODEL_KINDS.has(error?.kind)) this.#markUnusable(target.site.id, target.model.id, error.message);
      if (record.id && KEY_KINDS.has(error?.kind)) {
        const now = Date.now();
        await this.#keys.patch(record.id, { ...statusFromFailure({ kind: error.kind, message: error.message, resetAt: error.resetAt, upfront: error.upfront }, now), checkedAt: new Date(now).toISOString() }).catch(() => undefined);
      }
      throw error;
    } finally {
      const left = (this.#inFlight.get(target.site.id) ?? 1) - 1;
      if (left > 0) this.#inFlight.set(target.site.id, left);
      else this.#inFlight.delete(target.site.id);
      if (record.id) this.#onUsed(record.id);
    }
  }

  /** The user's requests running on a site now. */
  inFlight(siteId) {
    return this.#inFlight.get(siteId) ?? 0;
  }

  /** The key a site's request goes out on: the active one (the user's choice), or none for a keyless site. */
  async #keyFor(site) {
    const active = await this.#keys.active(site.id);
    if (active) return active;
    if (site.keyless) return { id: null, key: "" };
    throw cnError(CODES.missing, `站点「${site.name}」尚未配置 API Key，请在${TAB}添加。`);
  }

  /** The error for a site's refusal: what it means for the key or the model, and what to do by hand. */
  async #refusal(refusal, site, endpoint, record, where, model) {
    const failure = classifyFailure(endpoint.platform, refusal.status, refusal.text, { headers: refusal.headers });
    // A refusal that states the model's window ("maximum context length is 1048576 tokens") teaches it.
    const stated = contextFromText(refusal.text);
    if (stated && model) await this.#learnContext(site.id, model.id, stated, "error").catch((error) => this.#log("warn", `window not learned: ${redact(error?.message ?? error)}`));
    // A model that takes no images, refused for the ones this request carried: learned, and DSH sends them as text.
    const imageCount = Array.isArray(refusal.images) ? refusal.images.length : 0;
    if (imageCount > 0 && model && IMAGE_REFUSED.test(String(refusal.text ?? ""))) return this.#imagesRefused(refusal, failure, site, endpoint, where, model, imageCount);
    if (failure.kind === "too-large") return this.#tooLarge(refusal, failure, site, endpoint, where);
    // A used-up window that says when it comes back (Retry-After, a stated time): the time, not a top-up.
    const back = failure.kind === "plan-quota" && failure.resetAt > Date.now()
      ? new Date(failure.resetAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : null;
    const advice = failure.suspended ? `（站点已停用该账户：请联系站点恢复，或在${TAB}更换 Key）`
      : back ? `（预计 ${back} 恢复；也可在${TAB}更换 Key）`
      // A plan's own pace (its concurrency or requests per minute, counted per account across every client).
      : failure.kind === "rate-limit" && failure.label ? "（该上限按账号计算，其他客户端同时进行的请求也计入；DeepSeek Harness 将稍后自动重试）"
      : failure.kind === "client-denied" ? `（该 Key 所在分组只允许站点指定的客户端（如 Claude Code）调用，本插件的请求无法通过；请在站点改用其他分组的 Key，再在${TAB}更换）`
      : failure.upfront ? `（站点按每次请求的上下文与最大输出预扣费，该 Key 的剩余额度不足以完成本次预扣；请在${TAB}更换 Key，或联系站点提高该 Key 的额度）`
      : KEY_KINDS.has(failure.kind) ? `（请在${TAB}更换 Key，或充值后点击 ✓ 重新校验）`
      : MODEL_KINDS.has(failure.kind) ? `（该模型当前在此站点不可用；可在${TAB}改用其他站点或模型）`
        : failure.kind === "forbidden" ? `（请检查该 Key 在站点上的分组或权限设置）`
          // A model that takes no reasoning field the way it was sent (a relay station's Qwen3.8 refuses reasoning_effort, live 2026-11-01).
          : failure.kind === "bad-request" && model && sendsReasoning(model) ? `（若该模型不接受推理参数：请在${TAB}编辑该模型，将「推理参数格式」改为其他格式或「不发送」）` : "";
    return cnError(failure.code, `${where}：${failure.suspended ? "账户已被站点停用" : failure.upfront ? "Key 已达到用量上限" : failure.label ?? KIND_LABELS[failure.kind] ?? "请求失败"}（${refusal.status}）：${failure.message}${advice}`, {
      status: refusal.status,
      retryAfterMs: failure.retryAfterMs,
      kind: failure.kind,
      keyId: record.id ?? undefined,
      endpoint: endpoint.id,
      resetAt: failure.resetAt,
      vendorCode: failure.vendorCode,
      upfront: failure.upfront,
    });
  }

  /**
   * A refusal of the images a request carried by a model that takes none: the added model is kept as text
   * only (`imageRefused`, until the user ticks images again), DSH is told it no longer sees, and this
   * request's images are replaced with text before DSH retries (IMAGE_OFFLOAD_REQUIRED).
   */
  async #imagesRefused(refusal, failure, site, endpoint, where, model, count) {
    const stored = site.models.find((item) => item.id === model.id);
    if (stored && stored.imageRefused !== true) {
      await this.#settings.updateModel(site.id, model.id, { imageRefused: true }, { keepSource: true })
        .then(() => this.#onModelsChanged())
        .catch((error) => this.#log("warn", `${site.id}/${model.id}: text only not kept: ${redact(error?.message ?? error)}`));
      this.#log("info", `${site.id}/${model.id}: images refused (${refusal.status}); text only from now on`);
    }
    return cnError(CODES.imageOffload, `${where}：该模型不支持图片输入（${refusal.status}）：${failure.message}。已将其标记为仅文本；DeepSeek Harness 将把本次请求中的 ${count} 张图片替换为文字说明后重试`, {
      status: refusal.status,
      kind: "image-offload",
      offloadImages: count,
      endpoint: endpoint.id,
    });
  }

  /**
   * A refusal for the request's size (HTTP 413, a relay's body limit, which
   * counts bytes, not tokens). When its images make up much of the body, the
   * site's image budget drops to half of what they were (never below 256 KB;
   * kept until the user sets a budget) and DSH replaces the oldest images
   * with text before retrying (IMAGE_OFFLOAD_REQUIRED). Otherwise the
   * conversation itself is too big: DSH compacts and retries once
   * (CONTEXT_WINDOW_EXCEEDED).
   */
  async #tooLarge(refusal, failure, site, endpoint, where) {
    const sizes = Array.isArray(refusal.images) ? refusal.images : [];
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const imagesMatter = total > 0 && (!Number.isFinite(refusal.bodyBytes) || total >= refusal.bodyBytes / 4);
    if (imagesMatter) {
      const budget = Math.min(Math.max(MIN_LEARNED_IMAGE_BUDGET, Math.floor(total / 2)), site.imageBudgetLearned ?? Infinity);
      await this.#settings.updateSite(site.id, { imageBudgetLearned: budget }).catch((error) => this.#log("warn", `image budget not saved: ${redact(error?.message ?? error)}`));
      const offloadImages = Math.max(1, imagesToOffload(sizes, budget));
      return cnError(CODES.imageOffload, `${where}：请求体超出站点上限（${refusal.status}）。本次请求的图片共 ${megabytes(total)}，已将该站点的图片总额度下调至 ${megabytes(budget)}；DeepSeek Harness 将把最早的 ${offloadImages} 张图片替换为文字说明后重试`, {
        status: refusal.status,
        kind: "image-offload",
        offloadImages,
        endpoint: endpoint.id,
      });
    }
    return cnError(CODES.context, `${where}：请求体超出站点上限（${refusal.status}）：${failure.message}。DeepSeek Harness 将压缩上下文后重试；若仍失败，请在对话中输入 /compact，或在${TAB}调低该模型的上下文窗口`, {
      status: refusal.status,
      kind: "context",
      endpoint: endpoint.id,
    });
  }

  /**
   * Count a served request in the usage ledger on the site and model that served it: the site's
   * tokens (as DSH sees them), else an estimate; first-token latency and decode time; the site's own cost.
   */
  #count(site, model, options, { usage, report, startedAt, firstAt, endAt, outputEstimate }) {
    if (!this.#usage) return;
    let tokens = {};
    if (usage) tokens = { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens };
    else if (report.usageReported === false) tokens = { estimated: 1, input: estimateRequestTokens(options), output: outputEstimate };
    // The site's own cost covers this request's tokens; else what its tier and the peak hours add at the site's price.
    const surcharge = surchargeOf(model, { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite }, startedAt);
    const entry = requestEntry(tokens, { reported: report.cost, surcharge });
    if (firstAt) {
      Object.assign(entry, { ttftMs: Math.max(1, firstAt - startedAt), ttftCount: 1 });
      if (endAt > firstAt && Number(entry.output) > 0) Object.assign(entry, { decodeMs: endAt - firstAt, decodeTokens: entry.output });
    }
    try {
      this.#usage.record(site.id, model.id, entry);
    } catch (error) {
      this.#log("warn", `usage not counted: ${redact(error?.message ?? error)}`);
    }
  }

  /**
   * A window the site showed for an added model: stored as its own (`measured`) unless the user set
   * one. The site's list stands against an answer's header; a refusal's smaller figure overrules it
   * (the request did not fit, and compacting to the listed window would not either).
   */
  async #learnContext(siteId, modelId, context, from) {
    const site = await this.#settings.site(siteId);
    const stored = site?.models.find((item) => item.id === modelId);
    if (!stored || stored.contextFrom === "user") return;
    if (stored.contextFrom === "site" && !(from === "error" && context < stored.context)) return;
    if (stored.contextFrom === "measured" && stored.context === context) return;
    await this.#settings.updateModel(siteId, modelId, { context, contextFrom: "measured", contextMeasured: from }, { keepSource: true });
    this.#log("info", `${siteId}/${modelId}: window ${context} (${from})`);
    this.#onModelsChanged();
  }

  /**
   * A request flag a site's refusal taught an added model (as the user would set it in 编辑模型): kept on the
   * stored model, and the model to send again with. A model not stored (typed by hand) is taught for this
   * request only.
   */
  async #learnFlags(siteId, model, flags, why) {
    const site = await this.#settings.site(siteId);
    const stored = site?.models.find((item) => item.id === model.id);
    if (stored) {
      await this.#settings.updateModel(siteId, model.id, { flags: { ...(stored.flags ?? {}), ...flags } }, { keepSource: true })
        .then(() => this.#onModelsChanged())
        .catch((error) => this.#log("warn", `${siteId}/${model.id}: ${why} not kept: ${redact(error?.message ?? error)}`));
    }
    this.#log("info", `${siteId}/${model.id}: ${why} (learned from a refusal); sent again`);
    return { ...model, flags: { ...(model.flags ?? {}), ...flags } };
  }

  /**
   * Hand one answer (or a failure) to model authenticity checks (authn/), which keep it only when the feature is
   * on, the site takes part and the conversation is tracked: an observation of numbers and forms, no text.
   */
  #observe(site, model, options, { report = {}, usage = null, seen = null, ok, kind = null, ttftMs = null, decodeMs = null, effort = null }) {
    if (this.#authn?.enabled?.() !== true) return;
    this.#authn.observe({
      siteId: site.id,
      modelId: model.id,
      sessionId: options.sessionId,
      build: (pack) => observation({
        pack,
        protocol: report.protocol ?? model.protocol ?? site.protocol,
        sessionId: options.sessionId,
        wire: report.wire,
        headers: report.headers ?? null,
        ok,
        kind,
        usage,
        // As sent: tools DSH defers are not in the request.
        estimate: estimateRequestTokens({ ...options, tools: Array.isArray(options.tools) ? options.tools.filter((tool) => !tool?.deferLoading) : options.tools }),
        images: hasImages(options),
        text: seen?.text ?? "",
        chars: seen?.chars ?? null,
        reasoningChars: seen?.reasoning ?? 0,
        reasoningTokens: report.reasoningTokens ?? 0,
        ttftMs,
        decodeMs,
        // A reasoning request's real limit adds the reasoning budget (pi-ai): the output limit is judged without reasoning only.
        maxTokens: effort && effort !== "off" ? null : options.maxTokens,
        tools: seen?.tools ?? null,
        argumentChars: seen?.argumentChars ?? 0,
        question: lastUserText(options),
      }),
    }).catch(() => undefined);
  }

  /** One attempt, the way DSH's custom gateway makes it (gateway.js). */
  async *#streamWith(record, site, endpoint, model, effort, options, where) {
    let usage;
    let started = false;
    const report = {};
    const startedAt = Date.now();
    let firstAt;
    // What came back, roughly, for a site that reports no usage.
    let outputEstimate = 0;
    // What passive scanning reads of the answer (authn/): the opening of its text, its length, reasoning, tool calls.
    const seen = this.#authn?.enabled?.() === true ? { text: "", chars: 0, reasoning: 0, argumentChars: 0, tools: { calls: 0, bad: 0, unknown: 0 }, toolSet: toolsOf(options) } : null;
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
        images: imageLimitsOf(site),
        report,
        // The key's store id (never the secret): replayed signatures must be its account's.
        keyId: record.id ?? "keyless",
        unsigned: options[UNSIGNED] === true,
        observeWire: seen !== null,
        onThinkingOmitted: (count) => this.#log("debug", `${site.id}/${model.id}: signed thinking of ${count} earlier turn(s) left out (the request before it changed)`),
      })) {
        if (chunk.type === "usage") usage = chunk.usage;
        if (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") {
          started = true;
          firstAt ??= Date.now();
          outputEstimate += estimateTokens(chunk.type === "tool-call-delta" ? chunk.argumentsDelta : chunk.text);
        }
        if (seen) {
          if (chunk.type === "text-delta") {
            seen.chars += chunk.text.length;
            if (seen.text.length < 4000) seen.text += chunk.text;
          } else if (chunk.type === "reasoning-delta") seen.reasoning += chunk.text.length;
          else if (chunk.type === "tool-call-delta") seen.argumentChars += String(chunk.argumentsDelta ?? "").length;
          else if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
            seen.tools.calls += 1;
            const health = toolCallHealth(seen.toolSet, chunk.block.name, chunk.block.arguments);
            if (health === "bad") seen.tools.bad += 1;
            else if (health === "unknown") seen.tools.unknown += 1;
          }
        }
        yield chunk;
      }
    } catch (error) {
      // Replayed signatures or sealed reasoning another account made, refused: once more without any (nothing reached DSH yet).
      if (error instanceof SiteRefusal && !options[UNSIGNED] && REPLAY_REFUSED.test(String(error.text ?? ""))) {
        this.#log("info", `${site.id}/${model.id}: replayed reasoning refused (${error.status}); sent again without signatures`);
        yield* this.#streamWith(record, site, endpoint, model, effort, { ...options, [UNSIGNED]: true }, where);
        return;
      }
      // A refusal that names what the model needs, taught once (nothing reached DSH yet): its reasoning back on
      // tool turns (DeepSeek and Kimi behind a relay), or the output field the site takes.
      // The credit left covers a smaller output (OpenRouter's "… or fewer max_tokens … can only afford N"): once more asking N.
      const afford = error instanceof SiteRefusal ? affordableOutput(error.text) : undefined;
      if (afford >= AFFORD_MIN && !options[AFFORDED] && !(options.maxTokens <= afford)) {
        this.#log("info", `${site.id}/${model.id}: the credit covers ${afford} output tokens; sent again asking that many`);
        yield* this.#streamWith(record, site, endpoint, model, effort, { ...options, maxTokens: afford, [AFFORDED]: true }, where);
        return;
      }
      if (error instanceof SiteRefusal && !options[LEARNED]) {
        const text = String(error.text ?? "");
        const field = outputFieldOf(text);
        const lesson = model.flags?.reasoningOnAssistant !== true && model.reasoning && REASONING_BACK.test(text) ? [{ reasoningOnAssistant: true }, "reasoning sent back"]
          : field && model.flags?.maxTokensField !== field ? [{ maxTokensField: field }, `output as ${field}`] : null;
        if (lesson) {
          const learned = await this.#learnFlags(site.id, model, ...lesson);
          yield* this.#streamWith(record, site, endpoint, learned, effort, { ...options, [LEARNED]: true }, where);
          return;
        }
      }
      if (error instanceof SiteRefusal) throw await this.#refusal(error, site, endpoint, record, where, model);
      // Malformed tool arguments end a billed answer: its usage reached DSH first, and is counted here too.
      if (error?.kind === "malformed" && usage) {
        this.#count(site, model, options, { usage, report, startedAt, firstAt, endAt: Date.now(), outputEstimate });
        if (record.id) this.#keys.noteUsage(record.id, usage, Number.isFinite(report.cost) ? report.cost : estimateCost(model, usage), model.id).catch((failure) => this.#log("warn", `usage not counted: ${redact(failure?.message ?? failure)}`));
      }
      // Output already reached the conversation: nothing is marked (the stream broke, not the key).
      if (started && error && typeof error === "object") Object.defineProperty(error, "started", { value: true });
      throw error;
    }
    // Whether the site reports usage (the tab says when it does not): stored when it changes.
    if (typeof report.usageReported === "boolean" && report.usageReported !== site.usageReported) {
      this.#settings.updateSite(site.id, { usageReported: report.usageReported }).catch(() => undefined);
    }
    // Per model too: a relay may report usage for some models only.
    const stored = site.models.find((item) => item.id === model.id);
    if (stored && typeof report.usageReported === "boolean" && stored.usageReported !== report.usageReported) {
      this.#settings.updateModel(site.id, model.id, { usageReported: report.usageReported }, { keepSource: true }).catch(() => undefined);
    }
    // An answer that states the model's window (a relay station's x-grok-context-window) teaches it.
    const fromHeader = contextFromHeaders(report.headers);
    if (fromHeader) this.#learnContext(site.id, model.id, fromHeader, "header").catch((error) => this.#log("warn", `window not learned: ${redact(error?.message ?? error)}`));
    const endAt = Date.now();
    this.#count(site, model, options, { usage, report, startedAt, firstAt, endAt, outputEstimate });
    if (seen) this.#observe(site, model, options, { report, usage, seen, ok: true, effort, ttftMs: firstAt ? firstAt - startedAt : null, decodeMs: firstAt && endAt > firstAt ? endAt - firstAt : null });
    if (!record.id) return;
    // What the request cost: the site's own figure when it gives one, else the model's prices.
    const cost = Number.isFinite(report.cost) ? report.cost : estimateCost(model, usage);
    this.#keys.noteUsage(record.id, usage, cost, model.id).catch((error) => this.#log("warn", `usage not counted: ${redact(error?.message ?? error)}`));
  }
}
