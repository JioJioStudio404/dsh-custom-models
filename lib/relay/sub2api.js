/**
 * sub2api: what a key may read beside its balance (source: Wei-Shaw/sub2api, 2026-11, v0.2.20).
 *
 * - `GET /v1/usage?days=N&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` (the key): besides the balance (probe.js),
 *   `daily_usage[]` — per day `requests`, tokens, `cost` (list price) and `actual_cost` (what was deducted) — and
 *   `model_stats[]` — per model over the date range, the same figures. Dates are the site's own (its time zone).
 * - `GET /api/v1/model-plaza` (public unless the site requires sign-in; 404 when the site has it off, 2026-07): per
 *   group its platform, rate multiplier and peak hours, and per model the price the group charges (USD per token:
 *   input, output, cache write 5 min / 1 h / 12 h, cache read; per request; long-context intervals; time-of-day
 *   multipliers) beside the official price.
 *
 * @module dsh-custom-models/relay/sub2api
 */
import { asNumber, asString, isRecord } from "../errors.js";

const usd = (value) => (asNumber(value) !== undefined && asNumber(value) >= 0 ? Math.round(asNumber(value) * 1e8) / 1e8 : null);
const NAME = (value) => (asString(value) && value.length <= 200 ? value : null);

/** The site's own record of a key's spend: per day (`daily`) and per model over the range read (`models`), in USD. */
export function readUsageStats(body) {
  if (!isRecord(body)) return null;
  const daily = {};
  for (const item of Array.isArray(body.daily_usage) ? body.daily_usage : []) {
    if (!isRecord(item) || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date))) continue;
    daily[item.date] = { amount: usd(item.actual_cost) ?? usd(item.cost) ?? 0, list: usd(item.cost) ?? null, requests: asNumber(item.requests) ?? 0, tokens: asNumber(item.total_tokens) ?? 0 };
  }
  const models = {};
  for (const item of Array.isArray(body.model_stats) ? body.model_stats : []) {
    const name = isRecord(item) ? NAME(item.model) : null;
    if (!name) continue;
    models[name] = { amount: usd(item.actual_cost) ?? usd(item.cost) ?? 0, list: usd(item.cost) ?? null, requests: asNumber(item.requests) ?? 0, tokens: asNumber(item.total_tokens) ?? 0 };
  }
  return { daily, models };
}

