/**
 * dsh-custom-models — the user's own API sites for DeepSeek Harness (relays,
 * gateways, self-hosted and local servers speaking OpenAI Chat Completions or
 * Responses, or Anthropic Messages), with many keys per site.
 *
 * Host half: one LLM route per site that has a key (or needs none:
 * `custom-<id>`), and one for the switch groups (`custom-groups`), requested
 * the way DSH's own custom gateway requests them (gateway.js: the same pi-ai
 * release, bundled) with reasoning effort, tool calling and reasoning replay;
 * every key's validity and — where the site's platform shows one (new-api /
 * one-api, Hyper, Vercel, OpenRouter) — its balance; spending per key; and
 * the `customModels` Remote namespace the browser half manages it through.
 * Keys and sites switch only by hand.
 *
 * Imports no `@deepseek-ai/*` package: a third-party plugin cannot resolve
 * them from a profile, and the host duck-types adapters.
 *
 * @module dsh-custom-models
 */
import { readFileSync } from "node:fs";
import { CustomAdapter } from "./adapter.js";
import { createChecker } from "./checker.js";
import { RelayStore } from "./relay/store.js";
import { createRelaySync } from "./relay/sync.js";
import { displayNameOf, endpointOfRoute, GROUP_DISPLAY_NAME, GROUP_ROUTE, routeOf } from "./endpoints.js";
import { isRecord, redact, registerSecret, safeJson } from "./errors.js";
import { KeyStore } from "./keys.js";
import { needsRefresh, refreshSite } from "./refresh.js";
import { UsageLedger } from "./usage.js";
import { createCustomModelsService, SERVICE_KEY } from "./service.js";
import { SettingsStore } from "./store.js";
import { createAuthn } from "./authn/index.js";
import { UPDATE_INTERVAL_MS } from "./authn/update.js";

export const name = "dsh-custom-models";
export const inject = ["llm"];
export { SERVICE_KEY };

/**
 * Duck-typed Config schema (cordis validates it on load; dsh-settings lists a
 * namespace — and so a Models-page row for each route — only for a schema with
 * `toJSON`, `meta.volatile` and `type`). The form is empty: sites, keys and
 * models are managed in the Custom tab of a conversation.
 */
export const Config = {
  type: "object",
  meta: { volatile: true, default: {} },
  dict: {},
  toJSON() {
    return { type: "object", meta: { volatile: true, default: {} }, dict: {} };
  },
  "~standard": {
    version: 1,
    vendor: "dsh-custom-models",
    validate(value) {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value === "object" && !Array.isArray(value)) return { value };
      return { issues: [{ message: `expected object but got ${Array.isArray(value) ? "array" : typeof value}` }] };
    },
  },
};

/**
 * The routes: each site switched on with a key (or a keyless one), in the
 * user's order, then the switch groups when one is served by a site switched on.
 */
export function routesOf(settingsState, keysState) {
  const sites = (Array.isArray(settingsState?.sites) ? settingsState.sites : []).filter((site) => site.enabled !== false);
  const keyed = new Set((Array.isArray(keysState?.keys) ? keysState.keys : []).map((record) => record?.endpoint));
  const routes = sites.filter((site) => site.keyless || keyed.has(site.id)).map((site) => routeOf(site.id));
  const groups = Array.isArray(settingsState?.groups) ? settingsState.groups : [];
  const on = new Set(sites.map((site) => site.id));
  if (groups.some((group) => on.has((group.members?.[group.active] ?? group.members?.[0])?.site))) routes.push(GROUP_ROUTE);
  return routes;
}

