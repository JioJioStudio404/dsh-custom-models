/**
 * Thinking-signature checks for Claude on the Anthropic Messages protocol.
 *
 * Anthropic's documentation: a thinking block's `signature` is its thinking,
 * encrypted; the API checks it when the block is sent back, and a tampered or
 * undecryptable signature always gets a 400 ("Invalid `signature` in
 * `thinking` block"); signatures work across platforms (Claude API, Bedrock,
 * Google Cloud) — a block another account's model cannot read is dropped
 * without an error, a forged one never passes.
 *
 * So, without any official key:
 *  1. ask one of the pack's questions with thinking on, and keep the block;
 *  2. send it back tampered: a backend that checks signatures refuses it;
 *  3. send it back as it was: it must pass;
 *  4. (cross-site) send this site's block, as it was, to another site whose
 *     backend was seen checking signatures: a forged signature is refused
 *     there (不符), a real one passes (签名已验证).
 * Only blocks these checks made travel; a conversation's own thinking never
 * does (another site's model could read it).
 *
 * Outcomes: `checked` (this site's backend checks signatures), `verified`
 * (this site's signature passed another site's check), `forged`,
 * `unverifiable` (no thinking, the signature stripped, or tampered blocks
 * pass: nothing is checked behind this site).
 *
 * @module dsh-custom-models/authn/signature
 */
import { ask, phrase } from "./probes.js";
import { matchSignals } from "./rules.js";

const INVALID_SIGNATURE = /signature/i;
/** Anthropic's words for a tampered or undecryptable signature, and for a real block bound elsewhere (no forgery). */
const FORGED_WORDS = /invalid `?signature`? in `?thinking`? block/i;
const BOUND_WORDS = /bound|conversation|organi[sz]ation|account|prefix|another model|cannot read/i;

/** The same signature with a few characters in the middle changed (still well-formed base64). */
export function tamper(signature) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const at = Math.floor(signature.length / 2);
  const swap = (char) => alphabet[(Math.max(0, alphabet.indexOf(char)) + 17) % alphabet.length];
  return signature.slice(0, at) + swap(signature[at]) + swap(signature[at + 1]) + swap(signature[at + 2]) + signature.slice(at + 3);
}

/**
 * The thinking settings to try: adaptive; adaptive at high effort (an adaptive model may skip thinking on an easy
 * question, live 2026-11-09 on claude-sonnet-5-5); a budget (models before 4.7).
 */
const THINKING = [{ thinking: { type: "adaptive" } }, { thinking: { type: "adaptive" }, effort: "high" }, { thinking: { type: "enabled", budget_tokens: 2048 } }];

/**
 * Get a signed thinking block from a site's model.
 * @returns `{ block, text, thinking, usage, error }` (`block` null when none came, `error` set when no request passed).
 */
export async function signedBlock({ pack, endpoint, model, key, fetchImpl, signal, track }) {
  const question = phrase(pack, "signature", "en").text;
  let last = null;
  let answered = null;
  for (const { thinking, effort } of THINKING) {
    const result = await ask({ endpoint, model, key, prompt: question, maxTokens: 4000, thinking, effort, fetchImpl, signal });
    track(result);
    if (!result.ok) {
      last = result;
      if (result.status === 400) continue;
      return { block: null, error: result };
    }
    const block = result.thinking.find((item) => item.type === "thinking");
    const text = result.blocks.filter((item) => item.type === "text");
    answered = { block: block ?? null, text, thinking, question, redacted: result.thinking.some((item) => item.type === "redacted_thinking") };
    if (block) return answered;
  }
  return answered ?? { block: null, error: last };
}

/** Send a block back as the assistant's turn, then one short question. */
function replay({ endpoint, model, key, fetchImpl, signal, question, thinking, block, text }) {
  const followUp = "Reply with exactly: OK";
  return ask({
    endpoint,
    model,
    key,
    // Above the 2,048-token budget a model before 4.7 takes (max_tokens must be greater than budget_tokens).
    maxTokens: 4096,
    thinking,
    fetchImpl,
    signal,
    messages: [
      { role: "user", content: question },
      { role: "assistant", content: [block, ...text] },
      { role: "user", content: followUp },
    ],
  });
}

/**
 * Run the signature check on one site's model.
 * @param {object} input - `pack`, `endpoint`, `model` (effective, Messages protocol), `key`, `peers` (other sites whose
 *   backend checks signatures: `[{ endpoint, model, key, name, thinking }]`), `fetchImpl`, `signal`, `onStep(step, steps)`, `now()`.
 * @returns `{ kind: "signature", at, items, usage, outcome }`.
 */
