/**
 * Model verification ("模型核验"), an add-on of the Custom tab the
 * user switches on: passive scanning of the conversations it tracks (no
 * request of its own), active checks on demand, the rule pack (built in,
 * updatable), and what the status bar and the 模型核验 page show. Nothing here
 * switches a key or a site, or blocks a request: it tells.
 *
 * @module dsh-custom-models/authn
 */
import { createHash } from "node:crypto";
import { endpointById, endpointOfRoute, GROUP_ROUTE, messagesBaseOf } from "../endpoints.js";
import { cnError, CODES, redact } from "../errors.js";
import { estimateCost, findModel, surchargeOf } from "../models.js";
import { FingerprintLibrary, fingerprintCheck, KeyRefused, matchFor } from "./fingerprint.js";
import { failedAttempt, judge, recentSiteLog } from "./judge.js";
import { useSalt } from "./observe.js";
import { IDENTITY_REQUESTS, identityCheck, quickCheck, quickRequests } from "./probes.js";
import { familyOf, fingerprintMatch, variantPatternOf } from "./rules.js";
import { signatureCheck } from "./signature.js";
import { AuthnStore } from "./store.js";
import { RuleUpdater } from "./update.js";

const nameOf = (siteId, modelId) => `${siteId}\u0000${modelId}`;
/** An automatic identity check waits this long after an answer (a burst of answers in one turn gathers into one decision). */
const AUTO_DELAY_MS = 5_000;
const protocolOf = (site, model) => model?.protocol ?? site?.protocol ?? "chat";
/** Signature checks: Claude on the Anthropic Messages protocol. */
const signable = (pack, site, model) => protocolOf(site, model) === "messages" && familyOf(pack, model.id)?.family === "claude";

/**
 * @param {object} deps - `settings` (SettingsStore), `keys` (KeyStore), `usage` (UsageLedger), `store`, `updater`,
 *   `library` (FingerprintLibrary), `fetchImpl`, `log`, `now`, `sleep` (a background run's pauses), `resumeDelayMs`
 *   (how long after start a kept job resumes).
 */
