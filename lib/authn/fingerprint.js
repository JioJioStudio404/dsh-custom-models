/**
 * Knowledge fingerprints ("知识指纹", after KBF — github.com/Ooo0ption/KBF, Apache-2.0). A model's answers to
 * long-tail numeric questions at the edge of what it knows (the boiling point of an obscure compound, a drug's
 * half-life, the year a programming event happened) are wrong in its own way. A probe set holds a reference model's
 * answers and how often that model disagrees with itself; a site's model answering the same questions with
 * significantly more differences (a one-sided binomial test against the reference's self-test, bounded by
 * Clopper-Pearson) is another model, even a sibling tier. Live 2026-11-09: DeepSeek V4.1 Flash against V4 Pro's set and
 * GPT-6 Luna against Astra's were told apart; every model against its own set matched.
 *
 * Sets are data. The rule pack lists them (path, SHA-256, size) in the KBF repository at a pinned commit; one is
 * downloaded when first needed (GitHub, then jsDelivr), checked against its hash and kept in
 * `$DSH_HOME/storages/custom-models-fingerprints/`. Sets the KBF authors publish later are found upstream (GitHub's
 * API): they carry no hash from the pack, are used only when the user allows it, and their verdicts are never
 * conclusive.
 *
 * A run is long (20–40 requests), so it is a background job: one request at a time with a pause, waiting while the
 * user's own requests use the site, backing off on rate limits (Retry-After honoured), stopping at a refused key, its
 * progress kept (a restart resumes it), each request metered as it goes.
 *
 * @module dsh-custom-models/authn/fingerprint
 */
import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../errors.js";
import { requestHeaders } from "../gateway.js";
import { storagePath } from "../paths.js";
import { ask } from "./probes.js";

export const fingerprintDir = (env) => storagePath("custom-models-fingerprints", env);
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_SET_BYTES = 2_000_000;
/** A pause between two requests of a run (a relay that sees a burst may take it for abuse; live 2026-11-09). */
export const PACE_MS = 1_000;
/** While the user's own requests use the site, the run waits (checked this often, at most this long per request). */
const BUSY_POLL_MS = 2_000;
const BUSY_MAX_MS = 300_000;
const RETRIES = 4;
const RETRY_CAP_MS = 60_000;
const RETRYABLE = new Set([0, 408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

// ------------------------------------------------------------------ sets

/**
 * A downloaded set, checked and reduced to what a run needs: `{ model, date, self: { hamming, total }, probes: [{ name,
 * value, domain }] }`. Throws a TypeError naming the first problem.
 */
export function readSet(text, domains) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TypeError("the set is no JSON");
  }
  if (!raw || typeof raw !== "object" || typeof raw.reference_model !== "string" || raw.reference_model.length > 120) throw new TypeError("the set names no reference model");
  if (!Array.isArray(raw.probes) || raw.probes.length < 10 || raw.probes.length > 5000) throw new TypeError("the set holds no probes");
  const probes = raw.probes.map((probe, index) => {
    if (!probe || typeof probe.name !== "string" || probe.name.length === 0 || probe.name.length > 200) throw new TypeError(`probe ${index}: no name`);
    if (!domains[probe.domain]) throw new TypeError(`probe ${index}: unknown domain ${String(probe.domain).slice(0, 40)}`);
    const value = probe.value === null ? null : Number(probe.value);
    if (value !== null && !Number.isFinite(value)) throw new TypeError(`probe ${index}: no value`);
    return { name: probe.name, value, domain: probe.domain };
  });
  const short = raw.reference_model.split("/").at(-1);
  const self = raw.target_results?.[short];
  if (!self || !Number.isInteger(self.hamming) || !Number.isInteger(self.total) || self.total <= 0 || self.hamming < 0 || self.hamming > self.total) throw new TypeError("the set has no self-test");
  return { model: raw.reference_model, date: String(raw.timestamp ?? "").slice(0, 10), self: { hamming: self.hamming, total: self.total }, probes };
}

/** Where a file of the KBF repository is: GitHub, then jsDelivr (both at a commit, so the content is fixed). */
export const setUrls = (repo, commit, path) => [`https://raw.githubusercontent.com/${repo}/${commit}/${path}`, `https://cdn.jsdelivr.net/gh/${repo}@${commit}/${path}`];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileName = (entry) => `${entry.id}.json`;

