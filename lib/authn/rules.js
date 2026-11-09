/**
 * The judgement data of model verification ("模型核验"): a rule pack. Data
 * only — the plugin reads it and never runs anything from it. One pack ships
 * inside the plugin (`pack.json`); a newer one may be downloaded (update.js),
 * accepted only when its Ed25519 signature checks out against the public key
 * built into the plugin, its form is valid, and its version is newer.
 *
 * A pack holds:
 *  - `channels`: where answers come from (Anthropic's API, AWS Bedrock,
 *    OpenRouter …), with display names;
 *  - `signals`: how an answer's wire shows a channel (an id's form, a header,
 *    a usage field, a tool-call id's prefix …), in a few fixed operations;
 *  - `stubs`: canned texts a site answers instead of the model;
 *  - `families`: model families (claude, deepseek …): how ids name them,
 *    their tiers, the characters per token their tokenizer gives (by
 *    language), which thinking signatures stay with their account;
 *  - `thresholds`: the judgement's numbers;
 *  - `probes`: the wording of the active checks (re-worded on every run);
 *  - `identity`: the tokenizer references of the identity check;
 *  - `fingerprint`: the knowledge-fingerprint probe sets (KBF): where each is, its hash, which model ids it serves,
 *    and how its questions are asked and scored.
 *
 * Patterns are short and only ever meet short strings (an id, a header name,
 * the first few hundred characters of an answer), and nested quantifiers are
 * refused, so no pack can stall the plugin.
 *
 * @module dsh-custom-models/authn/rules
 */
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const PACK_SCHEMA = 1;
/** The plugin version a pack's `minPlugin` is compared with. */
export const PLUGIN_VERSION = "0.7.0";
/** Fields a signal may look at (observe.js fills them). */
export const SIGNAL_FIELDS = Object.freeze(["id", "echo", "toolId", "fingerprint", "tier", "signature", "header", "usageField"]);
export const SIGNAL_OPS = Object.freeze(["equals", "prefix", "includes", "regex", "present"]);
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d{1,3}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const LIMITS = Object.freeze({ channels: 40, signals: 300, stubs: 100, families: 60, pattern: 200, text: 400, bytes: 600_000 });

