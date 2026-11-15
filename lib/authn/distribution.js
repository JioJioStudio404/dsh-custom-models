/**
 * Distribution fingerprints ("分布指纹"), after distributional fingerprint auditing (Miao, Niu, Huang, Li: "Is Your LLM
 * Relay Serving What It Claims?", arXiv 2610.37086, CC BY 4.0) as relaycheck implements it (github.com/YanYunCY/relaycheck,
 * MIT, © 2026 relaycheck contributors; probe set v2, answer normalization and statistics ported from commit 43d9294).
 *
 * A model asked a finite-choice question at temperature 1 ("Pick a name for a kitten: Luna, Milo, …") answers with
 * frequencies of its own: different models, and different snapshots of one model, prefer different answers. The site's
 * model answers 24 such questions `samples` times each; every question's answer counts are compared with a reference
 * recorded on a trusted endpoint (Pearson χ² for homogeneity, Monte Carlo permutation p-value with mid-p, divided by the
 * reference endpoint's over-dispersion), and the 24 p-values are merged (Cauchy combination) into one.
 * - p < 0.001: the answers differ from the reference model's ("fail"); conclusive only far below that, on a reference
 *   from the vendor's own API, with the protocol and sampling matching.
 * - p < 0.01: a mild deviation, shown only.
 * - otherwise, with enough answers: consistent with the reference model.
 * The references closest to the answers (by likelihood) name what the model likely is instead.
 *
 * A statistical verdict is evidence, not proof: a relay that serves the model named most of the time, or that
 * recognises these fixed questions, can pass; a near-identical variant may pass too.
 *
 * Billing baselines (the input tokens the vendor's API counts for three fixed prompts) travel with the references:
 * the protocol check (probes.js) compares a site's counts with them (a hidden prompt adds the same tokens to each).
 *
 * @module dsh-custom-models/authn/distribution
 */
import { readFileSync } from "node:fs";
import { redact } from "../errors.js";
import { ask, spentOf } from "./probes.js";

// ------------------------------------------------------------------ probes (relaycheck probe set v2)

const ONLY = "Reply with only your choice, nothing else.";
const nums = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
const pick = (id, what, opts, aliases) => ({ id, prompt: `${what}: ${opts.join(", ")}. ${ONLY}`, labels: opts.map((o) => o.toLowerCase()), ...(aliases ? { aliases } : {}) });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const COINS = ["hhh", "hht", "hth", "htt", "thh", "tht", "tth", "ttt"];

/** The probe set every reference is recorded with (relaycheck's v2: prompts, labels and aliases verbatim). */
export const PROBE_SET = "relaycheck-v2";
export const PROBES = Object.freeze([
  pick("letter10", "Pick one letter", ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]),
  { id: "zh_animal", prompt: "从下面的动物中随机选一个：猫、狗、兔、马、熊、鹰。只回答一个字。", labels: ["猫", "狗", "兔", "马", "熊", "鹰"], aliases: { 猫: ["cat"], 狗: ["dog"], 兔: ["rabbit"], 马: ["horse"], 熊: ["bear"], 鹰: ["eagle"] } },
  pick("continent", "Pick one continent", ["Africa", "Antarctica", "Asia", "Australia", "Europe", "North America", "South America"]),
  pick("catname", "Pick a name for a kitten", ["Luna", "Milo", "Oliver", "Leo", "Bella", "Max"]),
  { id: "month", prompt: `Pick a random month of the year. ${ONLY}`, labels: MONTHS.map((m) => m.toLowerCase()), aliases: Object.fromEntries(MONTHS.map((m) => [m.toLowerCase(), [m.slice(0, 3).toLowerCase()]])) },
  pick("metal", "Pick one metal", ["gold", "silver", "copper", "iron", "tin", "platinum"]),
  { id: "coin3", prompt: "Flip a fair coin three times. Reply with only the sequence using H and T, like HTH, nothing else.", labels: COINS, aliases: Object.fromEntries(COINS.map((s) => [s, [s.split("").join(" "), s.split("").join("-"), s.split("").join(", ")]])) },
  pick("flower", "Pick one flower", ["rose", "tulip", "daisy", "lily", "sunflower", "orchid"]),
  pick("sport", "Pick one sport", ["soccer", "tennis", "basketball", "golf", "swimming", "cycling"], { soccer: ["football"] }),
  pick("daytime", "Pick one time of day", ["morning", "afternoon", "evening", "night"]),
  { id: "one_to_20", prompt: `Pick a random whole number from 1 to 20. ${ONLY}`, labels: nums(1, 20) },
  pick("weekday", "Pick a day of the week", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
  pick("animal_rev", "Choose one animal", ["bear", "fox", "owl", "dog", "cat"]),
  pick("tree", "Pick one tree", ["oak", "pine", "maple", "birch", "willow", "cedar"]),
  pick("rps", "Play one round of rock paper scissors. Choose one", ["rock", "paper", "scissors"]),
  pick("shape", "Pick one shape", ["circle", "square", "triangle", "hexagon", "star"]),
  pick("planet", "Pick one planet", ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]),
  pick("dessert", "Pick one dessert", ["cake", "pie", "cookie", "pudding", "brownie", "donut"], { cookie: ["cookies"], donut: ["doughnut"], brownie: ["brownies"] }),
  pick("suit", "Pick one card suit", ["hearts", "diamonds", "clubs", "spades"], { hearts: ["heart", "♥", "♥️"], diamonds: ["diamond", "♦", "♦️"], clubs: ["club", "♣", "♣️"], spades: ["spade", "♠", "♠️"] }),
  { id: "digit_not7", prompt: `Pick a random digit from 0 to 9, but not 7. ${ONLY}`, labels: nums(0, 9) },
  pick("season", "Pick one season", ["spring", "summer", "autumn", "winter"], { autumn: ["fall"] }),
  pick("animal", "Choose one animal", ["cat", "dog", "owl", "fox", "bear"]),
  { id: "zh_color", prompt: "从下面的颜色中随机选一个：红、橙、黄、绿、蓝、紫。只回答一个字。", labels: ["红", "橙", "黄", "绿", "蓝", "紫"], aliases: { 红: ["red"], 橙: ["orange"], 黄: ["yellow"], 绿: ["green"], 蓝: ["blue"], 紫: ["purple"] } },
  { id: "card_rank", prompt: "Draw one card from a shuffled standard deck. Reply with only its rank (A, 2-10, J, Q or K), nothing else.", labels: ["a", ...nums(2, 10), "j", "q", "k"], aliases: { a: ["ace"], j: ["jack"], q: ["queen"], k: ["king"] } },
].map((probe) => Object.freeze(probe)));

