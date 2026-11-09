/**
 * CRS (claude-relay-service, the generation before sub2api; source: Wei-Shaw/claude-relay-service, 2026-11,
 * v1.1.316): what a key may read on the site's own statistics page.
 *
 * - `POST /apiStats/api/user-stats` with `{ apiKey }`: the key's name, expiry, total use and cost, its limits
 *   (total / daily / Claude-week spend, a rate window of requests, tokens or spend, concurrency) with what is used of
 *   each, and its restrictions (allowed clients, models).
 * - `POST /apiStats/api/user-model-stats` with `{ apiKey, period }` (`daily` today, `monthly` this month): per model
 *   requests, tokens and cost (USD).
 *
 * @module dsh-custom-models/relay/crs
 */
import { asNumber, asString, isRecord } from "../errors.js";

const usd = (value) => (asNumber(value) !== undefined && asNumber(value) >= 0 ? Math.round(asNumber(value) * 1e6) / 1e6 : null);
const iso = (value) => (asString(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : asNumber(value) > 0 ? new Date(asNumber(value)).toISOString() : null);

/** Whether a `/apiStats/api/user-stats` answer is CRS's (a site detected by it). */
export const isCrsStats = (body) => isRecord(body) && body.success === true && isRecord(body.data) && isRecord(body.data.limits) && isRecord(body.data.usage);

/**
 * A CRS key's balance as the page shows balances: the room left of its total spend cap (else unlimited, with what
 * it spent), its windows — the day's spend, the Claude week's, the rate window's (spend, requests, tokens) — its
 * expiry, and the clients it is restricted to.
 */
export function crsBalance(data) {
  const limits = isRecord(data?.limits) ? data.limits : {};
  const spent = usd(limits.currentTotalCost) ?? usd(data?.usage?.total?.cost) ?? 0;
  const total = usd(limits.totalCostLimit);
  const windows = [];
  if (usd(limits.dailyCostLimit) > 0) windows.push({ id: "1d", limit: usd(limits.dailyCostLimit), used: usd(limits.currentDailyCost) ?? 0, resetAt: null });
  if (usd(limits.weeklyOpusCostLimit) > 0) windows.push({ id: "claude7d", limit: usd(limits.weeklyOpusCostLimit), used: usd(limits.weeklyOpusCost) ?? 0, resetAt: null });
  const minutes = asNumber(limits.rateLimitWindow) > 0 ? asNumber(limits.rateLimitWindow) : null;
  const windowEnd = iso(limits.windowEndTime);
  if (minutes && usd(limits.rateLimitCost) > 0) windows.push({ id: "rate", minutes, limit: usd(limits.rateLimitCost), used: usd(limits.currentWindowCost) ?? 0, resetAt: windowEnd });
  const rate = minutes && (asNumber(limits.rateLimitRequests) > 0 || asNumber(limits.tokenLimit) > 0)
    ? { minutes, ...(asNumber(limits.rateLimitRequests) > 0 ? { requests: { limit: asNumber(limits.rateLimitRequests), used: asNumber(limits.currentWindowRequests) ?? 0 } } : {}), ...(asNumber(limits.tokenLimit) > 0 ? { tokens: { limit: asNumber(limits.tokenLimit), used: asNumber(limits.currentWindowTokens) ?? 0 } } : {}), resetAt: windowEnd }
    : null;
  const restrictions = isRecord(data?.restrictions) ? data.restrictions : {};
  const clients = restrictions.enableClientRestriction === true && Array.isArray(restrictions.allowedClients) ? restrictions.allowedClients.map(String).filter((item) => item.length <= 40).slice(0, 10) : null;
  return {
    currency: "USD",
    amount: total > 0 ? Math.max(0, Math.round((total - spent) * 1e6) / 1e6) : null,
    used: spent,
    unlimited: !(total > 0),
    scope: "key",
    ...(windows.length ? { windows } : {}),
    ...(rate ? { rate } : {}),
    ...(clients && clients.length ? { clients } : {}),
    ...(iso(data?.expiresAt) ? { expiresAt: iso(data.expiresAt) } : {}),
    ...(asNumber(limits.concurrencyLimit) > 0 ? { concurrency: asNumber(limits.concurrencyLimit) } : {}),
  };
}

/** `/apiStats/api/user-model-stats`: per model requests, tokens and cost (USD) for the period read. */
export function readCrsModelStats(body) {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.data)) return null;
  const models = {};
  for (const item of body.data) {
    if (!isRecord(item) || !asString(item.model) || item.model.length > 200) continue;
    const costs = isRecord(item.costs) ? item.costs : {};
    models[item.model] = { amount: usd(costs.total ?? costs.real) ?? 0, requests: asNumber(item.requests) ?? 0, tokens: asNumber(item.allTokens) ?? 0 };
  }
  return models;
}