export async function signatureCheck({ pack, endpoint, model, key, peers = [], fetchImpl = fetch, signal, onStep = () => {}, now = () => Date.now() }) {
  const usage = { requests: 0, input: 0, output: 0 };
  // What the requests to other sites cost, per site (they count there, not here).
  const peerUsage = new Map();
  let currentPeer = null;
  // What this site's own answers show of its channel (not the peers').
  const signals = new Set();
  let peerPhase = false;
  const steps = 3 + Math.min(peers.length, 2);
  let step = 0;
  const track = (result) => {
    step += 1;
    onStep(step, Math.max(step, steps));
    const spent = currentPeer ? (peerUsage.get(currentPeer) ?? peerUsage.set(currentPeer, { requests: 0, input: 0, output: 0 }).get(currentPeer)) : usage;
    spent.requests += 1;
    if (result?.usage) {
      spent.input += result.usage.input;
      spent.output += result.usage.output;
    }
    if (result?.wire && !peerPhase) {
      const names = [];
      result.headers?.forEach?.((_, name) => names.push(name.toLowerCase()));
      for (const id of matchSignals(pack, { ...result.wire, headers: names }, "messages")) signals.add(id);
    }
  };
  const done = (outcome, items, extra = {}) => ({ kind: "signature", at: now(), outcome, items, usage, channel: [...signals], peerUsage: [...peerUsage].map(([peer, spent]) => ({ peer, ...spent })), ...extra });
  const base = { pack, endpoint, model, key, fetchImpl, signal, track };
  const got = await signedBlock(base);
  if (got.error) return done("error", [{ id: "ask", outcome: "error", level: "info", key: "probe.requestFailed", params: { status: got.error.status, error: String(got.error.error ?? "").slice(0, 160) } }]);
  if (!got.block) return done("unverifiable", [{ id: "thinking", outcome: "na", level: "info", key: got.redacted ? "sig.redacted" : "sig.noThinking", params: {} }]);
  if (!got.block.signature) return done("unverifiable", [{ id: "stripped", outcome: "na", level: "info", key: "sig.stripped", params: {} }]);
  const context = { endpoint, model, key, fetchImpl, signal, question: got.question, thinking: got.thinking, text: got.text };
  const tampered = await replay({ ...context, block: { ...got.block, signature: tamper(got.block.signature) } });
  track(tampered);
  const items = [];
  let backendChecks = false;
  if (!tampered.ok && tampered.status === 400 && INVALID_SIGNATURE.test(tampered.error ?? "")) {
    const untouched = await replay({ ...context, block: got.block });
    track(untouched);
    if (untouched.ok) {
      backendChecks = true;
      items.push({ id: "tamper", outcome: "pass", key: "sig.checked", params: {} });
    } else items.push({ id: "tamper", outcome: "na", level: "info", key: "sig.refusesAll", params: { status: untouched.status } });
  } else if (tampered.ok) items.push({ id: "tamper", outcome: "na", level: "info", key: "sig.notChecked", params: {} });
  else items.push({ id: "tamper", outcome: "error", level: "info", key: "probe.requestFailed", params: { status: tampered.status, error: String(tampered.error ?? "").slice(0, 160) } });

  // Cross-site: this site's untouched block to sites seen checking signatures.
  let outcome = backendChecks ? "checked" : "unverifiable";
  peerPhase = true;
  for (const peer of peers.slice(0, 2)) {
    currentPeer = peer;
    const result = await replay({ endpoint: peer.endpoint, model: peer.model, key: peer.key, fetchImpl, signal, question: got.question, thinking: peer.thinking ?? { type: "adaptive" }, block: got.block, text: got.text });
    track(result);
    if (result.ok) {
      outcome = "verified";
      items.push({ id: `peer-${peer.endpoint.id}`, outcome: "verified", key: "sig.verified", params: { peer: peer.name } });
      break;
    }
    // Forged only in Anthropic's words for an undecryptable signature; a real block bound to another account,
    // conversation or model is refused too, and proves nothing.
    if (result.status === 400 && FORGED_WORDS.test(result.error ?? "") && !BOUND_WORDS.test(result.error ?? "")) {
      outcome = "forged";
      items.push({ id: `peer-${peer.endpoint.id}`, outcome: "fail", level: "hard", key: "sig.forged", params: { peer: peer.name } });
      break;
    }
    if (result.status === 400 && INVALID_SIGNATURE.test(result.error ?? "")) {
      items.push({ id: `peer-${peer.endpoint.id}`, outcome: "na", level: "info", key: "sig.peerBound", params: { peer: peer.name } });
      continue;
    }
    items.push({ id: `peer-${peer.endpoint.id}`, outcome: "error", level: "info", key: "sig.peerFailed", params: { peer: peer.name, status: result.status } });
  }
  // The thinking setting that worked here: another site checking this one replays with it.
  return done(outcome, items, { thinking: got.thinking ?? null, validates: backendChecks });
}