// ------------------------------------------------------------------ answer normalization (relaycheck classify.ts)

export const OTHER = "other";
const NUMBER_WORDS = {
  0: ["zero", "零", "〇"], 1: ["one", "一"], 2: ["two", "二", "两"], 3: ["three", "三"], 4: ["four", "四"], 5: ["five", "五"],
  6: ["six", "六"], 7: ["seven", "七"], 8: ["eight", "八"], 9: ["nine", "九"], 10: ["ten", "十"], 11: ["eleven", "十一"], 12: ["twelve", "十二"],
};
const CJK = /[　-鿿가-힯豈-﫿]/;
const LEAD_IN = /^(?:(?:my\s+)?(?:final\s+)?(?:answer|choice|pick|selection|guess)\s*(?:is)?\s*[:：\-–]?\s*|(?:i(?:'d|’d| would| will|'ll|’ll)?|let'?s)\s+(?:pick|choose|select|go\s+with|say|take)\s*[:：\-–]?\s*|(?:答案|我选|选择|我的选择)\s*(?:是)?\s*[:：]?\s*)/;

/** An answer reduced to its words: width, case, markup, quotes, lead-ins and trailing punctuation removed. */
export function normalizeAnswer(text) {
  let t = String(text ?? "").normalize("NFKC");
  t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ");
  t = t.replace(/<think(?:ing)?>[\s\S]*$/i, " ");
  t = t.toLowerCase();
  t = t.replace(/[*_`~#>|]+/g, " ");
  t = t.replace(/["“”„«»「」『』《》【】]/g, " ");
  t = t.replace(/(^|\s)['‘’]+|['‘’]+(?=\s|$|[.,!?;:。，！？；：])/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i += 1) t = t.replace(LEAD_IN, "").trim();
  t = t.replace(/[\s.,!?;:。，！？；：…、]+$/u, "").replace(/^[\s.,!?;:。，！？；：…、(（[]+/u, "").replace(/[)）\]]+$/u, "");
  return t.trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function wordIndex(hay, needle) {
  if (CJK.test(needle)) return hay.indexOf(needle);
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}(?=$|[^\\p{L}\\p{N}])`, "u").exec(hay);
  return m ? m.index + m[1].length : -1;
}

/** One answer's label among a probe's (`other` when it names none, or two). */
export function classify(labels, text, aliases = {}) {
  const t = normalizeAnswer(text);
  if (!t) return OTHER;
  const forms = [];
  for (const label of labels) {
    forms.push({ form: label.toLowerCase(), label, exactOnly: false });
    for (const alias of aliases[label] ?? []) forms.push({ form: alias.toLowerCase().normalize("NFKC"), label, exactOnly: false });
    for (const word of NUMBER_WORDS[label] ?? []) forms.push({ form: word, label, exactOnly: CJK.test(word) });
  }
  for (const f of forms) if (t === f.form) return f.label;
  const u = t.replace(/(\p{L})['’](d|ll|m|s|t|re|ve)\b/gu, "$1");
  const short = forms.filter((f) => f.form.length === 1 && !CJK.test(f.form));
  const long = forms.filter((f) => !(f.form.length === 1 && !CJK.test(f.form)) && !f.exactOnly);
  let best = null;
  let bestIdx = Infinity;
  let bestLen = 0;
  for (const f of long) {
    const i = wordIndex(u, f.form);
    if (i < 0) continue;
    if (i < bestIdx || (i === bestIdx && f.form.length > bestLen)) {
      bestIdx = i;
      bestLen = f.form.length;
      best = f.label;
    }
  }
  if (best !== null) return best;
  if (short.length) {
    const tokens = u.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let hits = [...new Set(tokens.filter((tok) => short.some((f) => f.form === tok)))];
    if (hits.length > 1) hits = hits.filter((h) => h !== "a" && h !== "i");
    if (hits.length === 1 && (tokens.length <= 4 || /^(letter|digit|number|option)$/.test(tokens[tokens.indexOf(hits[0]) - 1] ?? ""))) return short.find((f) => f.form === hits[0]).label;
  }
  return OTHER;
}

// ------------------------------------------------------------------ statistics (relaycheck stats.ts)

/** FNV-1a 32-bit. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** mulberry32: a seeded generator of floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < LANCZOS.length; i += 1) a += LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 1000; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - logGamma(a)));
  }
  return 1 - gammaQ(a, x);
}
function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaP(a, x);
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, Math.exp(-x + a * Math.log(x) - logGamma(a)) * h);
}
/** P(X ≥ x) for X ~ χ²(df). */
export const chiSquareSf = (x, df) => (df <= 0 || x <= 0 ? 1 : gammaQ(df / 2, x / 2));
const sum = (xs) => xs.reduce((acc, x) => acc + x, 0);

/** Pearson χ² for homogeneity of two count vectors over the same categories. */
export function chiSquareHomogeneity(a, b) {
  const na = sum(a);
  const nb = sum(b);
  const n = na + nb;
  if (na === 0 || nb === 0) return { stat: 0, df: 0, p: 1 };
  let stat = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    const col = a[i] + b[i];
    if (col === 0) continue;
    k += 1;
    const ea = (na * col) / n;
    const eb = (nb * col) / n;
    stat += (a[i] - ea) ** 2 / ea + (b[i] - eb) ** 2 / eb;
  }
  const df = Math.max(0, k - 1);
  return { stat, df, p: df === 0 ? 1 : chiSquareSf(stat, df) };
}
function chiStat(a, b, na, nb) {
  const n = na + nb;
  let stat = 0;
  for (let i = 0; i < a.length; i += 1) {
    const col = a[i] + b[i];
    if (col === 0) continue;
    const da = a[i] - (na * col) / n;
    const db = b[i] - (nb * col) / n;
    stat += (da * da) / ((na * col) / n) + (db * db) / ((nb * col) / n);
  }
  return stat;
}
/** Cochran's rule: every expected count ≥ 1 and 80 % of them ≥ 5 (only then is the asymptotic tail trusted). */
export function asymptoticOk(a, b) {
  const na = sum(a);
  const nb = sum(b);
  const n = na + nb;
  let cells = 0;
  let ge5 = 0;
  for (let i = 0; i < a.length; i += 1) {
    const col = a[i] + b[i];
    if (col === 0) continue;
    for (const e of [(na * col) / n, (nb * col) / n]) {
      cells += 1;
      if (e < 1) return false;
      if (e >= 5) ge5 += 1;
    }
  }
  return cells > 0 && ge5 >= 0.8 * cells;
}

/**
 * Two-sample χ² homogeneity test with a Monte Carlo permutation p-value (the pooled answers re-split at random into
 * the two sizes), sequential stopping (Besag & Clifford), mid-p, the observed statistic divided by the dispersion φ.
 */
export function homogeneityTest(a, b, rng, { hits = 40, maxReps = 20_000, extendReps = 100_000, midP = true, dispersion = 1 } = {}) {
  const raw = chiSquareHomogeneity(a, b);
  const phi = Math.max(1, dispersion);
  const base = phi === 1 ? raw : { ...raw, stat: raw.stat / phi, p: raw.df === 0 ? 1 : chiSquareSf(raw.stat / phi, raw.df) };
  if (base.df === 0) return { ...base, pValue: 1, method: "monte-carlo", reps: 0 };
  const na = sum(a);
  const nb = sum(b);
  const pooled = a.map((x, i) => x + b[i]);
  const n = na + nb;
  const sa = pooled.map(() => 0);
  const sb = pooled.map(() => 0);
  const left = pooled.slice();
  const tol = 1e-9 * Math.max(1, base.stat);
  const target = base.stat - tol;
  let total = 0;
  let exceed = 0;
  let ties = 0;
  const small = Math.min(na, nb);
  const smallIsA = na <= nb;
  const run = (limit, stopAt) => {
    while (total < limit && exceed < stopAt) {
      for (let i = 0; i < left.length; i += 1) left[i] = pooled[i];
      const draw = smallIsA ? sa : sb;
      const rest = smallIsA ? sb : sa;
      draw.fill(0);
      let remaining = n;
      for (let d = 0; d < small; d += 1) {
        let u = Math.floor(rng() * remaining);
        let j = 0;
        while (u >= left[j]) u -= left[j++];
        left[j] -= 1;
        draw[j] += 1;
        remaining -= 1;
      }
      for (let i = 0; i < pooled.length; i += 1) rest[i] = pooled[i] - draw[i];
      total += 1;
      const st = chiStat(sa, sb, na, nb);
      if (st >= target) {
        exceed += 1;
        if (st <= base.stat + tol) ties += 1;
      }
    }
  };
  const mc = (plusOne) => {
    const e = midP ? exceed - ties / 2 - (plusOne ? 0.5 : 0) : exceed;
    return plusOne ? (e + 1) / (total + 1) : e / total;
  };
  run(maxReps, hits);
  if (exceed >= hits) return { ...base, pValue: mc(false), method: "monte-carlo", reps: total };
  if (exceed === 0 && extendReps > total) run(extendReps, 1);
  if (exceed > 0) return { ...base, pValue: mc(true), method: "monte-carlo", reps: total };
  const floor = 1 / (total + 1);
  if (asymptoticOk(a, b) && base.p < floor) return { ...base, pValue: base.p, method: "asymptotic-tail", reps: total };
  return { ...base, pValue: floor, method: "mc-floor", reps: total };
}

/** Cauchy combination (Liu & Xie 2020): valid under dependence, dominated by the strongest signals. */
export function cauchyCombination(pValues) {
  if (pValues.length === 0) return 1;
  const w = 1 / pValues.length;
  let t = 0;
  for (const value of pValues) {
    const p = Math.min(0.99, Math.max(0, value));
    if (p < 1e-15) t += w / (Math.max(p, 1e-300) * Math.PI);
    else t += w * Math.tan((0.5 - p) * Math.PI);
  }
  if (t > 1e15) return Math.max(0, 1 / (t * Math.PI));
  return Math.min(1, Math.max(0, 0.5 - Math.atan(t) / Math.PI));
}

/** Two label → count maps over the union of their labels. */
export function align(a, b) {
  const labels = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return { labels, a: labels.map((k) => a[k] ?? 0), b: labels.map((k) => b[k] ?? 0) };
}

/** Endpoint p below which the answers differ from the reference; below the second, a mild deviation. */
export const FAIL_P = 0.001;
export const WARN_P = 0.01;
/**
 * Conclusive (a different model, not a doubt) only when, on a vendor's own reference, this share of the informative
 * questions (at least HARD_MIN) differs on its own (p < FAIL_P): not one question's fluke. A combined p cannot go far
 * below the permutation floor (about 1e-5), so the count of differing questions carries the strength.
 */
export const HARD_SHARE = 0.25;
export const HARD_MIN = 4;
/** Across protocols (the same model drifts; relaycheck measured p 1e-4 on the official API) only below this. */
export const MISMATCH_P = 1e-6;
/** A run where more of the requests failed is never called consistent. */
export const MAX_ERROR_RATE = 0.2;
/** Agreement needs this many informative probes (both sides not one same answer), and few failed requests. */
export const MIN_INFORMATIVE = 12;
export const AGREE_ERROR_RATE = 0.1;
export const MAX_DISPERSION = 2;

/**
 * A run's answer counts against one reference: per-probe tests, the combined p, which probes differ most.
 * @param {{ id: string, dist: object, errors: number }[]} observed
 * @param {object} ref - `{ probes: { id: dist }, dispersion }`.
 * @param {number} seed - each probe gets its own stream (seed ⊕ probe id): p does not depend on order.
 */
export function scoreDistribution(observed, ref, seed, mc = {}) {
  const dispersion = Math.min(MAX_DISPERSION, Math.max(1, Number(ref.dispersion) || 1));
  const stats = [];
  let errors = 0;
  let requested = 0;
  for (const o of observed) {
    const reference = ref.probes?.[o.id];
    errors += o.errors;
    const n = sum(Object.values(o.dist));
    requested += n + o.errors;
    if (!reference || n === 0) continue;
    const al = align(o.dist, reference);
    const test = homogeneityTest(al.a, al.b, mulberry32(hash32(`${seed}:${o.id}`)), { dispersion, ...mc });
    stats.push({ id: o.id, n, p: test.pValue, df: test.df, method: test.method });
  }
  const errorRate = requested ? errors / requested : 0;
  const informative = stats.filter((s) => s.df > 0);
  const p = stats.length === 0 ? null : informative.length ? cauchyCombination(informative.map((s) => s.p)) : 1;
  const worst = [...informative].sort((a, b) => a.p - b.p).slice(0, 3).map((s) => s.id);
  const differing = informative.filter((s) => s.p < FAIL_P).length;
  return { p, stats, informative: informative.length, differing, errorRate, worst };
}

/**
 * The references closest to a run's answers: the log-likelihood of the counts under each reference's (smoothed)
 * frequencies, per answer, best first.
 */
export function rankReferences(observed, refs) {
  const out = [];
  for (const ref of refs) {
    let ll = 0;
    let n = 0;
    for (const o of observed) {
      const reference = ref.probes?.[o.id];
      if (!reference) continue;
      const labels = new Set([...Object.keys(reference), ...Object.keys(o.dist), OTHER]);
      const total = sum(Object.values(reference)) + 0.5 * labels.size;
      for (const [label, count] of Object.entries(o.dist)) {
        ll += count * Math.log(((reference[label] ?? 0) + 0.5) / total);
        n += count;
      }
    }
    if (n > 0) out.push({ ref, perAnswer: ll / n });
  }
  return out.sort((a, b) => b.perAnswer - a.perAnswer);
}

// ------------------------------------------------------------------ references

/** The prompts whose input tokens the vendor's API counts (relaycheck's billing baselines, verbatim). */
const PARAGRAPH = "Bridges have carried people across rivers and valleys for thousands of years. Early builders used stone arches, timber trusses and rope walkways, each suited to the materials and skills of their time. Engineers later learned to balance tension and compression with iron, steel and concrete, which made longer spans possible. ";
const billingPrompt = (repeats) => `Reference RC-BASELINE-0001.\n${PARAGRAPH.repeat(repeats)}\nReply with OK.`;
export const BASELINE_PROMPTS = Object.freeze({ b1: billingPrompt(1), b4: billingPrompt(4), b12: billingPrompt(12) });

let loaded = null;
/** The references this build carries (`distribution-refs.json`), checked entry by entry; a malformed one is left out. */
export function references() {
  if (loaded) return loaded;
  let raw;
  try {
    raw = JSON.parse(readFileSync(new URL("./distribution-refs.json", import.meta.url), "utf8"));
  } catch {
    raw = { refs: [] };
  }
  const ids = new Set(PROBES.map((probe) => probe.id));
  const refs = [];
  for (const entry of Array.isArray(raw?.refs) ? raw.refs : []) {
    try {
      if (typeof entry.id !== "string" || typeof entry.model !== "string" || !["chat", "responses", "messages"].includes(entry.protocol)) continue;
      if (raw.probeSet !== PROBE_SET && entry.probeSet !== PROBE_SET) continue;
      const probes = {};
      for (const [id, dist] of Object.entries(entry.probes ?? {})) {
        if (!ids.has(id) || !dist || typeof dist !== "object") continue;
        const clean = {};
        for (const [label, count] of Object.entries(dist)) if (Number.isInteger(count) && count > 0 && label.length <= 40) clean[label] = count;
        if (Object.keys(clean).length) probes[id] = clean;
      }
      if (Object.keys(probes).length < MIN_INFORMATIVE) continue;
      refs.push(Object.freeze({
        id: entry.id,
        model: entry.model,
        match: new RegExp(entry.match ?? escapeRe(entry.model), "i"),
        protocol: entry.protocol,
        official: entry.official === true,
        host: entry.host ?? null,
        source: entry.source ?? null,
        recorded: String(entry.recorded ?? "").slice(0, 10),
        samples: Number(entry.samples) || 0,
        dispersion: Number(entry.dispersion) || 1,
        sampling: { temperature: entry.sampling?.temperature ?? 1, topP: entry.sampling?.topP ?? null, maxTokens: Number(entry.sampling?.maxTokens) || 16, thinking: entry.sampling?.thinking ?? null, effort: entry.sampling?.effort ?? null },
        probes,
        billing: entry.billing ?? null,
      }));
    } catch {
      /* a malformed reference is left out */
    }
  }
  loaded = Object.freeze({ refs: Object.freeze(refs), source: raw?.source ?? null });
  return loaded;
}
/** For tests: use these references instead of the file. */
export function setReferences(refs) {
  loaded = refs === null ? null : { refs, source: null };
}

/** A model id as references are matched: the provider prefix removed ("deepseek-ai/DeepSeek-V4.1-Flash-1017" → "deepseek-v4.1-flash-1017"). */
export const bareId = (modelId) => String(modelId ?? "").toLowerCase().split("/").at(-1);

/**
 * The reference for a model on a protocol: one recorded on that protocol (else another protocol's, marked `mismatch`).
 * Null when none serves the model.
 */
export function referenceFor(modelId, protocol, refs = references().refs) {
  const id = bareId(modelId);
  const matching = refs.filter((ref) => ref.match.test(id));
  if (!matching.length) return null;
  const rank = (ref) => (ref.protocol === protocol ? 0 : 1) * 10 + (ref.official ? 0 : 1);
  const best = [...matching].sort((a, b) => rank(a) - rank(b))[0];
  return { ref: best, mismatch: best.protocol !== protocol };
}

/** The vendor-counted input tokens of the billing prompts for a model on a protocol (`{ b1, b4, b12 }`), or null. */
export function baselineFor(modelId, protocol, refs = references().refs) {
  const id = bareId(modelId);
  for (const ref of refs) {
    if (!ref.match.test(id)) continue;
    const counts = ref.billing?.[protocol];
    if (counts && [counts.b1, counts.b4, counts.b12].every((value) => Number.isInteger(value) && value > 0)) return { ...counts, ref: ref.id, official: ref.official };
  }
  return null;
}

// ------------------------------------------------------------------ the run

/** Answers per probe in a check (24 probes: 480 requests). */
export const DEFAULT_SAMPLES = 20;
/** Requests at once, and the pause before each (a relay seeing a burst may take it for abuse). */
export const CONCURRENCY = 3;
export const PACE_MS = 250;
const BUSY_POLL_MS = 2_000;
const BUSY_MAX_MS = 300_000;
const RETRIES = 4;
const RETRY_CAP_MS = 60_000;
const RETRYABLE = new Set([0, 408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
/** A run stops when this share of its first requests failed (the site is failing; nothing to measure). */
const EARLY_FAILURE_RATE = 0.5;
const EARLY_SAMPLE = 48;
/** …and when its first this many requests all failed (live 2026-11-15: a site that stopped answering kept a run retrying 7 minutes). */
const FIRST_FAILURES = 6;

/** The requests a check sends (the strategy search at most `extra` more). */
export const distributionRequests = (samples = DEFAULT_SAMPLES) => PROBES.length * samples;

/** Statuses after which nothing more is asked: a refused key (401, 403), no balance left (402). */
export const STOPS = new Set([401, 402, 403]);

/** A key the site refused, or a balance run out: the run stops. */
export class KeyRefused extends Error {
  constructor(status, detail) {
    super(`key refused (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

/** How a site is asked for the reference's sampling, in order, per protocol. */
export function strategiesFor(ref, protocol) {
  const effort = ref.sampling.effort;
  if (effort) {
    if (protocol === "responses") return [{ id: `effort-${effort}`, body: { reasoning: { effort } } }];
    if (protocol === "messages") return [{ id: `effort-${effort}`, body: { output_config: { effort } } }];
    return [{ id: `effort-${effort}`, body: { reasoning_effort: effort } }];
  }
  if (ref.sampling.thinking === "off") {
    if (protocol === "messages") return [{ id: "thinking-disabled", body: { thinking: { type: "disabled" } } }, { id: "bare", body: {} }];
    if (protocol === "responses") return [{ id: "reasoning-none", body: { reasoning: { effort: "none" } } }, { id: "bare", body: {} }];
    return [{ id: "thinking-disabled", body: { thinking: { type: "disabled" } } }, { id: "enable-thinking-false", body: { enable_thinking: false } }, { id: "reasoning-none", body: { reasoning_effort: "none" } }, { id: "bare", body: {} }];
  }
  return [{ id: "bare", body: {} }];
}

/** Whether an answer came with reasoning (a model asked not to think, thinking). */
export function reasoned(result) {
  if ((result?.usage?.reasoning ?? 0) > 0) return true;
  if ((result?.thinking ?? []).some((block) => String(block?.thinking ?? block?.data ?? "").length > 0)) return true;
  const message = result?.raw?.choices?.[0]?.message;
  return typeof message?.reasoning_content === "string" && message.reasoning_content.trim().length > 0 || typeof message?.reasoning === "string" && message.reasoning.trim().length > 0;
}

/**
 * Sample the probes on a site's model (`samples` answers each, interleaved, a few at once), as the reference was
 * sampled: temperature 1 (top-p 1 where the reference set it), its output limit, its reasoning setting.
 * @param {object} input - `ref`, `endpoint`, `model` (effective), `key`, `samples`, `fetchImpl`, `signal`, `meter(spent)`,
 *   `busy()`, `onStep(step, steps)`, `sleep(ms)`, `concurrency`, `pace`.
 * @returns `{ observed: [{ id, dist, errors }], strategy, dropped: [fields], reasoning: n, answered: n, failed: n,
 *   usage, others: { probe: [texts] }, lastError }`; throws a KeyRefused when the site refuses the key.
 */
export async function sampleDistribution({ ref, endpoint, model, key, samples = DEFAULT_SAMPLES, fetchImpl = fetch, signal, meter = () => {}, busy = () => false, onStep = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), concurrency = CONCURRENCY, pace = PACE_MS, probes = PROBES }) {
  const protocol = model.protocol ?? endpoint.protocol ?? "chat";
  const usage = { requests: 0, input: 0, output: 0 };
  const dropped = new Set();
  let lastError = null;
  const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  const waitTurn = async () => {
    let waited = 0;
    while (busy() && waited < BUSY_MAX_MS) {
      if (signal?.aborted) throw aborted();
      await sleep(BUSY_POLL_MS);
      waited += BUSY_POLL_MS;
    }
    if (pace > 0) await sleep(pace);
  };
  const bodyOf = (strategy) => {
    const extra = { ...strategy.body };
    if (ref.sampling.topP !== null && protocol !== "messages" && !dropped.has("top_p")) extra.top_p = ref.sampling.topP;
    return extra;
  };
  /** One request with retries: a field the site refuses is dropped once (noted), rate limits wait, a refused key stops. */
  const request = async (probe, strategy) => {
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw aborted();
      await waitTurn();
      const temperature = dropped.has("temperature") ? undefined : ref.sampling.temperature;
      const result = await ask({ endpoint, model, key, fetchImpl, signal, prompt: probe.prompt, maxTokens: ref.sampling.maxTokens, ...(temperature === undefined ? {} : { temperature }), extra: bodyOf(strategy) });
      if (result.ok) {
        usage.requests += 1;
        usage.input += result.usage?.input ?? 0;
        usage.output += result.usage?.output ?? 0;
        try {
          meter(spentOf(result));
        } catch {
          /* the count is the service's concern */
        }
        return result;
      }
      if (STOPS.has(result.status)) throw new KeyRefused(result.status, String(result.error ?? "").slice(0, 160));
      const text = String(result.error ?? "");
      if (result.status === 400 || result.status === 422) {
        if (!dropped.has("temperature") && /temperature/i.test(text)) {
          dropped.add("temperature");
          continue;
        }
        if (!dropped.has("top_p") && /top[_ ]?p/i.test(text)) {
          dropped.add("top_p");
          continue;
        }
        return result;
      }
      if (!RETRYABLE.has(result.status) || attempt >= RETRIES) return result;
      const after = Number(result.headers?.get?.("retry-after"));
      await sleep(Math.min(RETRY_CAP_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 3_000 * 2 ** attempt));
    }
  };

  // The way this site gives the reference's sampling: the first strategy answering in words, without reasoning when
  // the reference had none. Its answer counts as a sample.
  const candidates = strategiesFor(ref, protocol);
  let strategy = null;
  let first = null;
  for (const candidate of candidates) {
    const result = await request(probes[0], candidate);
    if (!result.ok) {
      lastError = `${result.status} ${String(result.error ?? "").slice(0, 120)}`;
      if (result.status === 400 || result.status === 422) continue;
      break;
    }
    const thinkingLeft = ref.sampling.thinking === "off" && reasoned(result);
    if (String(result.text ?? "").trim() && !thinkingLeft) {
      strategy = candidate;
      first = result;
      break;
    }
    if (!strategy) {
      strategy = candidate;
      first = result;
    }
  }
  if (!strategy) strategy = candidates.at(-1);
  const tasks = [];
  for (let round = 0; round < samples; round += 1) for (const probe of probes) tasks.push(probe);
  const total = tasks.length;
  const counts = Object.fromEntries(probes.map((probe) => [probe.id, { dist: {}, errors: 0 }]));
  const others = {};
  let reasoning = 0;
  let answered = 0;
  let failed = 0;
  let done = 0;
  const take = (probe, result) => {
    done += 1;
    if (!result?.ok) {
      counts[probe.id].errors += 1;
      failed += 1;
      if (result) lastError = `${result.status} ${String(result.error ?? "").slice(0, 120)}`;
    } else {
      answered += 1;
      if (reasoned(result)) reasoning += 1;
      const label = classify(probe.labels, result.text, probe.aliases);
      counts[probe.id].dist[label] = (counts[probe.id].dist[label] ?? 0) + 1;
      if (label === OTHER && (others[probe.id]?.length ?? 0) < 3) (others[probe.id] ??= []).push(redact(String(result.text ?? "")).replace(/\s+/g, " ").slice(0, 40));
    }
    onStep(done, total);
  };
  if (first) {
    take(probes[0], first);
    tasks.splice(tasks.indexOf(probes[0]), 1);
  }
  let next = 0;
  let stop = null;
  const worker = async () => {
    while (next < tasks.length && !stop) {
      const probe = tasks[next];
      next += 1;
      let result;
      try {
        result = await request(probe, strategy);
      } catch (error) {
        stop ??= error;
        return;
      }
      take(probe, result);
      if (done >= EARLY_SAMPLE && failed / done > EARLY_FAILURE_RATE) stop ??= Object.assign(new Error(`most requests failed (${lastError ?? "no answer"})`), { code: "FAILING" });
      // Not one answer from the first requests (each already retried): the site is not answering; nothing to measure.
      if (answered === 0 && failed >= FIRST_FAILURES) stop ??= Object.assign(new Error(`no answer (${lastError ?? "-"})`), { code: "FAILING" });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (stop && (stop instanceof KeyRefused || stop.name === "AbortError")) throw stop;
  return { observed: probes.map((probe) => ({ id: probe.id, ...counts[probe.id] })), strategy: strategy.id, dropped: [...dropped], reasoning, answered, failed, usage, others, lastError, stopped: stop ? String(stop.message).slice(0, 160) : null };
}

/**
 * Judge a sampled run against its reference (and name the likely model from the others).
 * @returns one evidence item `{ id: "dfa", outcome, level?, key, params, likely? }`.
 */
export function judgeDistribution({ ref, mismatch = false, run, refs = references().refs, seed = 1 }) {
  const params = { model: ref.model, host: ref.host ?? "", recorded: ref.recorded, answered: run.answered, requested: run.answered + run.failed, probes: PROBES.length };
  if (run.answered === 0) return { id: "dfa", outcome: "error", level: "info", key: "probe.requestFailed", params: { status: "-", error: run.lastError ?? run.stopped ?? "" } };
  if (run.stopped) return { id: "dfa", outcome: "na", level: "info", key: "probe.dfaStopped", params: { ...params, error: run.stopped } };
  // The reference sampled without reasoning; a site that thought anyway answers another distribution.
  if (ref.sampling.thinking === "off" && run.reasoning > run.answered * 0.1) return { id: "dfa", outcome: "na", level: "info", key: "probe.dfaThinking", params: { ...params, reasoning: run.reasoning } };
  const score = scoreDistribution(run.observed, ref, seed);
  const p = score.p ?? 1;
  const shown = p < 1e-4 ? p.toExponential(1) : p.toFixed(4);
  const base = { ...params, p: shown, informative: score.informative, differing: score.differing, failed: Math.round(score.errorRate * 100), worst: score.worst.join(", ") };
  const noteOf = () => {
    const notes = [];
    if (mismatch) notes.push({ zh: `参考指纹经 ${protocolName(ref.protocol)} 协议录制，本站点为其他协议`, en: `the reference was recorded over ${protocolName(ref.protocol)}, this site uses another protocol` });
    if (run.dropped.length) notes.push({ zh: `站点不接受 ${run.dropped.join("、")}，已省略`, en: `the site refused ${run.dropped.join(", ")}; left out` });
    if (!ref.official) notes.push({ zh: `参考来自${ref.host ? `「${ref.host}」` : "第三方托管"}，并非厂商官方 API`, en: `the reference comes from ${ref.host ?? "a third-party host"}, not the vendor's own API` });
    if (!notes.length) return null;
    return { zh: notes.map((note) => note.zh).join("；"), en: notes.map((note) => note.en).join("; ") };
  };
  const note = noteOf();
  if (p < FAIL_P && (!mismatch || p < MISMATCH_P)) {
    // The likely model: the reference closest to the answers, when it is another model and its own test passes.
    let likely = null;
    const others = refs.filter((other) => other.model !== ref.model && (other.protocol === ref.protocol || mismatch));
    const ranked = rankReferences(run.observed, others);
    const best = ranked[0];
    if (best) {
      const check = scoreDistribution(run.observed, best.ref, seed, { maxReps: 4_000, extendReps: 0 });
      if ((check.p ?? 0) >= WARN_P) likely = best.ref.model;
    }
    const hard = ref.official && !mismatch && run.dropped.length === 0 && score.errorRate <= MAX_ERROR_RATE && score.differing >= Math.max(HARD_MIN, Math.ceil(HARD_SHARE * score.informative));
    return { id: "dfa", outcome: "fail", level: hard ? "hard" : "soft", key: likely ? "probe.dfaDiffLikely" : "probe.dfaDiff", params: { ...base, likely: likely ?? "" }, note, ...(likely ? { likely } : {}) };
  }
  if (p < WARN_P || (mismatch && p < FAIL_P)) return { id: "dfa", outcome: "fail", level: "info", key: "probe.dfaMild", params: base, note };
  if (score.informative < MIN_INFORMATIVE || score.errorRate > AGREE_ERROR_RATE) return { id: "dfa", outcome: "na", level: "info", key: "probe.dfaWeak", params: { ...base, need: MIN_INFORMATIVE }, note };
  return { id: "dfa", outcome: "pass", key: "probe.dfaSame", params: base, note };
}

const protocolName = (protocol) => (protocol === "messages" ? "Anthropic Messages" : protocol === "responses" ? "OpenAI Responses" : "OpenAI Chat Completions");

/**
 * The distribution fingerprint check, whole: sample, then judge.
 * @returns `{ kind: "distribution", at, items, usage, metered: true, ref, strategy }`; a refused key gives an error item.
 */
export async function distributionCheck({ ref, mismatch = false, endpoint, model, key, samples = DEFAULT_SAMPLES, fetchImpl = fetch, signal, meter, busy, onStep, sleep, now = () => Date.now(), refs, seed, concurrency, pace }) {
  let run;
  try {
    run = await sampleDistribution({ ref, endpoint, model, key, samples, fetchImpl, signal, meter, busy, onStep, sleep, ...(concurrency ? { concurrency } : {}), ...(pace !== undefined ? { pace } : {}) });
  } catch (error) {
    if (!(error instanceof KeyRefused)) throw error;
    return { kind: "distribution", at: now(), items: [{ id: "dfa", outcome: "error", level: "info", key: error.status === 402 ? "probe.noFunds" : "probe.dfaKeyRefused", params: { status: error.status } }], usage: { requests: 0, input: 0, output: 0 }, metered: true, ref: ref.id };
  }
  const item = judgeDistribution({ ref, mismatch, run, ...(refs ? { refs } : {}), seed: seed ?? hash32(`${ref.id}:${now()}`) });
  return { kind: "distribution", at: now(), items: [item], usage: run.usage, metered: true, ref: ref.id, strategy: run.strategy, samples, ...(Object.keys(run.others).length ? { others: run.others } : {}) };
}
