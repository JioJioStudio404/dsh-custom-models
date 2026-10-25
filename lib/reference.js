/**
 * What the plugin knows about a model by its id alone — its context, output
 * limit, image input, reasoning levels and wire quirks — from pi-ai's
 * catalogs of every vendor (see `scripts/gen-reference.mjs`). A site's model
 * list usually gives only ids; the same model under another spelling
 * (`MiniMax-M3` / `minimax-m3`, `claude-sonnet-5-5` / `anthropic/claude-sonnet-5.5`,
 * `glm-5.3:free`) finds the same entry. Prices are left out on purpose: a
 * relay's prices are its own.
 *
 * @module dsh-custom-models/reference
 */
import { REFERENCE } from "./reference-data.js";

/**
 * The lookup key of a model id: lowercase, without its vendor path or a
 * free-variant suffix, with `5-5` spelled `5.5` (applied alike to the
 * catalog's ids, so both spellings meet).
 */
export function modelKey(id) {
  let value = String(id ?? "").trim().toLowerCase();
  value = value.split("/").at(-1);
  value = value.replace(/^~/, "").replace(/_/g, "-").replace(/(:free|-free)$/, "");
  return value.replace(/(\d)-(\d)(?!\d)/g, "$1.$2");
}

/** A relay's level suffix (`gemini-3.8-flash-high`): the same model at a fixed effort. */
const LEVEL_SUFFIX = /-(minimal|low|medium|high|xhigh|max|thinking|nothinking|no-thinking)$/;

/** The reference entry of a model id (a relay's level suffix aside), or undefined. */
export function referenceOf(id) {
  const key = modelKey(id);
  return REFERENCE[key] ?? (LEVEL_SUFFIX.test(key) ? REFERENCE[key.replace(LEVEL_SUFFIX, "")] : undefined);
}
