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
import { displayNameOf, endpointOfRoute, GROUP_NAME, GROUP_ROUTE, routeOf } from "./endpoints.js";
import { isRecord, registerSecret, safeJson } from "./errors.js";
import { KeyStore } from "./keys.js";
import { createCustomModelsService, SERVICE_KEY } from "./service.js";
import { SettingsStore } from "./store.js";

export const name = "dsh-custom-models";
export const inject = ["llm"];
export { SERVICE_KEY };

/**
 * Duck-typed Config schema (cordis validates it on load; dsh-settings lists a
 * namespace — and so a Models-page row for each route — only for a schema with
 * `toJSON`, `meta.volatile` and `type`). The form is empty: sites, keys and
 * models are managed in the 自定义 tab of a conversation.
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
  const label = (route) => (route === GROUP_ROUTE ? GROUP_NAME : displayNameOf(endpointOfRoute(route) ?? { name: route }));
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
  const adapter = new CustomAdapter({
    keys,
    settings,
    attachments: () => ctx.get("attachments"),
    log,
    onModelsChanged: modelsChanged,
    onUsed: (keyId) => checker.afterUse(keyId),
  });
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

  const service = createCustomModelsService({ keys, settings, adapter, checker, onRoutesChanged: routesChanged, onModelsChanged: modelsChanged, log });
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
}

export default { name, inject, apply, Config };