/**
 * Mount the adapter, the routes, and the service.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[dsh-custom-models] ${message}`);
    } catch {
      /* diagnostics never fail a request */
    }
  };
  const llm = ctx?.llm;
  if (!llm || typeof llm.registerAdapter !== "function") {
    log("warn", "ctx.llm.registerAdapter is unavailable; no route is registered");
    return;
  }
  const keys = new KeyStore();
  const settings = new SettingsStore();
  const usage = new UsageLedger();
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? name;

  // Routes exist before the first request: both stores are read synchronously once.
  const initialSettings = settings.readSync(readFileSync);
  const initialKeys = (() => {
    try {
      return safeJson(readFileSync(keys.path(), "utf8"));
    } catch {
      return null;
    }
  })();
  for (const record of isRecord(initialKeys) && Array.isArray(initialKeys.keys) ? initialKeys.keys : []) registerSecret(record?.key);
  let routes = routesOf(initialSettings, initialKeys);
  let registration;
  let directory;
  const label = (route) => (route === GROUP_ROUTE ? GROUP_DISPLAY_NAME : displayNameOf(endpointOfRoute(route) ?? { name: route }));
  const entries = () => routes.map((route) => ({ provider: route, displayName: label(route), settingsNs, settingsPath: [] }));
  const commit = () => {
    try {
      if (!registration && routes.length) registration = llm.registerAdapter([...routes], adapter);
      else registration?.replace([...routes]);
    } catch (error) {
      log("warn", `routes not registered: ${error?.message ?? error}`);
    }
    if (typeof llm.registerConfigurableProviders !== "function") return;
    try {
      if (!directory && routes.length) directory = llm.registerConfigurableProviders(entries());
      else directory?.replace(entries());
    } catch (error) {
      log("warn", `Models-page rows not registered: ${error?.message ?? error}`);
    }
  };
  let announcing = false;
  const modelsChanged = () => {
    if (announcing) return;
    announcing = true;
    queueMicrotask(() => {
      announcing = false;
      if (registration) commit();
      else {
        try {
          ctx.emit("llm/adapters-updated");
        } catch {
          /* nothing registered yet: nothing to announce */
        }
      }
    });
  };
  const routesChanged = () => {
    Promise.all([settings.read(), keys.read()]).then(([settingsState, keysState]) => {
      const next = routesOf(settingsState, keysState);
      if (next.join() === routes.join()) return modelsChanged();
      routes = next;
      commit();
    }).catch((error) => log("warn", `routes not updated: ${error?.message ?? error}`));
  };

  const checker = createChecker({ keys, settings, log });
  // Model authenticity checks (off until the user switches them on in the Custom tab's 模型核验 page).
  const authn = createAuthn({ settings, keys, usage, log });
  // What relay systems tell beside the balance (new-api's log, sub2api's and CRS's statistics, the sites' figures).
  const relayStore = new RelayStore();
  const relaySync = createRelaySync({
    keys,
    settings,
    store: relayStore,
    factsOn: () => authn.passiveOn(),
    account: (siteId) => keys.account(siteId),
    // A key's group became known or changed: its site's prices are worked out again at that group.
    onGroup: (siteId, group) => {
      refreshSite({ settings, keys, relayStore }, siteId)
        .then((result) => {
          if (result.changed) modelsChanged();
          log("info", `${siteId}: priced at group ${group} (${result.changed || 0} model(s) changed)`);
        })
        .catch((error) => log("warn", `${siteId}: prices not worked out again: ${redact(error?.message ?? error)}`));
    },
    log,
  });
  authn.setRelayFacts(() => relaySync.allFacts());
  const adapter = new CustomAdapter({
    keys,
    settings,
    attachments: () => ctx.get("attachments"),
    log,
    onModelsChanged: modelsChanged,
    onUsed: (keyId) => {
      checker.afterUse(keyId);
      relaySync.afterUse(keyId);
    },
    usage,
    authn,
  });
  // A background check (a knowledge fingerprint) waits while the user's own requests use the site.
  authn.setTraffic?.((siteId) => adapter.inFlight(siteId));
  // Counts still in memory reach the file when the plugin is unloaded.
  try {
    ctx.effect?.(() => () => {
      usage.flush().catch(() => undefined);
      authn.flush().catch(() => undefined);
      relayStore.flush().catch(() => undefined);
    }, "dsh-custom-models: usage ledger");
  } catch {
    /* no effect seam: the ledger still writes every few seconds */
  }
  commit();

  try {
    ctx.inject?.(["settings"], (child) => {
      try {
        if (typeof child?.settings?.configure === "function") child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
      } catch {
        /* settings seam unavailable */
      }
    });
  } catch {
    /* ctx.inject unavailable */
  }

  const service = createCustomModelsService({ keys, settings, adapter, checker, usage, authn, relay: { store: relayStore, sync: relaySync }, onRoutesChanged: routesChanged, onModelsChanged: modelsChanged, log });
  if (ctx.get(SERVICE_KEY) === undefined) ctx.provide(SERVICE_KEY, service);
  else log("warn", `${SERVICE_KEY} is already provided; keeping the mounted service`);

  // Warm up without blocking the boot: free checks for keys not checked lately.
  (async () => {
    try {
      const all = await keys.keys();
      const stale = all.filter((record) => !record.checkedAt || Date.now() - Date.parse(record.checkedAt) > 10 * 60_000);
      for (const record of stale) await checker.check(record.id, { mode: "funds" }).catch(() => undefined);
      log("info", `${all.length} key(s) on ${routes.length} route(s); store=${keys.path()}`);
    } catch (error) {
      log("warn", `warmup failed: ${error?.message ?? error}`);
    }
  })();

  // Once the app has settled: sites whose models were described the older way read their list again
  // (free), so what the plugin now reads of it (a relay station's limits) applies without a click.
  const refreshTimer = setTimeout(async () => {
    try {
      for (const site of await settings.sites()) {
        if (!needsRefresh(site, Boolean(await keys.active(site.id)))) continue;
        const result = await refreshSite({ settings, keys, relayStore }, site.id).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
        if (result.changed) modelsChanged();
        log(result.ok ? "info" : "warn", result.ok ? `${site.id}: ${result.changed} model(s) described again from the site's list` : `${site.id}: list not read again (${redact(result.error ?? "")}); tried again next start`);
      }
    } catch (error) {
      log("warn", `model refresh failed: ${redact(error?.message ?? error)}`);
    }
    // Then the windows of models no list states and no probe of this version asked yet (once per model).
    await service.probePending().catch((error) => log("warn", `window probes failed: ${redact(error?.message ?? error)}`));
    // And what relay sites tell beside the balance (each read within its own interval).
    try {
      for (const site of await settings.sites()) {
        if (site.enabled === false) continue;
        await relaySync.refreshSite(site.id).catch(() => undefined);
        for (const record of await keys.keysFor(site.id)) await relaySync.refreshKey(record.id).catch(() => undefined);
      }
    } catch (error) {
      log("warn", `relay reads failed: ${redact(error?.message ?? error)}`);
    }
  }, REFRESH_DELAY_MS);
  refreshTimer.unref?.();

  // The rule pack of model authenticity checks: looked for once the app settled, then daily (only while the
  // feature is on, updates are on and a source is set up).
  const updateNow = () => authn.scheduledUpdate().catch((error) => log("warn", `authn rule pack check failed: ${redact(error?.message ?? error)}`));
  const updateTimer = setTimeout(() => {
    void updateNow();
    const daily = setInterval(() => void updateNow(), UPDATE_INTERVAL_MS);
    daily.unref?.();
    try {
      ctx.effect?.(() => () => clearInterval(daily), "dsh-custom-models: authn updates");
    } catch {
      /* no effect seam: the interval is unref'd */
    }
  }, UPDATE_DELAY_MS);
  updateTimer.unref?.();
}

/** How long after the start the rule pack is first looked for. */
const UPDATE_DELAY_MS = 60_000;

/** How long after the start the background model refresh waits (the app's own start comes first). */
const REFRESH_DELAY_MS = 15_000;

export default { name, inject, apply, Config };
