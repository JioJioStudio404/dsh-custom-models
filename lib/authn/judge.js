/**
 * The judgement: one site's model, from its observations (passive monitoring)
 * and the active checks' results, under a rule pack. Pure: same input, same
 * answer. Two questions, answered apart:
 *
 * - 模型身份 (identity): is this the model the site names? Hard evidence: the
 *   site echoing another family, tier or version; the identity check's
 *   tokenizer matching another Claude generation; one long answer to
 *   different questions (no model at all); a forged signature. Soft: the
 *   characters per token outside the family's range or drifting, a tokenizer
 *   matching another vendor's (or the site counting usage itself), upstreams
 *   of different vendors mixed. Positive: a signature another site's backend
 *   accepted (已确认), the identity check's tokenizer matching (相符), the
 *   characters per token in range over enough answers (未见替换).
 * - 服务表现 (service): does the site serve it faithfully? Replays, notices
 *   instead of answers, limits not honoured, empty answers, unusable tool
 *   calls, usage far from what was sent, speed drifting, "too long" early.
 *
 * Drifts against the model's own earlier answers are decided by a sign
 * e-process (the share of answers above the earlier median, bet on both ways;
 * an alarm at 1/α) and must also be large enough to matter. The channel
 * (where answers come from) is shown apart. Nothing passive proves a model
 * genuine.
 *
 * @module dsh-custom-models/authn/judge
 */
import { familyOf, joinNames, versionOf } from "./rules.js";

/**
 * Which question a piece of evidence answers: `identity` (is this the model the site names?), `service` (does the
 * site serve it faithfully: notices, cut limits, empty answers, usage …) or `info` (shown, judging nothing).
 */
// Speed (load moves it) and an image the relay may not pass are the site's service; a tokenizer's figures are the model's.
const IDENTITY_EVIDENCE = new Set(["echo-mismatch", "echo-version", "fixed-answer", "cpt-band-en", "cpt-band-zh", "cpt-drift-en", "cpt-drift-zh", "input-step", "quick:echo", "relay-mapped", "relay-returned"]);
function axisOf(item) {
  if (item.level === "info" && !String(item.id).startsWith("identity:") && !String(item.id).startsWith("fingerprint:")) return "info";
  if (item.id === "channel-drift") return "identity";
  if (IDENTITY_EVIDENCE.has(item.id) || item.source === "identity" || item.source === "signature" || item.source === "fingerprint") return "identity";
  return "service";
}

const median = (values) => {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};

/**
 * A sign e-process over a series against the median of its first `baseline` values: the mixture of
 * "above" and "below" bets (λ each). Valid at any stopping time (Ville), so it may be read after every answer.
 * @returns `{ e, base, recent }` or null when the series is too short.
 */
export function signDrift(values, { baseline, lambda }) {
  const series = values.filter((value) => Number.isFinite(value));
  if (series.length < baseline + 5) return null;
  const base = median(series.slice(0, baseline));
  let up = 1;
  let down = 1;
  for (const value of series.slice(baseline)) {
    if (value === base) continue;
    const sign = value > base ? 1 : -1;
    up *= 1 + lambda * sign;
    down *= 1 - lambda * sign;
  }
  return { e: (up + down) / 2, base, recent: median(series.slice(-10)) };
}

/** The upstream and relay channels one observation's signals point to. */
function channelsOf(pack, observation) {
  const byId = new Map(pack.channels.map((channel) => [channel.id, channel]));
  const scores = new Map();
  for (const signalId of observation.sm ?? []) {
    const signal = pack.signals.find((item) => item.id === signalId);
    if (!signal?.channel) continue;
    scores.set(signal.channel, (scores.get(signal.channel) ?? 0) + signal.weight);
  }
  // A child channel (AWS Bedrock) takes its parent's votes (a cloud platform).
  for (const [channelId] of scores) {
    const parent = byId.get(channelId)?.parent;
    if (parent && scores.has(parent)) {
      scores.set(channelId, scores.get(channelId) + scores.get(parent));
      scores.delete(parent);
    }
  }
  const best = (layer) => [...scores].filter(([channelId]) => (byId.get(channelId)?.layer ?? "upstream") === layer).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { upstream: best("upstream"), relay: best("relay") };
}