/** A short text in both languages. */
function texts(value, subject, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${subject} must be { zh, en }`);
  for (const lang of ["zh", "en"]) {
    if (typeof value[lang] !== "string" || value[lang].length === 0 || value[lang].length > LIMITS.text) throw new TypeError(`${subject}.${lang} must be a text of 1–${LIMITS.text} characters`);
  }
  return { zh: value.zh, en: value.en };
}

/**
 * A pattern no pack can stall the plugin with: short and compiling, no quantified group (`(a+)+`, `(a|a)+`,
 * `(a?){25}`), no backreference or lookaround, at most two unbounded quantifiers (`.*.*.*x` chains); and it only
 * ever meets short texts (300 characters at most).
 */
export function safePattern(source, subject) {
  if (typeof source !== "string" || source.length === 0 || source.length > LIMITS.pattern) throw new TypeError(`${subject} must be a pattern of 1–${LIMITS.pattern} characters`);
  const bare = source.replace(/\\./g, "");
  const unbounded = (bare.match(/[*+]|\{\d+,\}/g) ?? []).length;
  if (/\)\s*[*+?{]/.test(bare) || /\\\d/.test(source) || /\(\?<?[=!]/.test(source) || unbounded > 2) throw new TypeError(`${subject} uses a construct packs may not (a quantified group, a backreference, lookaround, or more than two unbounded quantifiers)`);
  try {
    return new RegExp(source, "i");
  } catch (error) {
    throw new TypeError(`${subject} does not compile: ${error.message}`);
  }
}

function list(value, subject, max) {
  if (!Array.isArray(value)) throw new TypeError(`${subject} must be a list`);
  if (value.length > max) throw new TypeError(`${subject} has more than ${max} entries`);
  return value;
}

function id(value, subject) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TypeError(`${subject} must be an id (lower case, digits, hyphens)`);
  return value;
}

function range(value, subject) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => typeof item === "number" && item > 0 && item < 50) || value[0] >= value[1]) throw new TypeError(`${subject} must be [low, high]`);
  return [value[0], value[1]];
}

/** Compare two pack versions (`2026.11.09-1`): negative, 0, positive. */
export function compareVersions(a, b) {
  const parse = (value) => String(value).split(/[.-]/).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const diff = (x[index] ?? 0) - (y[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** Compare two plugin versions (semver, numeric parts only). */
export function compareSemver(a, b) {
  const parse = (value) => String(value).split("-")[0].split(".").map((part) => Number(part) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) - (y[index] ?? 0);
  return 0;
}

const DEFAULT_THRESHOLDS = Object.freeze({
  // Fewer passive observations than this (and no active check): "样本不足".
  minSamples: 5,
  // Kept per site and model.
  keepObservations: 300,
  // The sign e-process (drift of speed or characters per token against the model's own earlier answers).
  baseline: 15,
  lambda: 0.5,
  alarm: 100,
  // A drift must also be at least this large to count (relative change of the median).
  speedEffect: 0.3,
  cptEffect: 0.12,
  // Characters per token outside the family's range by more than this share (median of at least cptMin answers).
  cptMargin: 0.1,
  cptMin: 8,
  cptMinTokens: 100,
  // Reported input over the plugin's estimate: above high (inflated), below low (context cut), median of at least ratioMin.
  inputHigh: 2.2,
  inputLow: 0.4,
  ratioMin: 10,
  // Tool calls and empty answers: share of bad ones among at least this many.
  toolMin: 10,
  toolBadShare: 0.2,
  emptyMin: 10,
  emptyShare: 0.2,
  // Two channels (or two model echoes) each holding at least this share of the last `driftWindow` answers.
  driftWindow: 30,
  driftMin: 10,
  driftShare: 0.2,
  // A fixed answer counts only when it is at least this long.
  fixedMinChars: 200,
  // Input tokenizer: within one conversation, reported input / local estimate changing by at least inputStep (and at most
  // inputStepMax, larger is an accounting artefact) between two requests and holding (within inputStepHold) on the next.
  // Live 2026-11-09: request-to-request noise at most 7.5 %; Claude 5 to 4.6 -12.6 %, Claude to DeepSeek -30 %, to GLM -38 %.
  inputStep: 0.1,
  inputStepMax: 0.6,
  inputStepHold: 0.05,
  // Requests smaller than this (estimated input tokens) are too small for the ratio.
  inputMinEst: 500,
});

/**
 * Check a pack's form and normalise it.
 * @returns the pack as the plugin uses it; throws a TypeError naming the first problem.
 */
export function validatePack(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("a pack must be an object");
  if (raw.schema !== PACK_SCHEMA) throw new TypeError(`pack schema ${raw.schema} is not ${PACK_SCHEMA}`);
  if (typeof raw.version !== "string" || !VERSION_PATTERN.test(raw.version)) throw new TypeError("pack version must look like 2026.11.09-1");
  if (typeof raw.published !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.published)) throw new TypeError("pack published must be a date");
  if (typeof raw.minPlugin !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.minPlugin)) throw new TypeError("pack minPlugin must be a version");
  const channels = list(raw.channels, "channels", LIMITS.channels).map((item, index) => ({
    id: id(item?.id, `channels[${index}].id`),
    layer: item?.layer === "relay" ? "relay" : "upstream",
    parent: item?.parent === undefined ? null : id(item.parent, `channels[${index}].parent`),
    // Channels of one group serve the same weights (Anthropic's API, Bedrock, Vertex): moving between them is no drift.
    group: item?.group === undefined ? null : id(item.group, `channels[${index}].group`),
    name: texts(item?.name, `channels[${index}].name`),
  }));
  const channelIds = new Set(channels.map((item) => item.id));
  for (const item of channels) if (item.parent && !channelIds.has(item.parent)) throw new TypeError(`channel ${item.id} names an unknown parent ${item.parent}`);
  const signals = list(raw.signals, "signals", LIMITS.signals).map((item, index) => {
    const subject = `signals[${index}]`;
    if (!SIGNAL_FIELDS.includes(item?.field)) throw new TypeError(`${subject}.field must be one of ${SIGNAL_FIELDS.join(", ")}`);
    if (!SIGNAL_OPS.includes(item?.op)) throw new TypeError(`${subject}.op must be one of ${SIGNAL_OPS.join(", ")}`);
    if (item.channel !== undefined && !channelIds.has(item.channel)) throw new TypeError(`${subject}.channel names an unknown channel`);
    if (item.op !== "present" && (typeof item.value !== "string" || item.value.length === 0 || item.value.length > LIMITS.pattern)) throw new TypeError(`${subject}.value must be a short text`);
    const weight = item.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) throw new TypeError(`${subject}.weight must be 1–5`);
    return {
      id: id(item.id, `${subject}.id`),
      field: item.field,
      op: item.op,
      value: item.op === "present" ? null : item.value,
      pattern: item.op === "regex" ? safePattern(item.value, `${subject}.value`) : null,
      ...(item.protocol !== undefined ? { protocol: list(item.protocol, `${subject}.protocol`, 3).map((value) => { if (!["chat", "responses", "messages"].includes(value)) throw new TypeError(`${subject}.protocol lists an unknown protocol`); return value; }) } : {}),
      channel: item.channel ?? null,
      weight,
      note: texts(item.note, `${subject}.note`),
    };
  });
  const stubs = list(raw.stubs, "stubs", LIMITS.stubs).map((item, index) => ({
    id: id(item?.id, `stubs[${index}].id`),
    pattern: safePattern(item?.value, `stubs[${index}].value`),
    // A notice is the whole (short) answer: at most 300 characters.
    maxChars: Number.isInteger(item?.maxChars) && item.maxChars > 0 ? Math.min(item.maxChars, 300) : 200,
    note: texts(item?.note, `stubs[${index}].note`),
  }));
  const families = list(raw.families, "families", LIMITS.families).map((item, index) => {
    const subject = `families[${index}]`;
    return {
      id: id(item?.id, `${subject}.id`),
      pattern: safePattern(item?.match, `${subject}.match`),
      tiers: item?.tiers === undefined ? [] : list(item.tiers, `${subject}.tiers`, 12).map((tier) => id(tier, `${subject}.tiers`)),
      cpt: { en: range(item?.cpt?.en, `${subject}.cpt.en`), zh: range(item?.cpt?.zh, `${subject}.cpt.zh`) },
      accountBound: item?.accountBound === undefined ? null : safePattern(item.accountBound, `${subject}.accountBound`),
      name: texts(item?.name, `${subject}.name`),
    };
  });
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(raw.thresholds ?? {})) {
    if (!(key in DEFAULT_THRESHOLDS)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e6) throw new TypeError(`thresholds.${key} must be a number`);
    thresholds[key] = value;
  }
  const probes = validateProbes(raw.probes);
  const identity = validateIdentity(raw.identity, new Set(families.map((item) => item.id)));
  const fingerprint = validateFingerprint(raw.fingerprint);
  return Object.freeze({ schema: PACK_SCHEMA, version: raw.version, published: raw.published, minPlugin: raw.minPlugin, channels, signals, stubs, families, thresholds: Object.freeze(thresholds), probes, identity, fingerprint });
}

/**
 * Identity references: the tokenizer check sends two fixed texts (`base`, then `base` + `probe`) and reads the
 * difference of the input tokens the site reports — the relay's own overhead cancels out, what stays is how the
 * serving model's tokenizer splits `probe`. Each group is one tokenizer, measured live, with the model ids it is
 * expected for (`match`). A pack without the section has no identity check.
 */
function validateIdentity(raw, familyIds) {
  if (raw === undefined || raw === null || raw.tokenizer === undefined) return Object.freeze({ tokenizer: null });
  const tokenizer = raw.tokenizer;
  const subject = "identity.tokenizer";
  const text = (value, name, max) => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) throw new TypeError(`${subject}.${name} must be a text of 1–${max} characters`);
    return value;
  };
  const whole = (value, name, low, high, fallback) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < low || value > high) throw new TypeError(`${subject}.${name} must be a whole number ${low}–${high}`);
    return value;
  };
  const groups = list(tokenizer.groups, `${subject}.groups`, 60).map((item, index) => {
    const at = `${subject}.groups[${index}]`;
    const family = id(item?.family, `${at}.family`);
    if (!familyIds.has(family)) throw new TypeError(`${at}.family names an unknown family`);
    return {
      id: id(item?.id, `${at}.id`),
      family,
      delta: whole(item?.delta, `groups[${index}].delta`, 1, 5000),
      pattern: item?.match === undefined ? null : safePattern(item.match, `${at}.match`),
      name: texts(item?.name, `${at}.name`),
    };
  });
  return Object.freeze({
    tokenizer: Object.freeze({
      base: text(tokenizer.base, "base", 200),
      probe: text(tokenizer.probe, "probe", 1000),
      maxTokens: whole(tokenizer.maxTokens, "maxTokens", 16, 256, 16),
      tolerance: whole(tokenizer.tolerance, "tolerance", 0, 5, 1),
      groups: Object.freeze(groups),
    }),
  });
}

/**
 * Knowledge fingerprints (KBF, github.com/Ooo0ption/KBF, Apache-2.0): where the probe sets are (a repository at a
 * pinned commit), how questions are put (a system and a user text with `{sentences}`, `batchSize` per request, every
 * `sample`-th probe), the statistics (`alpha`, `confidence`, `minCoverage`), the question domains (a cloze template
 * with `{name}`, the range a value may take, the tolerance absolute or relative) and the sets (a path in the repository,
 * its SHA-256 and size, the reference model, the claimed ids it serves, its self-test, the requests a run makes).
 * A pack without the section has no knowledge fingerprints.
 */
function validateFingerprint(raw) {
  if (raw === undefined || raw === null) return null;
  const subject = "fingerprint";
  if (!isPlain(raw)) throw new TypeError(`${subject} must be an object`);
  const text = (value, name, max) => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) throw new TypeError(`${subject}.${name} must be a text of 1–${max} characters`);
    return value;
  };
  const between = (value, name, low, high, { integer = false } = {}) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) throw new TypeError(`${subject}.${name} must be a number ${low}–${high}`);
    return value;
  };
  const source = raw.source;
  if (!isPlain(source)) throw new TypeError(`${subject}.source must be an object`);
  if (!/^[A-Za-z0-9-]{1,40}\/[A-Za-z0-9._-]{1,100}$/.test(source.repo ?? "")) throw new TypeError(`${subject}.source.repo must be owner/name`);
  if (!/^[0-9a-f]{40}$/.test(source.commit ?? "")) throw new TypeError(`${subject}.source.commit must be a commit hash`);
  const prompt = raw.prompt;
  if (!isPlain(prompt)) throw new TypeError(`${subject}.prompt must be an object`);
  const user = text(prompt.user, "prompt.user", 1000);
  if (!user.includes("{sentences}")) throw new TypeError(`${subject}.prompt.user must hold {sentences}`);
  const domains = {};
  if (!isPlain(raw.domains) || Object.keys(raw.domains).length === 0 || Object.keys(raw.domains).length > 40) throw new TypeError(`${subject}.domains must list 1–40 domains`);
  for (const [name, domain] of Object.entries(raw.domains)) {
    const at = `domains.${name}`;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || !isPlain(domain)) throw new TypeError(`${subject}.${at}: bad domain`);
    const template = text(domain.template, `${at}.template`, 200);
    if (!template.includes("{name}")) throw new TypeError(`${subject}.${at}.template must hold {name}`);
    if (!Array.isArray(domain.range) || domain.range.length !== 2 || !domain.range.every((value) => typeof value === "number" && Number.isFinite(value)) || domain.range[0] >= domain.range[1]) throw new TypeError(`${subject}.${at}.range must be [low, high]`);
    if (!["absolute", "relative"].includes(domain.mode)) throw new TypeError(`${subject}.${at}.mode must be absolute or relative`);
    domains[name] = Object.freeze({ template, range: [domain.range[0], domain.range[1]], tolerance: between(domain.tolerance, `${at}.tolerance`, 0, 1000), mode: domain.mode });
  }
  const sets = list(raw.sets, `${subject}.sets`, 200).map((item, index) => {
    const at = `sets[${index}]`;
    if (!isPlain(item)) throw new TypeError(`${subject}.${at} must be an object`);
    if (!/^probes\/[A-Za-z0-9._/-]{1,150}\.json$/.test(item.path ?? "") || item.path.includes("..")) throw new TypeError(`${subject}.${at}.path must be a probes/….json path`);
    if (!/^[0-9a-f]{64}$/.test(item.sha256 ?? "")) throw new TypeError(`${subject}.${at}.sha256 must be a SHA-256`);
    if (!isPlain(item.self)) throw new TypeError(`${subject}.${at}.self must be { hamming, total }`);
    return Object.freeze({
      id: id(item.id, `${subject}.${at}.id`),
      model: text(item.model, `${at}.model`, 120),
      name: text(item.name, `${at}.name`, 80),
      pattern: safePattern(item.match, `${subject}.${at}.match`),
      path: item.path,
      sha256: item.sha256,
      bytes: between(item.bytes, `${at}.bytes`, 1, 2_000_000, { integer: true }),
      probes: between(item.probes, `${at}.probes`, 10, 5000, { integer: true }),
      requests: between(item.requests, `${at}.requests`, 1, 500, { integer: true }),
      date: /^\d{4}-\d{2}-\d{2}$/.test(item.date ?? "") ? item.date : (() => { throw new TypeError(`${subject}.${at}.date must be a date`); })(),
      self: Object.freeze({ hamming: between(item.self.hamming, `${at}.self.hamming`, 0, 5000, { integer: true }), total: between(item.self.total, `${at}.self.total`, 1, 5000, { integer: true }) }),
    });
  });
  return Object.freeze({
    source: Object.freeze({ repo: source.repo, commit: source.commit, license: text(source.license ?? "", "source.license", 40), name: text(source.name ?? "", "source.name", 40) }),
    prompt: Object.freeze({ system: text(prompt.system, "prompt.system", 400), user }),
    batchSize: between(raw.batchSize, "batchSize", 1, 30, { integer: true }),
    sample: between(raw.sample, "sample", 1, 10, { integer: true }),
    alpha: between(raw.alpha, "alpha", 0.0001, 0.2),
    confidence: between(raw.confidence, "confidence", 0.5, 0.9999),
    minCoverage: between(raw.minCoverage, "minCoverage", 0.1, 1),
    domains: Object.freeze(domains),
    sets: Object.freeze(sets),
  });
}
const isPlain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The knowledge-fingerprint sets a model id is served by (by the sets' `match`). */
export function fingerprintSetsFor(pack, modelId) {
  const value = String(modelId ?? "").toLowerCase();
  return (pack.fingerprint?.sets ?? []).filter((set) => set.pattern.test(value));
}

/** Names `{ zh, en }` as one `{ zh, en }` ("GPT / DeepSeek"). */
export const joinNames = (names) => ({ zh: names.map((name) => name.zh).join(" / "), en: names.map((name) => name.en).join(" / ") });

/** The tokenizer groups a model id is expected to have (by the groups' `match`). */
export function tokenizerExpected(pack, modelId) {
  const value = String(modelId ?? "").toLowerCase();
  return (pack.identity?.tokenizer?.groups ?? []).filter((group) => group.pattern?.test(value));
}

/** The tokenizer groups whose difference is `delta` (within the tolerance). */
export function tokenizerMatches(pack, delta) {
  const tokenizer = pack.identity?.tokenizer;
  if (!tokenizer || !Number.isFinite(delta)) return [];
  return tokenizer.groups.filter((group) => Math.abs(group.delta - delta) <= tokenizer.tolerance);
}

/**
 * A Claude id's tier and version: "claude-opus-4-6-thinking" → opus 4.6, "us.anthropic.claude-sonnet-4-5-v1:0" →
 * sonnet 4.5, "claude-3-5-haiku" → haiku 3.5, "claude-opus-4-20250514" → opus 4 (a date is no version). Null for
 * anything else (a Bedrock profile ARN names no model).
 */
export function versionOf(modelId) {
  const value = String(modelId ?? "").toLowerCase();
  if (!/claude/.test(value) || /^arn:/.test(value)) return null;
  const named = /(opus|sonnet|haiku|fable|mythos)[-_. ]?(\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?/.exec(value);
  if (named) return { tier: named[1], version: `${Number(named[2])}.${Number(named[3] ?? 0)}` };
  const older = /claude[-_. ](\d)(?:[-_.](\d))?[-_. ](opus|sonnet|haiku)/.exec(value);
  if (older) return { tier: older[3], version: `${Number(older[1])}.${Number(older[2] ?? 0)}` };
  return null;
}

/** The active checks' wording: per check, phrasings in both languages with `{slot}`s, and the slot values. */
function validateProbes(raw) {
  if (!raw || typeof raw !== "object") throw new TypeError("probes must be an object");
  const out = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!ID_PATTERN.test(name)) throw new TypeError(`probes.${name}: bad name`);
    const phrasings = {};
    for (const lang of ["en", "zh"]) {
      phrasings[lang] = list(entry?.phrasings?.[lang] ?? [], `probes.${name}.phrasings.${lang}`, 20).map((text) => {
        if (typeof text !== "string" || text.length === 0 || text.length > LIMITS.text) throw new TypeError(`probes.${name}.phrasings.${lang}: bad text`);
        return text;
      });
    }
    if (phrasings.en.length + phrasings.zh.length === 0) throw new TypeError(`probes.${name} has no phrasing`);
    const slots = {};
    for (const [slot, values] of Object.entries(entry?.slots ?? {})) {
      if (!/^[a-z]{1,20}$/.test(slot)) throw new TypeError(`probes.${name}.slots.${slot}: bad name`);
      slots[slot] = list(values, `probes.${name}.slots.${slot}`, 50).map((value) => {
        if (typeof value !== "string" || value.length === 0 || value.length > 80) throw new TypeError(`probes.${name}.slots.${slot}: bad value`);
        return value;
      });
    }
    const expect = entry?.expect === undefined ? [] : list(entry.expect, `probes.${name}.expect`, 20).map((value) => {
      if (typeof value !== "string" || value.length === 0 || value.length > 40) throw new TypeError(`probes.${name}.expect: bad value`);
      return value;
    });
    out[name] = { phrasings, slots, expect };
  }
  return Object.freeze(out);
}

/** The pack shipped with the plugin. */
let builtin;
export function builtinPack() {
  if (!builtin) {
    const text = readFileSync(new URL("./pack.json", import.meta.url), "utf8");
    builtin = validatePack(JSON.parse(text));
  }
  return builtin;
}

/**
 * Whether `signature` (base64) is the Ed25519 signature of `bytes` under `publicKey` (PEM). False on any
 * problem: a missing key, a malformed signature.
 */
export function verifyPackSignature(bytes, signature, publicKey) {
  try {
    if (!publicKey || typeof signature !== "string") return false;
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(bytes), key, Buffer.from(signature.trim(), "base64"));
  } catch {
    return false;
  }
}

/**
 * A downloaded pack's text and signature, checked in full: signature, size, form, the plugin version it needs,
 * and newer than `current`.
 * @returns `{ ok: true, pack }` or `{ ok: false, reason }` (a short English reason, for the log and the page).
 */
export function acceptPack(text, signature, { publicKey, current, pluginVersion = PLUGIN_VERSION }) {
  if (typeof text !== "string" || text.length === 0) return { ok: false, reason: "empty" };
  if (Buffer.byteLength(text) > LIMITS.bytes) return { ok: false, reason: "too large" };
  if (!verifyPackSignature(Buffer.from(text, "utf8"), signature, publicKey)) return { ok: false, reason: "signature" };
  let pack;
  try {
    pack = validatePack(JSON.parse(text));
  } catch (error) {
    return { ok: false, reason: `form: ${error.message}` };
  }
  if (compareSemver(pluginVersion, pack.minPlugin) < 0) return { ok: false, reason: `needs plugin ${pack.minPlugin}` };
  if (current && compareVersions(pack.version, current) <= 0) return { ok: false, reason: "not newer" };
  return { ok: true, pack };
}

/** The value of one observation field a signal reads (headers and usage fields are lists). */
function fieldValues(wire, field) {
  if (field === "header") return Array.isArray(wire.headers) ? wire.headers : [];
  if (field === "usageField") return Array.isArray(wire.usageFields) ? wire.usageFields : [];
  const value = wire[field];
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

/** The signals an answer's wire matches (`protocol`: chat / responses / messages). */
export function matchSignals(pack, wire, protocol) {
  const out = [];
  for (const signal of pack.signals) {
    if (signal.protocol && !signal.protocol.includes(protocol)) continue;
    const values = fieldValues(wire, signal.field);
    const hit = values.some((value) => {
      const text = String(value).slice(0, 300);
      switch (signal.op) {
        case "present": return true;
        case "equals": return text.toLowerCase() === signal.value.toLowerCase();
        case "prefix": return text.toLowerCase().startsWith(signal.value.toLowerCase());
        case "includes": return text.toLowerCase().includes(signal.value.toLowerCase());
        case "regex": return signal.pattern.test(text);
        default: return false;
      }
    });
    if (hit) out.push(signal.id);
  }
  return out;
}

/** The stub an answer's visible text is, or null (only a short answer can be one). */
export function matchStub(pack, text) {
  const value = String(text ?? "");
  if (!value.trim()) return null;
  for (const stub of pack.stubs) if (value.length <= stub.maxChars && stub.pattern.test(value.slice(0, stub.maxChars))) return stub.id;
  return null;
}

/** A model id's family and tier per the pack (`anthropic/claude-opus-5.5` → claude, opus), or null. */
export function familyOf(pack, modelId) {
  const value = String(modelId ?? "").toLowerCase();
  if (!value) return null;
  for (const family of pack.families) {
    if (!family.pattern.test(value)) continue;
    const tier = family.tiers.find((name) => new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(value)) ?? null;
    return { family: family.id, tier, entry: family };
  }
  return null;
}