/** A date `days` before `now`, as the site writes it (YYYY-MM-DD; the local calendar stands in for the site's). */
export function dateBefore(now, days) {
  const date = new Date(now - days * 86_400_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const perMillion = (value) => (asNumber(value) !== undefined && asNumber(value) >= 0 ? Math.round(asNumber(value) * 1e6 * 1e6) / 1e6 : undefined);

/** One plaza price (USD per token) as this plugin keeps prices: per million tokens, plus a price per request and tiers. */
export function plazaPrice(pricing) {
  if (!isRecord(pricing)) return null;
  const input = perMillion(pricing.input_price);
  const output = perMillion(pricing.output_price);
  const perRequest = asNumber(pricing.per_request_price) > 0 ? asNumber(pricing.per_request_price) : undefined;
  if (input === undefined && output === undefined && perRequest === undefined) return null;
  const cost = { input: input ?? 0, output: output ?? 0, cacheRead: perMillion(pricing.cache_read_price) ?? input ?? 0, cacheWrite: perMillion(pricing.cache_write_price) ?? 0, unit: "USD" };
  if (perRequest !== undefined) cost.perRequest = perRequest;
  const tiers = (Array.isArray(pricing.intervals) ? pricing.intervals : [])
    .filter((tier) => isRecord(tier) && asNumber(tier.min_tokens) > 0 && perMillion(tier.input_price) !== undefined)
    .map((tier) => ({ above: asNumber(tier.min_tokens), input: perMillion(tier.input_price), output: perMillion(tier.output_price) ?? cost.output, cacheRead: perMillion(tier.cache_read_price) ?? perMillion(tier.input_price), cacheWrite: perMillion(tier.cache_write_price) ?? cost.cacheWrite }))
    .slice(0, 8);
  if (tiers.length) cost.tiers = tiers;
  return cost;
}

/** sub2api's plaza: its groups (platform, multiplier, peak hours) and each group's models with the price it charges. */
export function readPlaza(response) {
  if (response.status === 404 || response.status === 401 || response.status === 403 || response.status === 405) return { unsupported: true };
  if (!response.ok || !isRecord(response.body)) return { error: response.status };
  const data = isRecord(response.body.data) ? response.body.data : response.body;
  if (!Array.isArray(data.groups)) return { unsupported: true };
  const groups = data.groups.filter(isRecord).slice(0, 100).map((group) => ({
    id: asNumber(group.id) ?? null,
    name: NAME(group.name),
    platform: NAME(group.platform),
    rate: asNumber(group.rate_multiplier) ?? 1,
    ...(group.peak_rate_enabled === true ? { peak: { start: String(group.peak_start ?? ""), end: String(group.peak_end ?? ""), multiplier: asNumber(group.peak_rate_multiplier) ?? 1 } } : {}),
    models: (Array.isArray(group.models) ? group.models : []).filter(isRecord).slice(0, 500).map((model) => ({
      name: NAME(model.name),
      platform: NAME(model.platform) ?? NAME(group.platform),
      price: plazaPrice(model.pricing),
      official: plazaPrice(model.official_pricing),
      ...(isRecord(model.time_pricing) && Array.isArray(model.time_pricing.periods) ? { timed: { zone: NAME(model.time_pricing.timezone) ?? "UTC", weekdaysOnly: model.time_pricing.weekdays_only === true, periods: model.time_pricing.periods.filter(isRecord).slice(0, 12).map((period) => ({ start: String(period.start_time ?? ""), end: String(period.end_time ?? ""), multiplier: asNumber(period.multiplier) ?? 1 })) } } : {}),
    })).filter((model) => model.name),
  }));
  return { groups };
}

/**
 * The plaza group a key is in: among groups whose multiplier is the key's own (its billing read), the one holding
 * every model the key lists; with no billing read, the only group holding them all. Null when it is not one group.
 */
export function plazaGroupOf(plaza, { modelIds = [], groupRate = null } = {}) {
  const groups = Array.isArray(plaza?.groups) ? plaza.groups : [];
  const holds = (group) => modelIds.length > 0 && modelIds.every((id) => group.models.some((model) => model.name === id));
  const byRate = groupRate === null ? groups : groups.filter((group) => Math.abs((group.rate ?? 1) - groupRate) < 1e-9);
  const matching = byRate.filter(holds);
  return matching.length === 1 ? matching[0] : null;
}

/**
 * A model's base price on a key's group (what sub2api multiplies by the key's rate to bill): the group's own; when the
 * group is not known, the official price (`estimated`). Null when the plaza does not list the model.
 */
export function plazaModelPrice(plaza, modelId, { group = null } = {}) {
  if (group) {
    const model = group.models.find((item) => item.name === modelId);
    if (model?.price) return { price: model.price, group: group.name ?? String(group.id ?? ""), platform: model.platform ?? group.platform ?? null, ...(model.timed ? { timed: model.timed } : {}) };
  }
  const anywhere = (plaza?.groups ?? []).flatMap((item) => item.models).find((item) => item.name === modelId && (item.official || item.price));
  if (!anywhere) return null;
  return { price: anywhere.official ?? anywhere.price, group: null, platform: anywhere.platform ?? null, estimated: true };
}

/** A price scaled by a multiplier (sub2api bills the base price times the key's rate). */
export function scalePrice(price, rate) {
  const scaled = (value) => (typeof value === "number" ? Math.round(value * rate * 1e6) / 1e6 : value);
  return {
    ...price,
    input: scaled(price.input),
    output: scaled(price.output),
    cacheRead: scaled(price.cacheRead),
    cacheWrite: scaled(price.cacheWrite),
    ...(typeof price.perRequest === "number" ? { perRequest: scaled(price.perRequest) } : {}),
    ...(Array.isArray(price.tiers) ? { tiers: price.tiers.map((tier) => ({ ...tier, input: scaled(tier.input), output: scaled(tier.output), cacheRead: scaled(tier.cacheRead), cacheWrite: scaled(tier.cacheWrite) })) } : {}),
  };
}
