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

/** What a model with no description is taken to be (DSH's own defaults for a custom route). */
export const DEFAULT_CONTEXT = 131_072;
export const DEFAULT_OUTPUT = 32_768;

/** A model the user did not add (or a reference-only description), from what the reference knows. */
export function fallbackModel(id) {
  const reference = referenceOf(id);
  return {
    id,
    name: reference?.name ?? id,
    context: reference?.context ?? DEFAULT_CONTEXT,
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
    context: model.context ?? base.context,
    output: model.output ?? base.output,
    image: model.image === true || (model.image === undefined && base.image),
    reasoning: model.reasoning === false ? null : model.reasoning === undefined ? base.reasoning : model.reasoning,
    flags: { ...base.flags, ...model.flags },
  };
}

/** A site's model by id: the added one, else a fallback. */
export function findModel(site, modelId) {
  const own = site?.models?.find((model) => model.id === modelId);
  return own ? completeModel(own) : fallbackModel(modelId);
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
    ...(entry.output ? { defaultMaxTokens: Math.min(entry.output, 131072) } : {}),
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