/**
 * Probe sets: downloaded on first use, checked, kept; and the sets the KBF repository holds that the rule pack does
 * not list yet (upstream).
 */
export class FingerprintLibrary {
  #dir;
  #fs;
  #fetch;
  #log;
  #now;
  /** @param {object} [options] - `dir`, `fs`, `fetchImpl`, `log`, `now`. */
  constructor({ dir = fingerprintDir(), fs = defaultFs, fetchImpl = fetch, log = () => {}, now = () => Date.now() } = {}) {
    this.#dir = dir;
    this.#fs = fs;
    this.#fetch = fetchImpl;
    this.#log = log;
    this.#now = now;
  }

  async #download(urls, { maxBytes = MAX_SET_BYTES } = {}) {
    let last;
    for (const url of urls) {
      try {
        const response = await this.#fetch(url, { headers: requestHeaders({}), signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) {
          last = `HTTP ${response.status}`;
          continue;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) {
          last = "too large";
          continue;
        }
        return bytes;
      } catch (error) {
        last = redact(String(error?.message ?? error)).slice(0, 120);
      }
    }
    throw new Error(`download failed (${last ?? "no source"})`);
  }

  /**
   * One set, ready for a run: from the disk when kept, else downloaded. A set the pack lists must match its SHA-256;
   * an upstream one (`entry.upstream`) is checked for its form only.
   */
  async load(pack, entry) {
    const fp = pack.fingerprint;
    const file = join(this.#dir, fileName(entry));
    try {
      const kept = JSON.parse(await this.#fs.readFile(file, "utf8"));
      if (kept?.sha256 === (entry.sha256 ?? kept.sha256) && Array.isArray(kept.probes)) return kept;
    } catch {
      /* not kept yet */
    }
    const bytes = await this.#download(setUrls(entry.repo ?? fp.source.repo, entry.commit ?? fp.source.commit, entry.path));
    const hash = sha256(bytes);
    if (entry.sha256 && hash !== entry.sha256) throw new Error("the downloaded set does not match the rule pack's SHA-256");
    const data = { ...readSet(bytes.toString("utf8"), fp.domains), id: entry.id, sha256: hash, path: entry.path, upstream: entry.upstream === true };
    await this.#fs.mkdir(this.#dir, { recursive: true });
    await this.#fs.writeFile(file, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    this.#log("info", `fingerprint set ${entry.id} downloaded (${bytes.length} bytes)`);
    return data;
  }

  /**
   * The sets the KBF repository holds now (its default branch) that the pack does not list: `{ checkedAt, commit,
   * sets: [{ id, path, name, date, bytes, match }] }`. Three small requests to GitHub's API.
   */
  async discover(pack) {
    const fp = pack.fingerprint;
    if (!fp) return { checkedAt: this.#now(), commit: null, sets: [] };
    const api = async (path) => {
      const response = await this.#fetch(`https://api.github.com/repos/${fp.source.repo}/${path}`, { headers: { ...requestHeaders({}), accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      return response.json();
    };
    const head = await api("commits/HEAD");
    const commit = typeof head?.sha === "string" && /^[0-9a-f]{40}$/.test(head.sha) ? head.sha : null;
    if (!commit) throw new Error("GitHub gave no commit");
    const top = await api(`contents/probes?ref=${commit}`);
    const dirs = (Array.isArray(top) ? top : []).filter((item) => item?.type === "dir" && /^reference[A-Za-z0-9_-]*$/.test(item.name ?? "")).map((item) => item.name).sort().reverse().slice(0, 3);
    const known = new Set(fp.sets.map((set) => set.path));
    const knownBases = new Set(fp.sets.map((set) => baseOf(set.path)));
    const sets = [];
    for (const dir of dirs) {
      const files = await api(`contents/probes/${dir}?ref=${commit}`);
      for (const item of Array.isArray(files) ? files : []) {
        const path = `probes/${dir}/${item?.name ?? ""}`;
        const parsed = /^([a-z0-9][a-z0-9._-]{0,80})_(\d{8})\.json$/i.exec(item?.name ?? "");
        if (item?.type !== "file" || !parsed || known.has(path) || !(item.size > 0 && item.size <= MAX_SET_BYTES)) continue;
        const base = parsed[1].toLowerCase();
        // A newer set for a model the pack already serves is listed too: its date tells.
        sets.push({ id: `${base.replace(/[^a-z0-9]+/g, "-")}-${parsed[2]}`.slice(0, 48).replace(/-+$/, ""), path, name: base, date: `${parsed[2].slice(0, 4)}-${parsed[2].slice(4, 6)}-${parsed[2].slice(6)}`, bytes: item.size, match: matchFor(base), newerOf: knownBases.has(base) ? base : null });
      }
    }
    return { checkedAt: this.#now(), commit, sets };
  }
}
const baseOf = (path) => (/([^/]+)_\d{8}\.json$/.exec(path)?.[1] ?? "").toLowerCase();

/**
 * Which claimed model ids an upstream set serves, from its file name ("claude-opus-5.5" → claude[-_.]?opus[-_.]?5[-_.]?5,
 * ending there): parts joined by any separator, a provider prefix and a date or tag suffix allowed.
 */
export function matchFor(base) {
  const parts = base.toLowerCase().split(/[-_.]+/).filter(Boolean).map((part) => part.replace(/[^a-z0-9]/g, ""));
  return `${parts.join("[-_.]?")}($|[@:]|-20)`;
}

// ------------------------------------------------------------------ the run

/** The probes a run asks: every `sample`-th, in batches of `batchSize` per domain (domains in name order). */
export function planRun(fp, data) {
  const chosen = data.probes.map((probe, index) => ({ ...probe, index })).filter((_, index) => index % fp.sample === 0);
  const byDomain = new Map();
  chosen.forEach((probe, position) => (byDomain.get(probe.domain) ?? byDomain.set(probe.domain, []).get(probe.domain)).push({ ...probe, position }));
  const batches = [];
  for (const domain of [...byDomain.keys()].sort()) {
    const items = byDomain.get(domain);
    for (let start = 0; start < items.length; start += fp.batchSize) batches.push({ domain, items: items.slice(start, start + fp.batchSize) });
  }
  return { chosen, batches };
}

/** The numbers an answer gives, by their (N) prefix (else line by line), within the domain's range; null where none. */
export function extractNumbers(text, count, [low, high]) {
  const out = new Array(count).fill(null);
  const clean = String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const within = (value) => (Number.isFinite(value) && value >= low && value <= high ? value : null);
  let prefixed = false;
  for (let line of clean.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("---") || line.startsWith("|")) continue;
    const m = /^\((\d+)\)\s*/.exec(line) ?? /^(\d+)[.)]\s+/.exec(line);
    if (!m) continue;
    prefixed = true;
    const index = Number(m[1]) - 1;
    if (index < 0 || index >= count) continue;
    const nums = line.slice(m[0].length).replace(/−|–/g, "-").replace(/,/g, "").match(/-?\d+\.?\d*(?:[eE][+-]?\d+)?/g);
    out[index] = nums ? within(Number(nums.at(-1))) : null;
  }
  if (prefixed) return out;
  const sequence = clean.split("\n").map((line) => line.replace(/,/g, "").match(/-?\d+\.?\d*(?:[eE][+-]?\d+)?/g)?.at(-1)).filter(Boolean).map(Number);
  return out.map((_, index) => (index < sequence.length ? within(sequence[index]) : null));
}

const halfUp = (value) => (value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5));
/** Whether a value matches the reference's within the domain's tolerance (absolute ones compared as whole numbers). */
export function sameValue(reference, value, domain) {
  if (reference === null || reference === undefined || value === null || value === undefined) return false;
  if (domain.mode === "absolute") return Math.abs(halfUp(reference) - halfUp(value)) <= domain.tolerance;
  return Math.abs(reference - value) / Math.max(Math.abs(reference), 1e-10) <= domain.tolerance;
}

