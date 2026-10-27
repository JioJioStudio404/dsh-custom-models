/**
 * A site's models as the harness sees them: the ones the user added (with
 * what the site and the reference told, and the user's edits), and a model id
 * outside that list (a session's model from before, an id typed by hand),
 * which still answers with what the reference knows. A switch group is one
 * model on the group route, served by its active member.
 *
 * @module dsh-custom-models/models
 */
import { defaultEffortOf, EFFORT_NAMES, effortsOf } from "./dialects.js";
import { isRecord } from "./errors.js";
import { referenceOf } from "./reference.js";
import { CONTEXT_ORIGINS } from "./store.js";

/**
 * DSH's own custom-route defaults (dsh-llm-pi-ai): the context a site's model
 * is taken to have when nothing better is known, and a model's output.
 */
export const SITE_DEFAULT_CONTEXT = 262_144;
export const DEFAULT_OUTPUT = 32_768;
/** The largest default output a model is given (its own figure may be higher). */
const MAX_DEFAULT_OUTPUT = 131_072;
/** Platforms whose model lists state each model's context: a stored figure there is the site's word. */
const LISTS_CONTEXT = new Set(["hyper", "openrouter", "vercel"]);

/** A model the user did not add (or a reference-only description), from what the reference knows. */
export function fallbackModel(id) {
  const reference = referenceOf(id);
  return {
    id,
    name: reference?.name ?? id,
    ...(reference?.context ? { context: reference.context } : {}),
    output: reference?.output ?? DEFAULT_OUTPUT,
    image: reference?.image === true,
    reasoning: reference?.reasoning ?? null,
    ...(reference?.flags ? { flags: { ...reference.flags } } : {}),
    source: reference ? "reference" : "manual",
  };
}

/** One added model, complete: its own fields, then the reference's, then the defaults. */
export function completeModel(model) {
  const base = fallbackModel(model.id);
  return {
    ...base,
    ...model,
    name: model.name ?? base.name,
    ...((model.context ?? base.context) ? { context: model.context ?? base.context } : {}),
    output: model.output ?? base.output,
    image: model.image === true || (model.image === undefined && base.image),
    reasoning: model.reasoning === false ? null : model.reasoning === undefined ? base.reasoning : model.reasoning,
    flags: { ...base.flags, ...model.flags },
  };
}

/**
 * Whose word a model's stored context is: the site's list (`site`), the
 * user's edit (`user`), the reference catalog (`reference`), or nobody's
 * (`none`). A model stored before 0.3.0 has no `contextFrom`: a figure equal
 * to the reference's is the reference's (unless the site's platform lists
 * contexts itself); another one is the user's edit or the site's word.
 */
export function contextOrigin(model, site) {
  if (!model?.context) return referenceOf(model?.id)?.context ? "reference" : "none";
  if (CONTEXT_ORIGINS.includes(model.contextFrom)) return model.contextFrom;
  const listsContext = LISTS_CONTEXT.has(site?.platform) && model.source === "site";
  if (referenceOf(model.id)?.context === model.context && !listsContext) return "reference";
  return model.source === "manual" ? "user" : "site";
}

/** The context a site's model is taken to have when neither it nor the user says: the site's own default, else DSH's. */
export const siteDefaultContext = (site) => site?.defaultContext ?? SITE_DEFAULT_CONTEXT;

/**
 * A model as requests and DSH see it on its site. The site's word and the
 * user's edit stand; a reference figure (catalogs list a model's own window,
 * which a relay in front of it often does not grant) is capped at the site's
 * default context, DSH's own default for a custom route. Without a
 * believable window DSH compacts too late, and the relay refuses first.
 * `contextListed` keeps the uncapped figure for the tab.
 */
export function effectiveModel(model, site) {
  const full = completeModel(model);
  const origin = contextOrigin(model, site);
  const cap = siteDefaultContext(site);
  const context = origin === "site" || origin === "user" ? full.context : Math.min(full.context ?? cap, cap);
  return { ...full, context, contextOrigin: origin, ...(full.context !== undefined && full.context !== context ? { contextListed: full.context } : {}) };
}

/** A site's model by id: the added one, else a fallback, as requests and DSH see it. */
export function findModel(site, modelId) {
  return effectiveModel(site?.models?.find((model) => model.id === modelId) ?? { id: modelId }, site);
}

/**
 * The output a request asks for by default: the model's own, at most
 * 131,072 and at most an eighth of its context. DSH compacts once a request
 * reaches min(80 % of the window, window − output − 65,536); a default output
 * near the window would leave no room, and DSH then never compacts.
 */
export function defaultMaxTokensOf(entry) {
  const output = entry.output ?? DEFAULT_OUTPUT;
  return entry.context ? Math.min(output, MAX_DEFAULT_OUTPUT, Math.max(4_096, Math.floor(entry.context / 8))) : Math.min(output, MAX_DEFAULT_OUTPUT);
}

/** Harness model info for one entry (`listModels` / `resolveModel`). */
export function toModelInfo(route, entry, { id = entry.id, name } = {}) {
  const efforts = effortsOf(entry);
  const defaultEffort = defaultEffortOf(entry);
  return {
    provider: route,
    id,
    name: name ?? entry.name ?? entry.id,
    inputModalities: entry.image ? ["text", "image"] : ["text"],
    ...(entry.context ? { context: { contextWindow: entry.context } } : {}),
    defaultMaxTokens: defaultMaxTokensOf(entry),
    ...(efforts.length
      ? { reasoning: { efforts: efforts.map((level) => ({ id: level, name: EFFORT_NAMES[level] ?? level })), ...(defaultEffort ? { defaultEffort } : {}) } }
      : {}),
  };
}

/**
 * What one request cost, from the model's prices (per million tokens, the
 * tier its input reaches) and the harness usage: USD, or a new-api relay's
 * own quota dollars (`unit: "quota"`, what its balance is counted in).
 * Undefined when the model has no price.
 */
export function estimateCost(entry, usage) {
  const cost = entry?.cost;
  if (!isRecord(cost) || !isRecord(usage) || (cost.unit && !["USD", "quota"].includes(cost.unit))) return undefined;
  const input = Number(usage.inputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const total = input + cacheRead + cacheWrite;
  let rates = cost;
  for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) if (total > tier.above && tier.above > (rates.above ?? -1)) rates = tier;
  return ((rates.input ?? 0) * input + (rates.output ?? 0) * output + (rates.cacheRead ?? 0) * cacheRead + (rates.cacheWrite ?? 0) * cacheWrite) / 1e6;
}

/** A switch group's id from its name ("GLM 5.3" → "glm-5-3"), unique among `taken`. */
export function suggestGroupId(name, taken = []) {
  const base = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "group";
  let id = /^[a-z0-9]/.test(base) ? base : `g-${base}`;
  const root = id;
  for (let n = 2; taken.includes(id); n += 1) id = `${root}-${n}`;
  return id;
}