const ARN = /^arn:aws:bedrock:/i;

/**
 * Whether an id's form has a random part long enough that two answers never share it by chance (Ollama numbers its
 * answers `chatcmpl-0` … `chatcmpl-998`: those collide, and say nothing).
 */
export const uniqueIdForm = (shape) => (String(shape ?? "").replace(/^[^9aA]*?[a]+[_-]/, "").match(/[9aA]/g) ?? []).length >= 16;

/**
 * Thinking whose tokens the usage does not count apart: the output holds them, in an unknown share (a summary shown, as
 * Claude's, is shorter than the thinking billed). Such an answer says nothing about speed or characters per token.
 */
const hiddenThinking = (item) => Boolean(item.th && !item.rt);

/** Output tokens of the visible text (the answer and its tool arguments): the output less counted reasoning; null when unknown. */
function visibleTokensOf(item) {
  if (item.ec || item.rd || hiddenThinking(item)) return null;
  return (item.out ?? 0) - (item.rt ?? 0);
}

/**
 * Output speed as DSH counts it (tokens from the first one to the end): reasoning streamed as text counts with the answer;
 * reasoning counted but never shown is left out; hidden thinking of unknown size leaves the answer out (null).
 */
export function speedOf(item) {
  if (item.ec || item.rd || hiddenThinking(item)) return null;
  const tokens = item.rc ? item.out ?? 0 : (item.out ?? 0) - (item.rt ?? 0);
  return tokens >= 50 && (item.dm ?? 0) >= 300 ? tokens / (item.dm / 1000) : null;
}

/** Characters per token of an answer's visible text (tool arguments too when asked); null when unknown or too short. */
export function cptOf(item, th, { withArguments = false } = {}) {
  const tokens = visibleTokensOf(item);
  if (tokens === null || tokens < th.cptMinTokens) return null;
  const chars = (item.vc ?? 0) + (withArguments ? item.ac ?? 0 : 0);
  return chars > 0 ? chars / tokens : null;
}

/** Reported input over the plugin's own estimate of what was sent (null for small requests and images). */
export function inputRatioOf(item, th) {
  return !item.img && (item.in ?? 0) > 0 && (item.est ?? 0) >= th.inputMinEst ? item.in / item.est : null;
}

/** Two values each holding at least `share` of a list, most frequent first, or null. */
function split(values, share) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  const total = values.filter(Boolean).length;
  const big = [...counts].filter(([, count]) => count / total >= share).sort((a, b) => b[1] - a[1]);
  return big.length >= 2 ? big.map(([value, count]) => ({ value, count })) : null;
}

/**
 * Judge one model of one site.
 * @param {object} input - `pack`, `observations` (oldest first), `probes` (active check results, oldest first),
 *   `model` (`{ id, context }`: the id requested), `now`.
 * @returns `{ identity: { state, likely }, service: { state, problems }, channel, evidence, metrics, samples }`; evidence items are
 *   `{ id, axis, level, source, key, params, note, at, count, likely }`
 *   (`level` hard / soft / info / pass; `key` a page dictionary key, `note` a rule pack text `{ zh, en }`).
 */