// Binomial tails in log space (exact enough for a few thousand trials).
function logGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i += 1) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const logPmf = (k, n, p) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log1p(-p);
function cdf(k, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let sum = 0;
  for (let i = 0; i <= k; i += 1) sum += Math.exp(logPmf(i, n, p));
  return Math.min(1, sum);
}
/** Clopper-Pearson upper bound of a rate from `k` of `n` at `confidence`. */
export function upperBound(k, n, confidence) {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  let low = k / n;
  let high = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    if (cdf(k, n, mid) > 1 - confidence) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
/** P(X ≥ k) for X ~ Binomial(n, p). */
export const binomialTail = (k, n, p) => (n === 0 || k === 0 ? 1 : Math.max(0, 1 - cdf(k - 1, n, Math.min(p, 0.99))));

/** A run's answers scored against the set: `{ verdict: same | diff | undetermined, total, hamming, p0, p, coverage }`. */
export function scoreRun(fp, data, chosen, values) {
  let total = 0;
  let hamming = 0;
  chosen.forEach((probe, position) => {
    const value = values[position];
    if (probe.value === null || value === null || value === undefined) return;
    total += 1;
    if (!sameValue(probe.value, value, fp.domains[probe.domain])) hamming += 1;
  });
  const p0 = upperBound(data.self.hamming, data.self.total, fp.confidence);
  const p = binomialTail(hamming, total, p0);
  const coverage = chosen.length ? total / chosen.length : 0;
  const verdict = coverage < fp.minCoverage ? "undetermined" : p < fp.alpha ? "diff" : "same";
  return { verdict, total, hamming, p0, p, coverage };
}

/** How a site is asked not to think (tried in order; KBF's list), per protocol. */
const STRATEGIES = {
  chat: ["reasoning_none", "reasoning_minimal", "thinking_disabled", "enable_thinking_false", "bare"],
  responses: ["reasoning_none", "reasoning_minimal", "bare"],
  messages: ["thinking_disabled", "effort_low"],
};
function strategyBody(strategy, protocol) {
  if (strategy === "reasoning_none") return { body: protocol === "chat" ? { reasoning: { effort: "none" } } : { reasoning: { effort: "none" } } };
  if (strategy === "reasoning_minimal") return { body: { reasoning: { effort: "minimal" } } };
  if (strategy === "thinking_disabled") return { body: { thinking: { type: "disabled" } } };
  if (strategy === "enable_thinking_false") return { body: { enable_thinking: false } };
  // A model that always thinks (Claude Opus 5.5): little thinking, room for it.
  if (strategy === "effort_low") return { body: { output_config: { effort: "low" } }, extraTokens: 4_000 };
  if (strategy === "expanded") return { body: {}, factor: 10 };
  return { body: {} };
}

/** A key the site refused: the run stops (another try would only be refused again). */
export class KeyRefused extends Error {
  constructor(status, detail) {
    super(`key refused (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Run a knowledge fingerprint in the background.
 * @param {object} input
 *   - `pack`, `entry` (the set's pack entry, or an upstream one with `upstream: true`), `data` (the loaded set),
 *     `endpoint`, `model` (effective), `key`, `fetchImpl`, `signal`;
 *   - `state` (a saved job to resume, or null), `save(job)` (after each request), `meter({ requests, input, output })`
 *     (each request, as it is spent), `busy()` (the user's own requests use the site now), `onStep(step, steps)`;
 *   - `sleep(ms)`, `now()`.
 * @returns `{ kind: "fingerprint", at, items, usage, metered: true, set, upstream }`; throws a KeyRefused when the site
 *   refuses the key (the job is then over).
 */
export async function fingerprintCheck({ pack, entry, data, endpoint, model, key, fetchImpl = fetch, signal, state = null, save = async () => {}, meter = () => {}, busy = () => false, onStep = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const fp = pack.fingerprint;
  const protocol = model.protocol ?? endpoint.protocol ?? "chat";
  const { chosen, batches } = planRun(fp, data);
  const job = state && state.set === entry.id && Array.isArray(state.values) && state.values.length === chosen.length
    ? { ...state, usage: { requests: 0, input: 0, output: 0, ...(state.usage ?? {}) } }
    : { kind: "fingerprint", set: entry.id, values: new Array(chosen.length).fill(null), next: 0, strategy: null, temperature: true, usage: { requests: 0, input: 0, output: 0 }, startedAt: now() };
  const steps = () => batches.length + (job.strategy ? 0 : 1);
  onStep(job.next, steps());

  const waitTurn = async () => {
    let waited = 0;
    while (busy() && waited < BUSY_MAX_MS) {
      if (signal?.aborted) return;
      await sleep(BUSY_POLL_MS);
      waited += BUSY_POLL_MS;
    }
    await sleep(PACE_MS);
  };
  /** One request with retries: rate limits and passing failures wait (Retry-After honoured), a refused key stops. */
  const request = async (batch, strategy) => {
    const domain = fp.domains[batch.domain];
    const sentences = batch.items.map((probe, index) => `(${index + 1}) ${domain.template.replace("{name}", probe.name)}`).join("\n");
    const { body, extraTokens = 0, factor = 1 } = strategyBody(strategy, protocol);
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      await waitTurn();
      const result = await ask({ endpoint, model, key, fetchImpl, signal, system: fp.prompt.system, prompt: fp.prompt.user.replace("{sentences}", sentences), maxTokens: 80 * batch.items.length * factor + extraTokens, ...(job.temperature ? { temperature: 0 } : {}), extra: body });
      // Metered when answered (a refused request — a rate limit, a passing failure — is not billed).
      if (result.ok) {
        const spent = { requests: 1, input: result.usage?.input ?? 0, output: result.usage?.output ?? 0 };
        job.usage = { requests: job.usage.requests + 1, input: job.usage.input + spent.input, output: job.usage.output + spent.output };
        meter(spent);
      }
      if (result.ok) return { values: extractNumbers(result.text, batch.items.length, domain.range), reasoning: (result.usage?.reasoning ?? 0) > 0 || (result.thinking ?? []).some((block) => String(block?.thinking ?? "").length > 0) };
      if (result.status === 401 || result.status === 403) throw new KeyRefused(result.status, String(result.error ?? "").slice(0, 160));
      if (result.status === 400 && job.temperature && /temperature/i.test(String(result.error ?? ""))) {
        // Claude 4.7 and later take no temperature: the default it is (once for the whole run).
        job.temperature = false;
        continue;
      }
      if (!RETRYABLE.has(result.status) || attempt >= RETRIES) return { values: null, status: result.status, error: String(result.error ?? "").slice(0, 160) };
      const after = Number(result.headers?.get?.("retry-after"));
      await sleep(Math.min(RETRY_CAP_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 5_000 * 2 ** attempt));
    }
  };
  const keep = (batch, values) => batch.items.forEach((probe, index) => (job.values[probe.position] = values?.[index] ?? null));

  // The first batch also finds how this site is asked not to think (kept for a resumed run).
  if (!job.strategy && batches.length) {
    const candidates = STRATEGIES[protocol] ?? STRATEGIES.chat;
    let chosenStrategy = null;
    let first = null;
    for (const candidate of candidates) {
      const answer = await request(batches[0], candidate);
      if (!answer.values) {
        // Refused (a field the site does not take): the next way.
        if (answer.status === 400 || answer.status === 422) continue;
        first = answer;
        break;
      }
      const valid = answer.values.filter((value) => value !== null).length;
      if (valid >= batches[0].items.length / 2 && !answer.reasoning) {
        chosenStrategy = candidate;
        first = answer;
        break;
      }
    }
    job.strategy = chosenStrategy ?? (protocol === "messages" ? "effort_low" : "expanded");
    if (!chosenStrategy && !first?.values) first = await request(batches[0], job.strategy);
    keep(batches[0], first?.values);
    job.next = 1;
    onStep(job.next, steps());
    await save(job);
  }
  for (let index = job.next; index < batches.length; index += 1) {
    const answer = await request(batches[index], job.strategy);
    keep(batches[index], answer.values);
    job.next = index + 1;
    onStep(job.next, steps());
    await save(job);
  }

  const score = scoreRun(fp, data, chosen, job.values);
  const percent = (value) => (value * 100).toFixed(1);
  const params = { set: entry.name, date: entry.date, mismatch: percent(score.total ? score.hamming / score.total : 0), self: percent(data.self.hamming / data.self.total), p: score.p < 0.001 ? score.p.toExponential(1) : score.p.toFixed(3), answered: score.total, asked: chosen.length };
  const upstream = entry.upstream === true;
  const note = upstream ? { zh: "上游新题库，未经规则库核对", en: "an upstream set the rule pack has not checked" } : null;
  let item;
  if (score.verdict === "same") item = { id: "kbf", outcome: "pass", key: "probe.kbfSame", params, note };
  else if (score.verdict === "undetermined") item = { id: "kbf", outcome: "na", level: "info", key: "probe.kbfUndetermined", params, note };
  else {
    // Conclusive only from a set the pack checked, far past the reference's own disagreement.
    const selfRate = data.self.hamming / data.self.total;
    const strong = !upstream && score.p < 1e-6 && score.hamming / score.total >= 3 * selfRate;
    item = { id: "kbf", outcome: "fail", level: strong ? "hard" : "soft", key: "probe.kbfDiff", params, note };
  }
  return { kind: "fingerprint", at: now(), items: [item], usage: job.usage, metered: true, set: entry.id, upstream, strategy: job.strategy };
}
