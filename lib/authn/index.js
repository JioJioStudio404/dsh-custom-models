/**
 * Model verification ("模型核验"), an add-on of the Custom tab the
 * user switches on: passive scanning of the conversations it tracks (no
 * request of its own), active checks on demand, the rule pack (built in,
 * updatable), and what the status bar and the 模型核验 page show. Nothing here
 * switches a key or a site, or blocks a request: it tells.
 *
 * @module dsh-custom-models/authn
 */
import { endpointById, endpointOfRoute, GROUP_ROUTE } from "../endpoints.js";
import { cnError, CODES, redact } from "../errors.js";
import { estimateCost, findModel } from "../models.js";
import { FingerprintLibrary, fingerprintCheck, KeyRefused, matchFor } from "./fingerprint.js";
import { judge } from "./judge.js";
import { useSalt } from "./observe.js";
import { IDENTITY_REQUESTS, identityCheck, quickCheck, quickRequests } from "./probes.js";
import { familyOf, fingerprintSetsFor } from "./rules.js";
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
      if (runs.has(name)) continue;
      const timer = setTimeout(() => {
        service.probe({ siteId, modelId, kind: "fingerprint", resume: true }).catch((error) => log("warn", `authn fingerprint not resumed: ${redact(error?.message ?? error)}`));
      }, resumeDelayMs);
      timer.unref?.();
    }
  }

  /**
   * The knowledge-fingerprint set for a model: one the rule pack lists (newest first), else — when the user allows it —
   * one the KBF authors published since (found upstream, not checked by the pack). Null when none.
   */
  function fingerprintFor(pack, modelId, state) {
    const listed = fingerprintSetsFor(pack, modelId).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (listed) return { ...listed, upstream: false };
    const found = state.rules?.fingerprints;
    if (!pack.fingerprint || !state.settings.fingerprintUpstream || !found?.commit) return null;
    const value = String(modelId).toLowerCase();
    const match = (found.sets ?? []).filter((set) => typeof set.name === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/.test(set.name) && new RegExp(matchFor(set.name)).test(value)).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    if (!match) return null;
    // Requests, roughly, before the set is downloaded: about 380 bytes a probe, every `sample`-th asked, a batch per 10.
    const requests = Math.max(1, Math.ceil(match.bytes / 380 / pack.fingerprint.sample / pack.fingerprint.batchSize) + 8);
    return { id: match.id, name: match.name, date: match.date, path: match.path, commit: found.commit, repo: pack.fingerprint.source.repo, requests, upstream: true };
  }

  /** What a check's request cost counts on: the site's model (marked as checks) and the key that paid. */
  function meterSpent(siteId, model, active, spent) {
    if (!spent?.requests) return;
    usage?.record(siteId, model.id, { requests: spent.requests, input: spent.input, output: spent.output, probes: spent.requests });
    if (active?.id) {
      const tokens = { inputTokens: spent.input, outputTokens: spent.output };
      keys.noteUsage(active.id, tokens, estimateCost(model, tokens), model.id).catch(() => undefined);
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

  /** What one active check costs, roughly: requests, tokens, and USD where the model has a price. */
  function estimates(pack, site, model, fingerprint = null) {
    const protocol = protocolOf(site, model);
    const priced = (input, output) => {
      const value = estimateCost(model, { inputTokens: input, outputTokens: output });
      return Number.isFinite(value) ? value : null;
    };
    const quick = quickRequests(model, protocol);
    return {
      identity: { requests: IDENTITY_REQUESTS, tokens: 300, usd: priced(260, 40) },
      quick: { requests: quick, tokens: quick * 160, usd: priced(quick * 80, quick * 80) },
      signature: signable(pack, site, model) ? { requests: 3, tokens: 6_000, usd: priced(1_200, 4_800) } : null,
      // Live 2026-11-09: about 270 input and 55 output tokens a request (ten short questions, numbers back), one request
      // more to find how the site is asked not to think.
      fingerprint: fingerprint ? { requests: fingerprint.requests + 1, tokens: (fingerprint.requests + 1) * 330, usd: priced((fingerprint.requests + 1) * 270, (fingerprint.requests + 1) * 60) } : null,
    };
  }

  function runView(name) {
    const run = runs.get(name);
    return run ? { kind: run.kind, step: run.step, steps: run.steps, startedAt: run.startedAt } : null;
  }

  /** The latest result of each kind, briefly. */
  const lastProbes = (probes) => {
    const latest = {};
    for (const result of probes) {
      const items = result.items ?? [];
      // Nothing that could be judged (no usage returned, a request failed): no pass either.
      const outcome = items.some((item) => item.level === "hard") ? "hard" : items.some((item) => item.outcome === "fail") ? "fail" : items.some((item) => item.outcome === "pass") ? "pass" : "na";
      latest[result.kind] = { at: result.at, outcome: result.outcome ?? outcome, ...(result.auto ? { auto: true } : {}) };
    }
    return latest;
  };

  /** What relay sites' logs say of the models they served (relay/sync.js): site + model → facts. */
  let relayFacts = async () => ({});
  const siteLogOf = (logs, siteId, modelId) => logs?.[`${siteId}\u0000${modelId}`] ?? null;

  /** One model's state as the status bar and the page show it. */
  function modelView(pack, site, model, entry, sessionId, state = null, logs = null) {
    const result = judge({ pack, observations: entry.obs, probes: entry.probes, model: { id: model.id, context: model.context, contextOrigin: model.contextOrigin }, siteLog: siteLogOf(logs, site.id, model.id), now: now() });
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
      lastProbes: lastProbes(entry.probes),
      run: runView(name),
      canSignature: signable(pack, site, model),
      fingerprint: fingerprintView(fingerprint),
      job: job ? { set: job.set, next: job.next } : null,
      spent: spentOn(entry, run?.kind === "fingerprint" ? null : job),
      estimates: estimates(pack, site, model, fingerprint),
    };
  }

  const fingerprintView = (set) => (set ? { set: set.id, name: set.name, date: set.date, requests: set.requests, upstream: set.upstream === true } : null);

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
        const probes = state.models[nameOf(site.id, stored.id)]?.probes ?? [];
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
   * the site taking part, and no identity check on that model within the chosen interval (one that failed counts too).
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
    if (now() - lastCheck < interval || now() - (autoStarted.get(name) ?? 0) < interval) return null;
    const model = findModel(site, modelId);
    const logs = await relayFacts().catch(() => ({}));
    const result = judge({ pack, observations: entry.obs, probes: entry.probes, model: { id: model.id, context: model.context, contextOrigin: model.contextOrigin }, siteLog: siteLogOf(logs, siteId, modelId), now: now() });
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
      const own = sessionId ? state.sessions[String(sessionId).slice(0, 120)] : undefined;
      const base = { enabled: state.settings.enabled, passive: state.settings.passive, active: state.settings.active, dock: state.settings.dock, confirmProbes: state.settings.confirmProbes, rules: { version: updater.current().version } };
      if (!state.settings.enabled) return base;
      const tracked = own ? own.on : state.settings.passiveDefault;
      const target = typeof route === "string" && route.startsWith("custom-") ? await targetOf(route, model) : null;
      if (!target) return { ...base, tracked, switched: own ? own.on : null, target: null };
      const pack = updater.current();
      const entry = state.models[nameOf(target.site.id, target.model.id)] ?? { obs: [], probes: [] };
      const logs = await relayFacts().catch(() => ({}));
      return { ...base, tracked, switched: own ? own.on : null, target: { ...modelView(pack, target.site, target.model, entry, sessionId, state, logs), group: target.group?.name ?? null } };
    },

    /** Every model of every site, for the 模型核验 page; the settings and the rule pack's state. */
    async report() {
      await ready;
      const state = await store.read();
      const pack = updater.current();
      const rows = [];
      const logs = await relayFacts().catch(() => ({}));
      for (const site of await settings.sites()) {
        for (const stored of site.models) {
          const model = findModel(site, stored.id);
          rows.push(modelView(pack, site, model, state.models[nameOf(site.id, model.id)] ?? { obs: [], probes: [] }, null, state, logs));
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
      const name = nameOf(siteId, model.id);
      if (runs.has(name)) return { run: runView(name) };
      const controller = new AbortController();
      if (!["identity", "quick", "signature", "fingerprint"].includes(kind)) throw cnError(CODES.badRequest, `未知的检测类型：${kind}`);
      const state = await store.read();
      const set = kind === "fingerprint" ? fingerprintFor(pack, model.id, state) : null;
      if (kind === "fingerprint" && !set) {
        if (resume) await store.setJob(siteId, model.id, null);
        throw cnError(CODES.badRequest, "规则库暂无该模型的知识指纹题库");
      }
      const run = { kind, step: 0, steps: kind === "quick" ? quickRequests(model, protocolOf(site, model)) : kind === "identity" ? IDENTITY_REQUESTS : kind === "fingerprint" ? set.requests + 1 : 3, startedAt: now(), controller };
      runs.set(name, run);
      const onStep = (step, steps) => Object.assign(run, { step, steps: Math.max(step, steps) });
      void (async () => {
        let result;
        try {
          if (kind === "identity") result = await identityCheck({ pack, endpoint, model, key: active?.key, fetchImpl, signal: controller.signal, onStep, now });
          else if (kind === "quick") result = await quickCheck({ pack, endpoint, model, key: active?.key, fetchImpl, signal: controller.signal, onStep, now });
          else if (kind === "fingerprint") {
            const data = await library.load(pack, set);
            const kept = (await store.jobs())[name];
            try {
              result = await fingerprintCheck({
                pack, entry: set, data, endpoint, model, key: active?.key, fetchImpl, signal: controller.signal, onStep, now,
                ...(sleep ? { sleep } : {}),
                state: kept?.set === set.id ? kept : null,
                save: (job) => (controller.signal.aborted ? undefined : store.setJob(siteId, model.id, job)),
                meter: (spent) => meterSpent(siteId, model, active, spent),
                busy: () => traffic(siteId) > 0,
              });
            } catch (error) {
              if (!(error instanceof KeyRefused)) throw error;
              result = { kind, at: now(), items: [{ id: "kbf", outcome: "error", level: "info", key: "probe.kbfKeyRefused", params: { status: error.status } }], usage: { requests: 0, input: 0, output: 0 }, metered: true };
            }
            await store.setJob(siteId, model.id, null);
          }
          else result = await signatureCheck({ pack, endpoint, model, key: active?.key, peers: (await store.settings()).crossSite ? await peersFor(siteId, model) : [], fetchImpl, signal: controller.signal, onStep, now });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (kind === "fingerprint" && /download|SHA-256|set/i.test(String(error?.message ?? ""))) await store.setJob(siteId, model.id, null).catch(() => undefined);
          result = { kind, at: now(), items: [{ id: "run", outcome: "error", level: "info", key: "probe.runFailed", params: { error: redact(String(error?.message ?? error)).slice(0, 160) } }], usage: { requests: 0, input: 0, output: 0 } };
        } finally {
          if (runs.get(name) === run) runs.delete(name);
        }
        if (controller.signal.aborted || !result) return;
        const { peerUsage = [], ...kept } = auto ? { ...result, auto: true } : result;
        await store.addProbe(siteId, model.id, kept).catch((error) => log("warn", `authn result not kept: ${redact(error?.message ?? error)}`));
        // Requests to other sites (cross-site signature checks) count on those sites and keys.
        for (const { peer, requests, input, output } of peerUsage) {
          if (!requests) continue;
          usage?.record(peer.endpoint.id, peer.model.id, { requests, input, output, probes: requests });
          const spent = { inputTokens: input, outputTokens: output };
          if (peer.keyId) keys.noteUsage(peer.keyId, spent, estimateCost(peer.model, spent), peer.model.id).catch(() => undefined);
        }
        // What the checks cost counts on the site's model and the key, marked as checks.
        // (A knowledge fingerprint counted each request as it went.)
        if (!result.metered) meterSpent(siteId, model, active, result.usage);
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

    /** Write what is gathered (the plugin is unloading); pending automatic checks are dropped. */
    flush: () => {
      for (const timer of autoPending.values()) clearTimeout(timer);
      autoPending.clear();
      return store.flush();
    },
    /** For tests: the automatic identity check's decision, now. */
    autoIdentity,
  };
  return service;
}