export function judge({ pack, observations = [], probes = [], model = {}, siteLog = null, now = Date.now() }) {
  const th = pack.thresholds;
  const evidence = [];
  const add = (item) => evidence.push({ source: "passive", count: 1, params: {}, ...item });

  // ---- the site's own log (new-api): the model it says it served. Its own word that it mapped the model to another
  // (by version or size) is hard evidence; another spelling of the same model is no evidence, a variant (a thinking or
  // preview build) is shown only; the upstream answering as another model, and a system prompt the site overwrote, are
  // doubts.
  for (const [name, value] of Object.entries(siteLog?.mapped ?? {})) {
    const different = value.relation === "different";
    add({ id: "relay-mapped", source: "site-log", level: different ? "hard" : "info", key: different ? "ev.relayMapped" : "ev.relayVariant", params: { upstream: name, n: value.n, total: siteLog.checked ?? value.n }, count: value.n, at: value.at, ...(different ? { likely: name } : {}) });
  }
  for (const [name, value] of Object.entries(siteLog?.returned ?? {})) {
    const different = value.relation === "different";
    add({ id: "relay-returned", source: "site-log", level: different ? "soft" : "info", key: "ev.relayReturned", params: { returned: name, n: value.n, total: siteLog.checked ?? value.n }, count: value.n, at: value.at, ...(different ? { likely: name } : {}) });
  }
  if (siteLog?.overwritten?.n) add({ id: "relay-prompt", source: "site-log", level: "soft", key: "ev.relayPrompt", params: { n: siteLog.overwritten.n, total: siteLog.checked ?? siteLog.overwritten.n }, count: siteLog.overwritten.n, at: siteLog.overwritten.at });
  const served = observations.filter((item) => item.ok);
  const recent = served.slice(-th.driftWindow);

  // ---- channel
  // The active checks' own answers count too (a model only checked, never used, still shows its channel).
  const probeWire = probes.filter((result) => Array.isArray(result.channel) && result.channel.length).slice(-3).map((result) => ({ sm: result.channel }));
  const perAnswer = [...recent, ...probeWire].map((item) => channelsOf(pack, item));
  const upstreams = perAnswer.map((item) => item.upstream);
  const relays = perAnswer.map((item) => item.relay);
  const mostOf = (values) => {
    const counts = new Map();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const channel = { upstream: mostOf(upstreams), relay: mostOf(relays), signals: [] };
  const seenSignals = new Map();
  for (const item of [...recent, ...probeWire]) for (const signalId of item.sm ?? []) seenSignals.set(signalId, (seenSignals.get(signalId) ?? 0) + 1);
  channel.signals = [...seenSignals].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([signalId]) => {
    const signal = pack.signals.find((item) => item.id === signalId);
    return signal ? { id: signal.id, note: signal.note } : null;
  }).filter(Boolean);
  // Mixed channels: counted over the answers whose channel shows (enough of them); between platforms serving the same
  // weights (Anthropic's API, Bedrock, Vertex: a relay's pool, OpenRouter's routing) only shown.
  const identified = upstreams.filter(Boolean);
  if (identified.length >= th.driftMin) {
    const mixed = split(identified, th.driftShare);
    const entry = (channelId) => pack.channels.find((item) => item.id === channelId);
    if (mixed) {
      const [a, b] = [entry(mixed[0].value), entry(mixed[1].value)];
      const hosts = a?.group && a.group === b?.group;
      add({ id: "channel-drift", level: hosts ? "info" : "soft", key: hosts ? "ev.channelHosts" : "ev.channelDrift", params: { a: a?.name ?? mixed[0].value, b: b?.name ?? mixed[1].value, n: identified.length } });
    }
  }

  // ---- hard: replays, fixed answers, stubs, echo
  // Ids: only where their form is one no two answers share by chance.
  const byId = new Map();
  for (const item of served) if (item.ih && uniqueIdForm(item.is)) (byId.get(item.ih) ?? byId.set(item.ih, []).get(item.ih)).push(item);
  let replays = 0;
  let shortReplays = 0;
  let synthesised = 0;
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    // The same answer again: same opening, same length, same output tokens (a tool call alone has no text to compare).
    const same = new Map();
    for (const item of group.filter((entry) => entry.hh)) {
      const key = `${item.hh}|${item.vc}|${item.out ?? "-"}`;
      same.set(key, (same.get(key) ?? []).concat(item));
    }
    const repeated = [...same.values()].filter((list) => list.length > 1);
    for (const list of repeated) {
      if ((list[0].vc ?? 0) >= 200) replays += list.length - 1;
      else shortReplays += list.length - 1;
    }
    if (!repeated.length) synthesised += 1;
  }
  const firstAt = (predicate) => served.find(predicate)?.t ?? null;
  const repeatedAt = firstAt((item) => item.ih && (byId.get(item.ih)?.length ?? 0) > 1);
  if (replays) add({ id: "replay", level: "hard", key: "ev.replay", params: { n: replays }, count: replays, at: repeatedAt });
  else if (shortReplays) add({ id: "replay", level: "soft", key: "ev.replay", params: { n: shortReplays }, count: shortReplays, at: repeatedAt });
  else if (synthesised) add({ id: "id-synth", level: "soft", key: "ev.idSynth", params: { n: synthesised }, count: synthesised });
  // The same long answer (same length too) to different questions: three questions are proof, two a doubt (sign-offs repeat).
  const byAnswer = new Map();
  for (const item of served) if (item.hh && (item.hl ?? 0) >= th.fixedMinChars && item.qh) {
    const key = `${item.hh}|${item.vc}`;
    (byAnswer.get(key) ?? byAnswer.set(key, []).get(key)).push(item);
  }
  const fixed = [...byAnswer.values()].map((group) => ({ group, questions: new Set(group.map((item) => item.qh)).size })).filter((entry) => entry.questions > 1);
  if (fixed.length) {
    const most = Math.max(...fixed.map((entry) => entry.questions));
    add({ id: "fixed-answer", level: most >= 3 ? "hard" : "soft", key: "ev.fixedAnswer", params: { n: fixed.reduce((sum, entry) => sum + entry.group.length, 0) }, count: fixed.length, at: fixed[0].group[0].t });
  }
  // A notice instead of the model: twice is proof, once a doubt.
  const stubbed = served.filter((item) => item.st);
  if (stubbed.length) {
    const stub = pack.stubs.find((item) => item.id === stubbed[0].st);
    add({ id: "stub", level: stubbed.length >= 2 ? "hard" : "soft", key: "ev.stub", params: { n: stubbed.length }, note: stub?.note ?? null, count: stubbed.length, at: stubbed[0].t });
  }
  const asked = familyOf(pack, model.id);
  const askedVersion = versionOf(model.id);
  const echoChecked = { same: 0, other: 0 };
  if (asked) {
    const wrong = [];
    const older = [];
    for (const item of served) {
      if (!item.e || ARN.test(item.e)) continue;
      const echoed = familyOf(pack, item.e);
      if (!echoed) continue;
      if (echoed.family !== asked.family || (echoed.tier && asked.tier && echoed.tier !== asked.tier)) wrong.push(item);
      // Same tier, another version ("claude-opus-4-6-thinking" for claude-opus-4-7): another model all the same.
      else if (askedVersion && versionOf(item.e) && versionOf(item.e).version !== askedVersion.version) older.push(item);
      else echoChecked.same += 1;
    }
    echoChecked.other = wrong.length + older.length;
    if (wrong.length) add({ id: "echo-mismatch", level: "hard", key: "ev.echoMismatch", params: { echo: wrong[0].e, asked: model.id, n: wrong.length }, count: wrong.length, at: wrong[0].t, likely: wrong[0].e });
    else if (older.length) add({ id: "echo-version", level: "hard", key: "ev.echoVersion", params: { echo: older[0].e, asked: model.id, n: older.length }, count: older.length, at: older[0].t, likely: older[0].e });
  }
  // The echoed name changing (another Bedrock profile, another model name) on the same model.
  // Shown only: another family or tier echoed is the hard case above.
  const echoed = recent.map((item) => item.e ?? null).filter(Boolean);
  if (echoed.length >= th.driftMin) {
    const echoes = split(echoed, th.driftShare);
    if (echoes) add({ id: "echo-drift", level: "info", key: "ev.echoDrift", params: { a: echoes[0].value, b: echoes[1].value } });
  }
  const stitched = served.filter((item) => item.ic).length;
  if (stitched) add({ id: "stitched", level: "info", key: "ev.stitched", params: { n: stitched }, count: stitched });

  // ---- soft: speed and characters per token, against the model's own earlier answers
  const speeds = served.map(speedOf).filter((value) => value !== null);
  const speed = signDrift(speeds, th);
  if (speed && speed.e >= th.alarm && Math.abs(speed.recent - speed.base) / speed.base >= th.speedEffect) {
    add({ id: "speed-drift", level: "soft", key: speed.recent > speed.base ? "ev.speedUp" : "ev.speedDown", params: { base: Math.round(speed.base), now: Math.round(speed.recent) } });
  }
  const family = asked?.entry ?? null;
  const cpt = {};
  for (const lang of ["en", "zh"]) {
    // Against the family's range: answers in prose (no tool call); their visible reasoning counts with their text.
    const ratios = served.filter((item) => item.lg === lang && !item.tc).map((item) => cptOf(item, th)).filter((value) => value !== null);
    const band = family?.cpt?.[lang];
    cpt[lang] = { n: ratios.length, value: ratios.length >= th.cptMin ? median(ratios) : null, band: band ?? null, inBand: null };
    if (band && ratios.length >= th.cptMin) {
      const value = median(ratios);
      const outside = value < band[0] * (1 - th.cptMargin) || value > band[1] * (1 + th.cptMargin);
      cpt[lang].inBand = !outside;
      if (outside) {
        // Which families' range the figure falls in instead (another tokenizer, so another model).
        const others = pack.families.filter((entry) => entry.id !== family.id && entry.cpt?.[lang] && value >= entry.cpt[lang][0] && value <= entry.cpt[lang][1]);
        add({ id: `cpt-band-${lang}`, level: "soft", key: "ev.cptBand", params: { lang, value: value.toFixed(2), low: band[0], high: band[1], family: family.name, n: ratios.length }, likely: others.length ? joinNames(others.map((entry) => entry.name)) : null });
      }
    }
    // Against the model's own history: tool-call turns too (their arguments count as characters).
    const drift = signDrift(served.filter((item) => item.lg === lang).map((item) => cptOf(item, th, { withArguments: true })).filter((value) => value !== null), th);
    if (drift && drift.e >= th.alarm && Math.abs(drift.recent - drift.base) / drift.base >= th.cptEffect) {
      add({ id: `cpt-drift-${lang}`, level: "soft", key: "ev.cptDrift", params: { lang, base: drift.base.toFixed(2), now: drift.recent.toFixed(2) } });
    }
  }

  // ---- soft: the input tokenizer changing within a conversation
  // Two requests of one conversation share almost all their text, so reported input / local estimate stays put unless
  // the tokenizer counting it changed (another model, or another relay pool adding its own text).
  const steps = [];
  const sessionsSeen = new Map();
  for (const item of served) (sessionsSeen.get(item.s ?? "") ?? sessionsSeen.set(item.s ?? "", []).get(item.s ?? "")).push(item);
  for (const list of sessionsSeen.values()) {
    // A level held over two requests, then another level held over two: one odd request in between is no step.
    for (let index = 2; index + 1 < list.length; index += 1) {
      const [prior, before, at, after] = [list[index - 2], list[index - 1], list[index], list[index + 1]];
      const [p, a, b, c] = [inputRatioOf(prior, th), inputRatioOf(before, th), inputRatioOf(at, th), inputRatioOf(after, th)];
      // A shorter history (compaction, an edited turn) is other text: no comparison across it.
      if (p === null || a === null || b === null || c === null || before.est < prior.est * 0.8 || at.est < before.est * 0.8 || after.est < at.est * 0.8) continue;
      const change = b / a - 1;
      const held = Math.abs(a / p - 1) <= th.inputStepHold && Math.abs(c / b - 1) <= th.inputStepHold;
      if (held && Math.abs(change) >= th.inputStep && Math.abs(change) <= th.inputStepMax) steps.push({ at: at.t, from: a, to: b, change });
    }
  }
  if (steps.length) {
    const latest = steps.at(-1);
    add({ id: "input-step", level: "soft", key: "ev.inputStep", params: { from: latest.from.toFixed(2), to: latest.to.toFixed(2), change: `${latest.change > 0 ? "+" : ""}${(latest.change * 100).toFixed(1)}`, n: steps.length }, count: steps.length, at: latest.at });
  }

  // ---- soft: usage against what was sent
  const ratios = served.filter((item) => !item.img && (item.in ?? 0) > 0 && (item.est ?? 0) > 200).map((item) => item.in / item.est).slice(-50);
  if (ratios.length >= th.ratioMin) {
    const value = median(ratios);
    if (value > th.inputHigh) add({ id: "input-high", level: "soft", key: "ev.inputHigh", params: { ratio: value.toFixed(1), n: ratios.length } });
    else if (value < th.inputLow) add({ id: "input-low", level: "soft", key: "ev.inputLow", params: { ratio: value.toFixed(2), n: ratios.length } });
  }

  // ---- soft: tool calls, empty answers, output over the limit, the window
  const malformed = observations.filter((item) => item.k === "malformed").length;
  const calls = served.reduce((sum, item) => sum + (item.tc ?? 0), 0) + malformed;
  const badCalls = served.reduce((sum, item) => sum + (item.tb ?? 0) + (item.tu ?? 0), 0) + malformed;
  if (calls >= th.toolMin && badCalls / calls >= th.toolBadShare) add({ id: "tool-health", level: "soft", key: "ev.toolHealth", params: { bad: badCalls, calls } });
  const answered = observations.filter((item) => item.ok || item.k === "empty" || item.k === "malformed");
  const empties = observations.filter((item) => item.k === "empty").length + served.filter((item) => !item.vc && !item.tc && (item.rc ?? 0) > 0).length;
  if (answered.length >= th.emptyMin && empties / answered.length >= th.emptyShare) add({ id: "empty", level: "soft", key: "ev.empty", params: { n: empties, total: answered.length } });
  const over = served.filter((item) => item.mx && (item.out ?? 0) > item.mx * 1.05 + 16);
  if (over.length >= 2) add({ id: "over-max", level: "soft", key: "ev.overMax", params: { n: over.length }, count: over.length });
  if (Number.isFinite(model.context) && model.context >= 64_000 && ["site", "user", "measured"].includes(model.contextOrigin)) {
    const early = observations.filter((item) => item.k === "context" && (item.est ?? Infinity) < model.context * 0.5);
    if (early.length) add({ id: "context-early", level: "soft", key: "ev.contextEarly", params: { est: early[0].est, context: model.context }, count: early.length, at: early[0].t });
  }

  // ---- info: what cannot be checked here
  const unsigned = served.filter((item) => item.p === "messages" && item.th && !item.sg).length;
  if (unsigned >= 3) add({ id: "signature-stripped", level: "info", key: "ev.signatureStripped", params: { n: unsigned } });

  // ---- active checks: the latest result of each kind
  let verified = false;
  const latest = new Map();
  for (const result of probes) latest.set(result.kind, result);
  for (const result of latest.values()) {
    for (const item of result.items ?? []) {
      if (item.outcome === "verified") verified = true;
      const level = item.level ?? (item.outcome === "fail" ? "soft" : item.outcome === "pass" || item.outcome === "verified" ? "pass" : "info");
      evidence.push({ id: `${result.kind}:${item.id}`, level, source: result.kind, key: item.key, params: item.params ?? {}, note: item.note ?? null, at: result.at, count: 1, ...(item.likely ? { likely: item.likely } : {}), ...(result.auto ? { auto: true } : {}) });
    }
  }

  const order = { hard: 0, soft: 1, info: 2, pass: 3 };
  for (const item of evidence) item.axis = axisOf(item);
  // The identity check counts the tokenizer exactly: when it passed after a passive doubt about the identity, the doubt
  // was something else (another relay pool's own text, a topic change). Hard evidence stays.
  const identityRun = latest.get("identity");
  const tokenizerPass = identityRun?.items?.some((item) => item.id === "tokenizer" && item.outcome === "pass") ? identityRun.at : null;
  if (tokenizerPass) {
    for (const item of evidence) {
      if (item.source === "passive" && item.axis === "identity" && item.level === "soft" && (item.at ?? 0) <= tokenizerPass) Object.assign(item, { level: "info", cleared: true });
    }
  }
  evidence.sort((a, b) => order[a.level] - order[b.level]);
  const of = (axis) => evidence.filter((item) => item.axis === axis);
  const has = (items, level) => items.some((item) => item.level === level);

  // ---- 模型身份: is this the model the site names?
  const identityItems = of("identity");
  // The tokenizer (vendor, generation) or the knowledge fingerprint (down to the tier) matching the model named.
  const tokenizerPassed = identityItems.some((item) => (item.id === "identity:tokenizer" || item.id === "fingerprint:kbf") && item.level === "pass");
  // Passive figures alone may clear a model only where its tokenizer showed (characters per token in its range).
  const cptCleared = Object.values(cpt).some((entry) => entry.inBand === true);
  const identityState = has(identityItems, "hard") ? "substituted"
    : has(identityItems, "soft") ? "suspect"
      : verified ? "confirmed"
        : tokenizerPassed ? "consistent"
          : cptCleared && served.length >= th.minSamples ? "clean"
            : "unchecked";
  const likely = identityItems.find((item) => (item.level === "hard" || item.level === "soft") && item.likely)?.likely ?? null;

  // ---- 服务表现: does the site serve it faithfully?
  const serviceItems = of("service");
  const problems = serviceItems.filter((item) => item.level === "hard" || item.level === "soft").length;
  const serviceState = has(serviceItems, "hard") ? "bad" : problems ? "issues" : served.length >= th.minSamples || latest.has("quick") ? "ok" : "insufficient";

  const sessions = new Set(observations.map((item) => item.s).filter(Boolean));
  return {
    identity: { state: identityState, likely },
    service: { state: serviceState, problems },
    channel,
    evidence,
    metrics: metricsOf({ pack, served, observations, evidence, cpt, echoChecked, recent, latest, family, th, siteLog }),
    samples: { passive: served.length, failed: observations.length - served.length, sessions: sessions.size, probes: probes.length, since: observations[0]?.t ?? null, last: observations.at(-1)?.t ?? null },
    judgedAt: now,
  };
}