export function createAuthn({ settings, keys, usage, store = new AuthnStore(), updater, library, fetchImpl = fetch, log = () => {}, now = () => Date.now(), sleep, resumeDelayMs = 60_000 }) {
  updater ??= new RuleUpdater({ store, fetchImpl, log, now });
  library ??= new FingerprintLibrary({ fetchImpl, log, now });
  /** The user's own requests on a site right now (the adapter tells): a background run waits for them. */
  let traffic = () => 0;
  // Passive monitoring on (observations kept) and active testing on (checks may run).
  let passiveOn = false;
  let activeOn = false;
  /** Active checks running: site\0model → `{ kind, step, steps, startedAt, controller }`. */
  const runs = new Map();
  const ready = (async () => {
    const state = await store.read();
    useSalt(state.salt);
    passiveOn = state.settings.passive;
    activeOn = state.settings.active;
    await updater.load();
  })().catch((error) => log("warn", `authn not loaded: ${redact(error?.message ?? error)}`));
  void ready.then(() => resumeJobs());

  /** Knowledge fingerprints left part done (the app closed meanwhile) go on, a little after start, while active testing is on. */
  async function resumeJobs() {
    if (!activeOn) return;
    const jobs = await store.jobs().catch(() => ({}));
    for (const name of Object.keys(jobs)) {
      const [siteId, modelId] = name.split("\u0000");
      if (runs.has(name) || resumeTimers.has(name)) continue;
      const timer = setTimeout(() => {
        resumeTimers.delete(name);
        service.probe({ siteId, modelId, kind: "fingerprint", resume: true }).catch((error) => log("warn", `authn fingerprint not resumed: ${redact(error?.message ?? error)}`));
      }, resumeDelayMs);
      timer.unref?.();
      resumeTimers.set(name, timer);
    }
  }

  /**
   * The knowledge-fingerprint set for a model: one the rule pack lists (newest first), else — when the user allows it —
   * one the KBF authors published since (found upstream, not checked by the pack). Null when none.
   */
  function fingerprintFor(pack, modelId, state) {
    // A set the pack lists for this exact model beats an upstream one; an upstream set for it beats the pack's set of
    // another version (the closer reference).
    const listed = fingerprintMatch(pack, modelId);
    if (listed?.relation === "named") return { ...listed.set, relation: "named", upstream: false };
    const found = state.rules?.fingerprints;
    const upstream = pack.fingerprint && state.settings.fingerprintUpstream && found?.commit ? upstreamFor(pack, modelId, found) : null;
    if (upstream && (upstream.relation === "named" || !listed)) return upstream;
    return listed ? { ...listed.set, relation: listed.relation, upstream: false } : null;
  }

  /** An upstream set for a model (one the KBF authors published since; not checked by the pack): named, else a variant. */
  function upstreamFor(pack, modelId, found) {
    const value = String(modelId).toLowerCase();
    const usable = (found.sets ?? []).filter((set) => typeof set.name === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/.test(set.name));
    const newest = (sets) => sets.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const named = newest(usable.filter((set) => new RegExp(matchFor(set.name)).test(value)));
    const variant = named ? null : newest(usable.filter((set) => variantPatternOf(set.name)?.test(value)));
    const match = named ?? variant;
    if (!match) return null;
    // Requests, roughly, before the set is downloaded: about 380 bytes a probe, every `sample`-th asked, a batch per 10.
    const requests = Math.max(1, Math.ceil(match.bytes / 380 / pack.fingerprint.sample / pack.fingerprint.batchSize) + 8);
    return { id: match.id, name: match.name, model: match.name, date: match.date, path: match.path, commit: found.commit, repo: pack.fingerprint.source.repo, requests, upstream: true, relation: named ? "named" : "variant" };
  }

  /**
   * What one check request spent counts on a site's model (marked as checks) and the key that paid: its tokens, the
   * cached part (read, written) at its own price, as a conversation's request counts.
   */
  function meterOn(siteId, model, keyId, spent) {
    if (!spent?.requests) return;
    const tokens = { inputTokens: spent.input ?? 0, outputTokens: spent.output ?? 0, cacheReadTokens: spent.cacheRead ?? 0, cacheWriteTokens: spent.cacheWrite ?? 0 };
    usage?.record(siteId, model.id, { requests: spent.requests, input: tokens.inputTokens, output: tokens.outputTokens, cacheRead: tokens.cacheReadTokens, cacheWrite: tokens.cacheWriteTokens, probes: spent.requests, surcharge: surchargeOf(model, tokens, now()) });
    if (keyId) keys.noteUsage(keyId, tokens, estimateCost(model, tokens), model.id).catch(() => undefined);
  }

  /**
   * The meter a check reports each request to as it returns (a check stopped halfway has its requests counted):
   * the site's own model and key, or — a cross-site signature check's request — the other site's.
   */
  const meterFor = (siteId, model, active) => (spent, peer = null) => (peer ? meterOn(peer.endpoint.id, peer.model, peer.keyId, spent) : meterOn(siteId, model, active?.id, spent));

  /** Knowledge fingerprints waiting to resume after the start: site\0model → timer (stopped as runs are). */
  const resumeTimers = new Map();

  /**
   * Stop the active checks (and the automatic ones waiting to start) whose site\0model name matches: active testing
   * switched off, records cleared, the plugin unloading. A stopped check keeps nothing; its requests stay counted; a
   * knowledge fingerprint's progress stays as last saved (it resumes when active testing is on again, unless cleared).
   */
  function stopRuns(match = () => true) {
    for (const [name, run] of [...runs]) {
      if (!match(name)) continue;
      run.controller.abort();
      runs.delete(name);
    }
    for (const pending of [autoPending, resumeTimers]) {
      for (const [name, timer] of [...pending]) {
        if (!match(name)) continue;
        clearTimeout(timer);
        pending.delete(name);
      }
    }
  }

  /** The checks' spending on one model within the kept days: requests and tokens (a run under way included). */
  function spentOn(entry, job) {
    const out = { requests: 0, input: 0, output: 0 };
    for (const result of [...(entry.probes ?? []), ...(job ? [{ usage: job.usage }] : [])]) {
      out.requests += result.usage?.requests ?? 0;
      out.input += result.usage?.input ?? 0;
      out.output += result.usage?.output ?? 0;
    }
    return out;
  }

  /** The site and model a route's request goes to (a switch group's chosen member). */
  async function targetOf(route, modelId) {
    if (route === GROUP_ROUTE) {
      const group = (await settings.groups()).find((item) => item.id === modelId);
      const member = group ? group.members[group.active] ?? group.members[0] : undefined;
      const site = member ? await settings.site(member.site) : undefined;
      return site ? { site, model: findModel(site, member.model), group } : null;
    }
    const endpoint = endpointOfRoute(route);
    const site = endpoint ? await settings.site(endpoint.id) : undefined;
    return site && modelId ? { site, model: findModel(site, modelId), group: null } : null;
  }

  function channelView(pack, channel) {
    const named = (id) => {
      const entry = pack.channels.find((item) => item.id === id);
      return entry ? { id, name: entry.name } : null;
    };
    return { upstream: named(channel.upstream), relay: named(channel.relay), signals: channel.signals };
  }

  /**
   * What one active check costs: the usual requests, tokens and USD (where the model has a price), and the most it
   * may take (`maxRequests`, `maxUsd`: every retry and every output token the requests allow). A signature check's
   * requests to other sites count there: `peers` names those sites, `peerRequests` how many may go to them.
   * @param {{ name: string }[]} validators - the other sites a cross-site signature check may ask (see validatorsOf).
   */
  function estimates(pack, site, model, fingerprint = null, { validators = [], crossSite = true } = {}) {
    const protocol = protocolOf(site, model);
    const priced = (input, output) => {
      const value = estimateCost(model, { inputTokens: input, outputTokens: output });
      return Number.isFinite(value) ? value : null;
    };
    const quick = quickRequests(model, protocol);
    const peers = crossSite ? validators.slice(0, 2).map((item) => item.name) : [];
    // A fingerprint's request asks 80 output tokens a question; a model that cannot be kept from thinking gets ten
    // times as many (Chat, Responses) or 4,000 more (Messages).
    const fingerprintOut = protocol === "messages" ? 800 + 4_000 : 8_000;
    const fingerprintTries = fingerprint ? fingerprint.requests + (protocol === "messages" ? 2 : 5) : 0;
    return {
      identity: { requests: IDENTITY_REQUESTS, maxRequests: IDENTITY_REQUESTS, tokens: 300, usd: priced(260, 40), maxUsd: priced(300, IDENTITY_REQUESTS * 16) },
      // A forced tool call refused is asked once more, offered only.
      quick: { requests: quick, maxRequests: quick + 1, tokens: quick * 160, usd: priced(quick * 80, quick * 80), maxUsd: priced((quick + 1) * 200, (quick + 1) * 400) },
      // Three ways of asking for thinking (4,000 output tokens each), the block sent back tampered and as it was
      // (4,096 each); one request to each of up to two other sites.
      signature: signable(pack, site, model) ? { requests: 3, maxRequests: 5, tokens: 6_000, usd: priced(1_200, 4_800), maxUsd: priced(5 * 600, 3 * 4_000 + 2 * 4_096), peers, peerRequests: peers.length } : null,
      // Live 2026-11-09: about 270 input and 55 output tokens a request (ten short questions, numbers back), one request
      // more to find how the site is asked not to think (up to every way the protocol has).
      fingerprint: fingerprint ? { requests: fingerprint.requests + 1, maxRequests: fingerprintTries, tokens: (fingerprint.requests + 1) * 330, usd: priced((fingerprint.requests + 1) * 270, (fingerprint.requests + 1) * 60), maxUsd: priced(fingerprintTries * 300, fingerprintTries * fingerprintOut) } : null,
    };
  }

  /**
   * The other sites a cross-site signature check may ask (as peersFor chooses them, roughly, for the estimate): sites
   * taking part whose Claude model's latest signature check found the backend verifying signatures.
   */
  async function validatorsOf(state) {
    const out = [];
    for (const site of await settings.sites()) {
      if (site.enabled === false || site.authn === false) continue;
      const validates = site.models.some((stored) => probesOf(state.models[nameOf(site.id, stored.id)], site, findModel(site, stored.id)).filter((item) => item.kind === "signature").at(-1)?.validates === true);
      if (validates) out.push({ id: site.id, name: site.name });
    }
    return out;
  }

  function runView(name) {
    const run = runs.get(name);
    return run ? { kind: run.kind, step: run.step, steps: run.steps, startedAt: run.startedAt } : null;
  }

  /** The latest attempt of each kind, briefly (`failed`: none of its requests went through; the verdict rests on earlier results). */
  const lastProbes = (probes) => {
    const latest = {};
    for (const result of probes) {
      const items = result.items ?? [];
      // Nothing that could be judged (no usage returned, a request failed): no pass either.
      const outcome = items.some((item) => item.level === "hard") ? "hard" : items.some((item) => item.outcome === "fail") ? "fail" : items.some((item) => item.outcome === "pass") ? "pass" : "na";
      const failed = failedAttempt(result);
      latest[result.kind] = { at: result.at, outcome: failed ? "error" : result.outcome ?? outcome, ...(failed ? { failed: true } : {}), ...(result.auto ? { auto: true } : {}) };
    }
    return latest;
  };

  /**
   * Which configuration of a site's model a check result belongs to: the address it went to (its origin), the protocol
   * and the model id. A site moved to another address (another relay) is another site to the checks: its old results
   * no longer count. A result from before 0.8.0 has none and counts.
   */
  function configOf(site, model) {
    const endpoint = endpointById(site.id);
    let origin = "";
    try {
      const protocol = protocolOf(site, model);
      origin = new URL(protocol === "messages" && endpoint ? messagesBaseOf(endpoint, model) : site.baseUrl).origin;
    } catch {
      /* no address */
    }
    return createHash("sha256").update(JSON.stringify([origin, protocolOf(site, model), model.id])).digest("hex").slice(0, 16);
  }
  /** A model's check results of its current configuration. */
  const probesOf = (entry, site, model) => {
    const current = configOf(site, model);
    return (entry?.probes ?? []).filter((result) => result.cfg === undefined || result.cfg === current);
  };

  /** What relay sites' logs say of the models they served (relay/sync.js): site + model → facts. */
  let relayFacts = async () => ({});
  /** A model's site-log facts within the kept days (older ones count no more, as old observations do not). */
  const siteLogOf = (logs, siteId, modelId, keepDays = 30) => recentSiteLog(logs?.[`${siteId}\u0000${modelId}`] ?? null, now() - keepDays * 86_400_000);

  /** One model's state as the status bar and the page show it. */
  function modelView(pack, site, model, entry, sessionId, state = null, logs = null, validators = []) {
    const probes = probesOf(entry, site, model);
    const result = judge({ pack, observations: entry.obs, probes, model: { id: model.id, context: model.context, contextOrigin: model.contextOrigin }, siteLog: siteLogOf(logs, site.id, model.id, state?.settings?.keepDays), now: now() });
    const name = nameOf(site.id, model.id);
    const fingerprint = state ? fingerprintFor(pack, model.id, state) : null;
    const job = state?.jobs?.[name] ?? null;
    const run = runs.get(name);
    return {
      siteId: site.id,
      siteName: site.name,
      siteEnabled: site.enabled !== false,
      modelId: model.id,
      modelName: model.name ?? model.id,
      protocol: protocolOf(site, model),
      excluded: site.authn === false,
      identity: result.identity,
      service: result.service,
      channel: channelView(pack, result.channel),
      evidence: result.evidence,
      metrics: result.metrics,
      samples: { ...result.samples, ...(sessionId ? { here: entry.obs.filter((item) => item.s === String(sessionId).slice(0, 120)).length } : {}) },
      lastProbes: lastProbes(probes),
      run: runView(name),
      canSignature: signable(pack, site, model),
      fingerprint: fingerprintView(fingerprint),
      job: job ? { set: job.set, next: job.next } : null,
      spent: spentOn({ probes }, run?.kind === "fingerprint" ? null : job),
      estimates: estimates(pack, site, model, fingerprint, { validators: validators.filter((item) => item.id !== site.id), crossSite: state?.settings?.crossSite !== false }),
    };
  }

  // `relation`: the model is the set's reference model (`named`) or the same model under another version tag (`variant`);
  // `reference`: the reference model's id as recorded.
  const fingerprintView = (set) => (set ? { set: set.id, name: set.name, date: set.date, requests: set.requests, upstream: set.upstream === true, relation: set.relation ?? "named", reference: set.model ?? set.name } : null);

  /** Other sites whose backend was seen checking signatures, to check this site's against (cross-site). */
  async function peersFor(siteId, model) {
    const state = await store.read();
    const pack = updater.current();
    const asked = familyOf(pack, model.id);
    const out = [];
    for (const site of await settings.sites()) {
      if (site.id === siteId || site.enabled === false || site.authn === false) continue;
      const endpoint = endpointById(site.id);
      const active = await keys.active(site.id);
      if (!endpoint || (!active && !site.keyless)) continue;
      const candidates = [];
      for (const stored of site.models) {
        const probes = probesOf(state.models[nameOf(site.id, stored.id)], site, findModel(site, stored.id));
        const latest = probes.filter((item) => item.kind === "signature").at(-1);
        const family = familyOf(pack, stored.id);
        if (!latest?.validates || family?.family !== "claude") continue;
        const rank = stored.id === model.id ? 0 : asked?.tier && family.tier === asked.tier ? 1 : null;
        if (rank !== null) candidates.push({ rank, stored, latest });
      }
      const best = candidates.sort((a, b) => a.rank - b.rank)[0];
      if (best) out.push({ endpoint, model: findModel(site, best.stored.id), key: active?.key, keyId: active?.id ?? null, name: site.name, thinking: best.latest.thinking ?? undefined });
    }
    return out;
  }

  /** Models whose automatic identity check is pending (a short delay gathers a burst of answers), and when each last started. */
  const autoPending = new Map();
  const autoStarted = new Map();
  function scheduleAutoIdentity(siteId, modelId) {
    if (!activeOn) return;
    const name = nameOf(siteId, modelId);
    if (autoPending.has(name)) return;
    const timer = setTimeout(() => {
      autoPending.delete(name);
      autoIdentity(siteId, modelId).catch((error) => log("warn", `authn automatic identity check skipped: ${redact(error?.message ?? error)}`));
    }, AUTO_DELAY_MS);
    timer.unref?.();
    autoPending.set(name, timer);
  }

  /**
   * An identity check by itself, when passive monitoring doubts a model's identity: active testing on, the setting on,
   * the site taking part, no identity check on that model within the chosen interval (one that failed counts too), and
   * fewer automatic checks in the last 24 hours, all models together, than the daily cap (the ones running included).
   */
  async function autoIdentity(siteId, modelId) {
    const state = await store.read();
    if (!activeOn || !state.settings.autoIdentity) return null;
    const name = nameOf(siteId, modelId);
    if (runs.has(name)) return null;
    const site = await settings.site(siteId);
    if (!site || site.enabled === false || site.authn === false) return null;
    const pack = updater.current();
    if (!pack.identity?.tokenizer) return null;
    const entry = state.models[name];
    if (!entry) return null;
    const interval = state.settings.autoIdentityMinutes * 60_000;
    const lastCheck = entry.probes.filter((item) => item.kind === "identity").at(-1)?.at ?? 0;
    const current = probesOf(entry, site, findModel(site, modelId));
    if (now() - lastCheck < interval || now() - (autoStarted.get(name) ?? 0) < interval) return null;
    const dayAgo = now() - 86_400_000;
    const today = Object.values(state.models).reduce((sum, item) => sum + item.probes.filter((probe) => probe.auto === true && probe.at >= dayAgo).length, 0) + [...runs.values()].filter((run) => run.auto).length;
    if (today >= state.settings.autoIdentityDaily) {
      log("info", `${siteId}/${modelId}: automatic identity check skipped, ${today} in the last 24 hours (cap ${state.settings.autoIdentityDaily})`);
      return null;
    }
    const model = findModel(site, modelId);
    const logs = await relayFacts().catch(() => ({}));
    const result = judge({ pack, observations: entry.obs, probes: current, model: { id: model.id, context: model.context, contextOrigin: model.contextOrigin }, siteLog: siteLogOf(logs, siteId, modelId, state.settings.keepDays), now: now() });
    const doubt = result.evidence.some((item) => (item.source === "passive" || item.source === "site-log") && item.axis === "identity" && (item.level === "soft" || item.level === "hard"));
    if (!doubt) return null;
    autoStarted.set(name, now());
    log("info", `${siteId}/${modelId}: passive monitoring doubts the identity; automatic identity check`);
    return service.probe({ siteId, modelId, kind: "identity", auto: true });
  }

  /** Knowledge-fingerprint sets the KBF repository holds that the pack does not list (kept with the rule pack's state). */
  async function discoverFingerprints() {
    const pack = updater.current();
    if (!pack.fingerprint) return null;
    try {
      const found = await library.discover(pack);
      await store.setRules({ fingerprints: { ...found, error: null } });
      return found;
    } catch (error) {
      const before = (await store.read()).rules?.fingerprints ?? {};
      await store.setRules({ fingerprints: { ...before, checkedAt: now(), error: redact(String(error?.message ?? error)).slice(0, 160) } });
      return null;
    }
  }

  const service = {
    ready,
    updater,
    store,
    /** Whether passive monitoring is on (the adapter reads no answer when not). */
    enabled: () => passiveOn,

    /**
     * Keep one answer, when the feature is on, the site takes part and the conversation is tracked.
     * `build(pack)` makes the observation (observe.js) only then.
     */
    async observe({ siteId, modelId, sessionId, build }) {
      if (!passiveOn) return;
      await ready;
      const site = await settings.site(siteId);
      if (!site || site.authn === false) return;
      if (!(await store.tracked(sessionId))) return;
      try {
        const observation = build(updater.current());
        if (observation) {
          store.add(siteId, modelId, observation);
          scheduleAutoIdentity(siteId, modelId);
        }
      } catch (error) {
        log("warn", `authn observation skipped: ${redact(error?.message ?? error)}`);
      }
    },

    /** What a conversation's status bar shows (`route` and `model` from DSH's model selection). */
    async session({ sessionId, route, model }) {
      await ready;
      const state = await store.read();
      const sessionKey = sessionId ? String(sessionId).slice(0, 120) : null;
      const own = sessionKey && Object.hasOwn(state.sessions, sessionKey) ? state.sessions[sessionKey] : undefined;
      const base = { enabled: state.settings.enabled, passive: state.settings.passive, active: state.settings.active, dock: state.settings.dock, confirmProbes: state.settings.confirmProbes, rules: { version: updater.current().version } };
      if (!state.settings.enabled) return base;
      const tracked = own ? own.on : state.settings.passiveDefault;
      const target = typeof route === "string" && route.startsWith("custom-") ? await targetOf(route, model) : null;
      if (!target) return { ...base, tracked, switched: own ? own.on : null, target: null };
      const pack = updater.current();
      const entry = state.models[nameOf(target.site.id, target.model.id)] ?? { obs: [], probes: [] };
      const logs = await relayFacts().catch(() => ({}));
      const validators = await validatorsOf(state);
      return { ...base, tracked, switched: own ? own.on : null, target: { ...modelView(pack, target.site, target.model, entry, sessionId, state, logs, validators), group: target.group?.name ?? null } };
    },

    /** Every model of every site, for the 模型核验 page; the settings and the rule pack's state. */
    async report() {
      await ready;
      const state = await store.read();
      const pack = updater.current();
      const rows = [];
      const logs = await relayFacts().catch(() => ({}));
      const validators = await validatorsOf(state);
      for (const site of await settings.sites()) {
        for (const stored of site.models) {
          const model = findModel(site, stored.id);
          rows.push(modelView(pack, site, model, state.models[nameOf(site.id, model.id)] ?? { obs: [], probes: [] }, null, state, logs, validators));
        }
      }
      const fp = pack.fingerprint;
      const found = state.rules?.fingerprints ?? null;
      const fingerprints = fp ? { source: fp.source, sets: fp.sets.length, latest: fp.sets.map((set) => set.date).sort().at(-1) ?? null, upstream: found ? { checkedAt: found.checkedAt ?? null, sets: (found.sets ?? []).length, error: found.error ?? null } : null } : null;
      return { settings: state.settings, rules: await updater.status(), fingerprints, rows };
    },

    async track({ sessionId, on }) {
      if (!sessionId) throw cnError(CODES.badRequest, "缺少对话 ID");
      await store.setTracked(sessionId, on === true);
      return { tracked: on === true };
    },

    async saveSettings(patch) {
      const next = await store.saveSettings(patch);
      const wasActive = activeOn;
      passiveOn = next.passive;
      activeOn = next.active;
      if (activeOn && !wasActive) void resumeJobs();
      // Active testing off: no check goes on sending requests.
      if (!activeOn && wasActive) stopRuns();
      return next;
    },

    /** Start an active check (`identity`, `quick` or `signature`) on one site's model; it runs on, the status says how far. */
    async probe({ siteId, modelId, kind, auto = false, resume = false }) {
      await ready;
      if (!activeOn) throw cnError(CODES.badRequest, "主动检测未启用：请在「Custom」标签页的「模型核验」页开启");
      const site = await settings.site(siteId);
      if (!site) throw cnError(CODES.badRequest, `站点 ${siteId} 不存在`);
      if (site.authn === false) throw cnError(CODES.badRequest, `站点「${site.name}」未参与模型核验`);
      const endpoint = endpointById(siteId);
      const model = findModel(site, modelId);
      const pack = updater.current();
      if (kind === "signature" && !signable(pack, site, model)) throw cnError(CODES.badRequest, "签名校验仅适用于使用 Anthropic Messages 协议的 Claude 模型");
      const active = await keys.active(siteId);
      if (!active && !site.keyless) throw cnError(CODES.missing, `站点「${site.name}」尚未配置 API Key`);
      if (!["identity", "quick", "signature", "fingerprint"].includes(kind)) throw cnError(CODES.badRequest, `未知的检测类型：${kind}`);
      const name = nameOf(siteId, model.id);
      if (runs.has(name)) return { run: runView(name) };
      const controller = new AbortController();
      // The model's slot is taken before anything is awaited: a second start meanwhile joins this run.
      const run = { kind, step: 0, steps: kind === "quick" ? quickRequests(model, protocolOf(site, model)) : kind === "identity" ? IDENTITY_REQUESTS : 3, startedAt: now(), controller, auto };
      runs.set(name, run);
      let set = null;
      try {
        const state = await store.read();
        set = kind === "fingerprint" ? fingerprintFor(pack, model.id, state) : null;
        if (kind === "fingerprint" && !set) {
          if (resume) await store.setJob(siteId, model.id, null);
          throw cnError(CODES.badRequest, "规则库暂无该模型的知识指纹题库");
        }
      } catch (error) {
        if (runs.get(name) === run) runs.delete(name);
        throw error;
      }
      if (set) run.steps = set.requests + 1;
      // Stopped while it was set up (active testing off, records cleared): nothing is sent.
      if (controller.signal.aborted) return { run: null };
      const meter = meterFor(siteId, model, active);
      const onStep = (step, steps) => Object.assign(run, { step, steps: Math.max(step, steps) });
      void (async () => {
        let result;
        try {
          if (kind === "identity") result = await identityCheck({ pack, endpoint, model, key: active?.key, fetchImpl, signal: controller.signal, onStep, now, meter });
          else if (kind === "quick") result = await quickCheck({ pack, endpoint, model, key: active?.key, fetchImpl, signal: controller.signal, onStep, now, meter });
          else if (kind === "fingerprint") {
            const data = await library.load(pack, set, { signal: controller.signal });
            const kept = (await store.jobs())[name];
            try {
              result = await fingerprintCheck({
                pack, entry: set, data, endpoint, model, key: active?.key, fetchImpl, signal: controller.signal, onStep, now,
                ...(sleep ? { sleep } : {}),
                state: kept?.set === set.id ? kept : null,
                save: (job) => (controller.signal.aborted ? undefined : store.setJob(siteId, model.id, job)),
                meter: (spent) => meter(spent),
                busy: () => traffic(siteId) > 0,
              });
            } catch (error) {
              if (!(error instanceof KeyRefused)) throw error;
              result = { kind, at: now(), items: [{ id: "kbf", outcome: "error", level: "info", key: "probe.kbfKeyRefused", params: { status: error.status } }], usage: { requests: 0, input: 0, output: 0 }, metered: true };
            }
            await store.setJob(siteId, model.id, null);
          }
          else result = await signatureCheck({ pack, endpoint, model, key: active?.key, peers: (await store.settings()).crossSite ? await peersFor(siteId, model) : [], fetchImpl, signal: controller.signal, onStep, now, meter });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (kind === "fingerprint" && /download|SHA-256|set/i.test(String(error?.message ?? ""))) await store.setJob(siteId, model.id, null).catch(() => undefined);
          result = { kind, at: now(), items: [{ id: "run", outcome: "error", level: "info", key: "probe.runFailed", params: { error: redact(String(error?.message ?? error)).slice(0, 160) } }], usage: { requests: 0, input: 0, output: 0 } };
        } finally {
          if (runs.get(name) === run) runs.delete(name);
        }
        if (controller.signal.aborted || !result) return;
        // Each request was counted as it returned (`meter`): on the site's model and key, marked as checks; a
        // cross-site signature check's on the other site's.
        const { peerUsage: _peers, ...kept } = { ...result, ...(auto ? { auto: true } : {}), cfg: configOf(site, model) };
        await store.addProbe(siteId, model.id, kept).catch((error) => log("warn", `authn result not kept: ${redact(error?.message ?? error)}`));
        log("info", `${siteId}/${model.id}: authn ${auto ? "automatic " : ""}${kind} check, ${result.usage?.requests ?? 0} request(s)`);
      })();
      return { run: runView(name) };
    },

    async cancel({ siteId, modelId }) {
      const name = nameOf(siteId, modelId);
      runs.get(name)?.controller.abort();
      runs.delete(name);
      // A knowledge fingerprint stopped by hand is dropped (its requests stay counted).
      await store.setJob(siteId, modelId, null);
      return { cancelled: true };
    },

    /** The rule pack: `check` for an update now, `rollback` to the plugin's own, `fingerprints` to look for new sets upstream. */
    async rules({ action }) {
      await ready;
      if (action === "rollback") await updater.rollback();
      else if (action === "check") await updater.check({ force: true });
      else if (action === "fingerprints") await discoverFingerprints();
      return updater.status();
    },

    /** Forget observations and results: one model's, one site's, or all. */
    async clear({ siteId, modelId }) {
      // A model alone names nothing: it is a site's.
      if (modelId && !siteId) throw cnError(CODES.badRequest, "清除单个模型的记录时须同时指定站点");
      // A check still running on what is cleared stops first: it would keep a result for records just forgotten.
      stopRuns((name) => {
        const [site, model] = name.split("\u0000");
        return !siteId || (site === siteId && (!modelId || model === modelId));
      });
      await store.clear(siteId ? { site: siteId, ...(modelId ? { model: modelId } : {}) } : { all: true });
      return { cleared: true };
    },

    /** The background update: on start (once the app settled) and every day while on — the rule pack and the upstream sets. */
    async scheduledUpdate() {
      await ready;
      const state = await store.read();
      if (!state.settings.enabled || !state.settings.autoUpdate) return null;
      await discoverFingerprints().catch(() => undefined);
      if (!updater.configured(state.settings)) return null;
      return updater.check();
    },

    /** The adapter's count of the user's own requests per site (a background run waits for them). */
    setTraffic(count) {
      if (typeof count === "function") traffic = count;
    },

    /** Where relay sites' log facts come from (relay/sync.js), and whether they are gathered: passive monitoring on. */
    setRelayFacts(read) {
      if (typeof read === "function") relayFacts = read;
    },
    async passiveOn() {
      await ready;
      return (await store.read()).settings.passive === true;
    },

    /** Write what is gathered (the plugin is unloading): running checks stop, pending automatic ones are dropped. */
    flush: () => {
      stopRuns();
      return store.flush();
    },
    /** For tests: the automatic identity check's decision, now. */
    autoIdentity,
  };
  return service;
}
