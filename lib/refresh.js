/**
 * Keeping the added models' descriptions up with the site's list.
 *
 * A model the user added keeps what "获取可用模型" said about it when it
 * was added. When the site's list says more later — or the plugin learns to
 * read more of it (0.3.2: a relay station's `metadata` limits) — the model is
 * described again from the list:
 *  - a model the user did not edit takes the new description whole;
 *  - an edited one (`source: "manual"`) keeps every edit, and takes the
 *    site's window only while the user never set one;
 *  - a model the list no longer names stays as it is (removing is the user's call).
 *
 * Runs on "获取可用模型" for a saved site, and once in the background per
 * site after the plugin's way of describing models changed
 * ({@link DESCRIBE_VERSION}): a free read of the model list, never a request.
 *
 * @module dsh-custom-models/refresh
 */
import { discover } from "./discovery.js";
import { endpointById } from "./endpoints.js";
import { isRecord } from "./errors.js";

/**
 * The plugin's way of describing a model from its site's list. A site read
 * with an older one is read again once. 2: 0.3.2 (a relay station's limits, its
 * "off" spelling, a suggested window).
 */
export const DESCRIBE_VERSION = 2;

/** A stored model, described again from the site's fresh description of it (`fresh`, as discovery gives it). */
export function redescribe(stored, fresh) {
  if (!fresh) return stored;
  const { added: _added, known: _known, key: _key, ...listed } = fresh;
  // What the plugin learned of the model and the user's price outlive a new description.
  const learned = {
    ...(stored.price ? { price: stored.price } : {}),
    ...(typeof stored.usageReported === "boolean" ? { usageReported: stored.usageReported } : {}),
    ...(stored.contextProbe ? { contextProbe: stored.contextProbe } : {}),
    // A window the site showed stands until its list states one.
    ...(stored.contextFrom === "measured" && listed.contextFrom !== "site" ? { context: stored.context, contextFrom: "measured", contextMeasured: stored.contextMeasured } : {}),
  };
  if (stored.source !== "manual") {
    // Nothing describes it any more (neither the list nor the reference): what was known stays.
    if (listed.source === "manual") return stored;
    // The protocol a model was given by hand cannot be told from a non-manual one; a stored one stays.
    return { ...listed, ...(stored.protocol && !listed.protocol ? { protocol: stored.protocol } : {}), ...learned };
  }
  if (stored.contextFrom === "user" || listed.contextFrom !== "site" || !listed.context) return stored;
  const next = { ...stored, context: listed.context, contextFrom: "site" };
  if (listed.contextSuggested) next.contextSuggested = listed.contextSuggested;
  else delete next.contextSuggested;
  return next;
}

/** What a site's list said of itself, as the site keeps it (its platform decides how balances are read). */
export const detectedPatch = (found, now = Date.now()) => ({
  platform: found.platform,
  platformInfo: isRecord(found.platformInfo) ? found.platformInfo : undefined,
  modelsPublic: found.modelsPublic === true,
  detectedAt: new Date(now).toISOString(),
  describedVersion: DESCRIBE_VERSION,
});

/**
 * Re-describe a saved site's models from a list already read (`found`, discovery's answer).
 * @returns how many models changed, or false for an unknown site.
 */
export async function applyDiscovery(settings, siteId, found) {
  if (!found?.ok) return 0;
  const fresh = new Map((found.models ?? []).map((model) => [model.id, model]));
  return settings.mapModels(siteId, (model) => redescribe(model, fresh.get(model.id)), detectedPatch(found));
}

/** Whether a site's models were described the older way and it can be read now (switched on, with a key or none needed). */
export function needsRefresh(site, hasKey) {
  if (!site || site.enabled === false) return false;
  if ((site.describedVersion ?? 1) >= DESCRIBE_VERSION) return false;
  if (!site.keyless && !hasKey) return false;
  return Boolean(endpointById(site.id));
}

/**
 * Read one saved site's list again and re-describe its models.
 * @param {object} deps - `{ settings, keys, fetchImpl }`.
 * @returns `{ ok, changed, error? }`.
 */
export async function refreshSite({ settings, keys, relayStore, fetchImpl = fetch }, siteId) {
  const site = await settings.site(siteId);
  if (!site) return { ok: false, changed: 0, error: "unknown site" };
  const active = await keys.active(site.id);
  // A relay prices by the key's group (new-api: its log tells which).
  const group = active && relayStore ? (await relayStore.read()).keys[active.id]?.log?.group ?? undefined : undefined;
  const found = await discover({ baseUrl: site.baseUrl, protocol: site.protocol, headers: site.headers, key: active?.key, allowHttp: site.allowHttp === true }, { fetchImpl, group });
  if (!found.ok) return { ok: false, changed: 0, error: found.error };
  return { ok: true, changed: (await applyDiscovery(settings, siteId, found)) || 0 };
}