/**
 * What passive monitoring measures, as the page shows it: each figure with its reference and a status (`ok`,
 * `warn`, `bad`, `na` — not enough answers yet — or `info`, shown only).
 */
function metricsOf({ pack, served, observations, evidence, cpt, echoChecked, recent, latest, family, th, siteLog = null }) {
  const flagged = (prefix) => {
    const item = evidence.find((entry) => entry.id.startsWith(prefix) && (entry.level === "hard" || entry.level === "soft"));
    return item ? (item.level === "hard" ? "bad" : "warn") : null;
  };
  const out = [];
  // Identity: what the site says it serves, how its tokenizer splits text, where answers come from, signatures.
  const echoes = new Map();
  for (const item of recent) if (item.e) echoes.set(item.e, (echoes.get(item.e) ?? 0) + 1);
  const topEcho = [...echoes].sort((a, b) => b[1] - a[1])[0] ?? null;
  out.push({ id: "echo", axis: "identity", status: flagged("echo-") ?? (topEcho ? (echoChecked.same ? "ok" : "info") : "na"), params: topEcho ? { value: topEcho[0].slice(0, 80), n: topEcho[1], total: recent.filter((item) => item.e).length } : {} });
  for (const lang of ["en", "zh"]) {
    const entry = cpt[lang];
    out.push({ id: `cpt-${lang}`, axis: "identity", status: flagged(`cpt-band-${lang}`) ?? flagged(`cpt-drift-${lang}`) ?? (entry.value === null ? "na" : entry.inBand === true ? "ok" : "info"), params: { value: entry.value === null ? null : entry.value.toFixed(2), n: entry.n, need: th.cptMin, low: entry.band?.[0] ?? null, high: entry.band?.[1] ?? null, family: family?.name ?? null } });
  }
  const tokenizer = latest.get("identity")?.items?.find((item) => item.id === "tokenizer") ?? null;
  out.push({ id: "tokenizer", axis: "identity", status: !tokenizer ? "na" : tokenizer.level === "hard" ? "bad" : tokenizer.level === "soft" ? "warn" : tokenizer.outcome === "pass" ? "ok" : "info", params: tokenizer ? { delta: tokenizer.params?.delta ?? null, group: tokenizer.params?.group ?? tokenizer.params?.likely ?? null, at: latest.get("identity").at } : {} });
  const knowledge = latest.get("fingerprint")?.items?.find((item) => item.id === "kbf") ?? null;
  out.push({ id: "knowledge", axis: "identity", status: !knowledge ? "na" : knowledge.level === "hard" ? "bad" : knowledge.level === "soft" ? "warn" : knowledge.outcome === "pass" ? "ok" : "info", params: knowledge ? { ...knowledge.params, verdict: knowledge.outcome, at: latest.get("fingerprint").at } : {} });
  const thinkingAnswers = served.filter((item) => item.p === "messages" && item.th);
  out.push({ id: "signature", axis: "identity", status: latest.get("signature")?.items?.some((item) => item.outcome === "verified") ? "ok" : thinkingAnswers.length ? "info" : "na", params: { signed: thinkingAnswers.filter((item) => item.sg).length, total: thinkingAnswers.length } });
  const upstreams = new Map();
  for (const item of recent) {
    const named = pack.channels.find((channel) => channel.id === channelsOf(pack, item).upstream);
    if (named) upstreams.set(named.id, { name: named.name, count: (upstreams.get(named.id)?.count ?? 0) + 1 });
  }
  const sources = [...upstreams.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  out.push({ id: "upstream", axis: "identity", status: flagged("channel-drift") ?? (sources.length ? "info" : "na"), params: sources.length ? { list: { zh: sources.map((entry) => `${entry.name.zh} ${entry.count}`).join(" · "), en: sources.map((entry) => `${entry.name.en} ${entry.count}`).join(" · ") }, total: recent.length } : {} });
  // The input tokenizer: reported input / local estimate (recent median), and a step within a conversation.
  const inputRatios = served.map((item) => inputRatioOf(item, th)).filter((value) => value !== null);
  // The site's own log (new-api): what it says it served, over the entries read.
  out.push({ id: "site-log", axis: "identity", status: flagged("relay-") ?? (siteLog?.checked ? "ok" : "na"), params: { n: siteLog?.checked ?? 0, mapped: Object.keys(siteLog?.mapped ?? {}).length, returned: Object.keys(siteLog?.returned ?? {}).length, overwritten: siteLog?.overwritten?.n ?? 0 } });
  out.push({ id: "input-ratio", axis: "identity", status: flagged("input-step") ?? (inputRatios.length >= 5 ? "ok" : "na"), params: { value: inputRatios.length ? median(inputRatios.slice(-10)).toFixed(2) : null, n: inputRatios.length, need: 5 } });
  // Service: speed and latency, notices, empty answers, tool calls, the usage reported.
  const speeds = served.map(speedOf).filter((value) => value !== null);
  const hidden = served.filter((item) => hiddenThinking(item)).length;
  out.push({ id: "speed", axis: "service", status: flagged("speed-drift") ?? (speeds.length ? "info" : "na"), params: speeds.length ? { value: Math.round(median(speeds.slice(-20))), n: speeds.length } : { hidden } });
  const firsts = served.map((item) => item.ft).filter((value) => Number.isFinite(value) && value > 0);
  out.push({ id: "ttft", axis: "service", status: firsts.length ? "info" : "na", params: firsts.length ? { value: (median(firsts.slice(-20)) / 1000).toFixed(1), n: firsts.length } : {} });
  const stubs = served.filter((item) => item.st).length;
  out.push({ id: "stub", axis: "service", status: flagged("stub") ?? (served.length ? "ok" : "na"), params: { n: stubs, total: served.length } });
  const answered = observations.filter((item) => item.ok || item.k === "empty" || item.k === "malformed");
  const empties = observations.filter((item) => item.k === "empty").length + served.filter((item) => !item.vc && !item.tc && (item.rc ?? 0) > 0).length;
  out.push({ id: "empty", axis: "service", status: flagged("empty") ?? (answered.length ? "ok" : "na"), params: { n: empties, total: answered.length } });
  const malformed = observations.filter((item) => item.k === "malformed").length;
  const calls = served.reduce((sum, item) => sum + (item.tc ?? 0), 0) + malformed;
  const badCalls = served.reduce((sum, item) => sum + (item.tb ?? 0) + (item.tu ?? 0), 0) + malformed;
  out.push({ id: "tools", axis: "service", status: flagged("tool-health") ?? (calls ? "ok" : "na"), params: { bad: badCalls, calls } });
  const ratios = served.filter((item) => !item.img && (item.in ?? 0) > 0 && (item.est ?? 0) > 200).map((item) => item.in / item.est).slice(-50);
  out.push({ id: "usage", axis: "service", status: flagged("input-") ?? (ratios.length >= th.ratioMin ? "ok" : "na"), params: { value: ratios.length ? median(ratios).toFixed(2) : null, n: ratios.length, need: th.ratioMin, low: th.inputLow, high: th.inputHigh } });
  return out;
}
