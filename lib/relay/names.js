/**
 * Whether two model names name the same model — a relay's log may name the upstream model in its vendor's
 * spelling: "claude-sonnet-4-5" served as "claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4.5",
 * "us.anthropic.claude-sonnet-4-5-v1:0" or "claude-sonnet-4-5@20250929" is the same model; "gpt-5" served as
 * "gpt-5-mini", or "claude-opus-5-5" as "claude-sonnet-5-5", is another.
 *
 * @module dsh-custom-models/relay/names
 */

/** Words that name a model's size or tier: two names that differ in one name different models. */
const TIER_WORDS = new Set(["opus", "sonnet", "haiku", "fable", "mythos", "mini", "nano", "micro", "pico", "small", "medium", "large", "lite", "flash", "pro", "max", "ultra", "plus", "turbo", "air", "x", "instant", "fast", "coder", "codex", "vl", "omni", "reasoner"]);
/** Words that only say how a model is served (a variant of the same model). */
const VARIANT_WORDS = new Set(["chat", "instruct", "it", "preview", "latest", "exp", "experimental", "thinking", "think", "online", "search", "free", "beta", "stable", "hf", "fp8", "fp16", "bf16", "int4", "int8", "awq", "gguf", "high", "low", "none", "minimal"]);

/** A name reduced to its model: lower case, no vendor prefix or region, no date, no Bedrock / Vertex suffix. */
export function normalizeModelName(name) {
  let value = String(name ?? "").trim().toLowerCase();
  value = value.replace(/^[a-z0-9_.-]+\//, "");
  value = value.replace(/^(us|eu|apac|global|jp|au)\.(anthropic|meta|amazon|mistral|deepseek|qwen|openai)\./, "").replace(/^(anthropic|openai|google|meta|amazon|mistral|deepseek|qwen|xai|moonshotai|zai)\./, "");
  value = value.replace(/@.*$/, "").replace(/-v\d+:\d+$/, "").replace(/:.*$/, "");
  value = value.replace(/[-_.](\d{8}|\d{4}-\d{2}-\d{2}|\d{6}|\d{4})$/, "");
  value = value.replace(/[._\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return value;
}

const tokensOf = (normalized) => normalized.split("-").filter(Boolean);
/** The version numbers in a name, joined ("claude-opus-4-6" → "4.6", "gpt-5-mini" → "5", "deepseek-v4" → "4"). */
const numbersOf = (tokens) => tokens.filter((token) => /^v?\d+(\.\d+)?[a-z]?$/.test(token)).map((token) => token.replace(/^v/, "")).join(".");

const RANK = { same: 0, variant: 1, different: 2 };

/** A name's readings around a colon: a channel prefix ("cn:deepseek-v4.1-flash") or a tag suffix ("glm-4.6:free"). */
function readingsOf(name) {
  const value = String(name ?? "").trim().replace(/-v\d+:\d+$/i, "");
  const colon = value.indexOf(":");
  if (colon < 0) return [value];
  return [value.slice(colon + 1), value.slice(0, value.lastIndexOf(":"))].filter(Boolean);
}

/**
 * How the model a relay served compares with the one asked for: `same` (another spelling of it), `variant`
 * (the same model and size, served another way — a thinking or preview variant), or `different` — the closest of
 * the names' readings (live 2026-11-10: a new-api site mapped "deepseek-v4.1-flash" to "cn:deepseek-v4.1-flash").
 */
export function compareModelNames(requested, served) {
  let best = "different";
  for (const a of readingsOf(requested)) {
    for (const b of readingsOf(served)) {
      const relation = compareReadings(a, b);
      if (RANK[relation] < RANK[best]) best = relation;
    }
  }
  return best;
}

function compareReadings(requested, served) {
  const a = normalizeModelName(requested);
  const b = normalizeModelName(served);
  if (!a || !b) return "same";
  if (a === b) return "same";
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  const tiers = (tokens) => tokens.filter((token) => TIER_WORDS.has(token)).sort().join(" ");
  if (tiers(ta) !== tiers(tb)) return "different";
  const core = (tokens) => tokens.filter((token) => !VARIANT_WORDS.has(token) && !TIER_WORDS.has(token) && !/^v?\d/.test(token));
  // A name without a version ("deepseek-chat") is an alias the site resolves to its current version.
  if (!numbersOf(ta) && numbersOf(tb)) return core(ta).every((token) => core(tb).includes(token)) ? "variant" : "different";
  if (numbersOf(ta) !== numbersOf(tb)) return "different";
  return core(ta).sort().join(" ") === core(tb).sort().join(" ") ? "variant" : "different";
}
