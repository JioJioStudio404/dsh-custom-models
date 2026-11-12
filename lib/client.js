/**
 * dsh-custom-models — browser half.
 *
 * A hand-written module in the `window.__ModuleLoader__.load({ id, factory })`
 * shape every DSH client half uses (no ESM syntax). It requires only `react`
 * and the shared UI primitives, and talks to the host through the
 * `customModels` Remote namespace. Keys show in full in the tab (as in the
 * other key plugins); compact places mask them.
 *
 * It contributes:
 *  - one tab beside 对话 / 轨迹 (`conversation.view`), Custom: a left column
 *    (as DSH's own settings) of pages — the overview (every site's state,
 *    balance and use; today, 30 days, the last 30 days day by day), one page
 *    per site (its use, its keys on two lines each, its models with what each
 *    used and cost, its settings), the switch groups (one picker entry each,
 *    its member chosen by hand), and a new site (DSH's own form, then
 *    "获取可用模型" and the models to add);
 *  - each route's card on Settings → Models (`settings.models.provider-card`).
 */
window.__ModuleLoader__.load({
  id: "dsh-custom-models",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const P = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;

    const NS = "custom-models";
    /** This page's version: the host's `status.version` differs until DeepSeek Harness restarts (a link install updates the page on reload only). */
    const CLIENT_VERSION = "0.8.1";
    /** The settings namespace of the plugin's Models-page rows (the bundle patch's row id). */
    const SETTINGS_NS = "dsh-custom-models";
    /** The (local, cheap) status is re-read this often while the tab is open. */
    const STATUS_INTERVAL_MS = 15_000;
    /** Balances are re-read this often while the tab is open (free). */
    const CHECK_INTERVAL_MS = 5 * 60_000;
    const SITE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
    /** Ids no site may take (the host refuses them too): the switch groups' route name, an object's own name. */
    const RESERVED_SITE_IDS = ["groups", "constructor"];
    /** The protocols a site or model may be given: the ones DSH's own custom gateway serves. A Gemini site from before 0.2.0 only shows as such. */
    const PROTOCOLS = ["chat", "responses", "messages"];
    const PROTOCOL_NAMES = { chat: "OpenAI Chat Completions", responses: "OpenAI Responses", messages: "Anthropic Messages" };
    /** A protocol's full name; Gemini (0.1.x sites) says where it went. */
    const protocolName = (t, protocol) => (protocol === "gemini" ? t("protocol.geminiGone") : PROTOCOL_NAMES[protocol]);
    const PROTOCOL_SHORT = { chat: "Chat", responses: "Responses", messages: "Messages", gemini: "Gemini" };
    const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
    const FORMATS = ["effort", "openrouter", "deepseek", "qwen", "none"];

    const DICTS = {
      en: {
        "tab.label": "Custom",
        "head.title": "Custom API sites",
        "head.add": "Add site",
        "head.validate": "Verify all",
        "head.validating": "Verifying…",
        "head.validateHint": "Verify every key: confirm the site accepts it, then send one minimal real request to the site's first model",
        "head.funds": "Refresh balances",
        "head.fundsing": "Refreshing…",
        "head.fundsHint": "Re-query the balances each site exposes to its keys (free of charge); also refreshed automatically when this tab opens, every 5 minutes and after each request",
        "empty": "No sites yet. Relays, aggregation gateways and local servers (OpenAI / Anthropic protocols) can be added.",
        "site.switch": "Enabled",
        "site.switchTitle": "When disabled, this site's models are hidden from the model picker at the bottom (keys and model settings are kept)",
        "site.modelsTitle": "Models this site provides in the model picker",
        "site.addKey": "Add key",
        "site.remove": "Delete site",
        "site.removeConfirm": "Delete this site and all its keys?",
        "site.keyless": "No key required",
        "site.noUsage": "No usage reported",
        "site.noUsageTitle": "This site's responses include no token usage: the context usage and output speed shown by DeepSeek Harness are its own estimates, and today's usage counts requests only.",
        "site.keylessTitle": "Local server, no key required: requests are sent without a key",
        "http.warn": "This is a public http address; traffic is not encrypted. The API key and the full conversation travel across the internet in plain text: carriers, public Wi-Fi and proxies along the way can read them and tamper with the model's responses — including tool calls that DSH executes on this computer. Use https whenever the site supports it.",
        "http.httpsWorks": "This site is also reachable over https.",
        "http.useHttps": "Switch to https",
        "http.confirm": "I understand this site is unencrypted; connect over http anyway",
        "http.confirmFirst": "Confirm the use of unencrypted http above first",
        "http.publicTitle": "Unencrypted: the key and conversation travel across the internet in plain text",
        "http.privateTitle": "http address on this computer or a local network",
        "http.direct": "HTTP_PROXY not set: direct connection (HTTPS_PROXY does not apply to http)",
        "http.proxied": "Connected through the HTTP_PROXY / ALL_PROXY proxy",
        "site.noKeys": "No keys added yet",
        "site.publicList": "This site's model list endpoint does not verify keys: click ✓ to send one minimal request and confirm the key works",
        "col.status": "Status",
        "col.balance": "Balance",
        "col.usage": "Usage today",
        "status.ok": "Available",
        "status.valid": "Key valid",
        "status.validHint": "The site accepted this key; click ✓ to send one minimal request and confirm the model responds",
        "status.unproven": "Unconfirmed",
        "status.unprovenHint": "This site's model list endpoint does not verify keys: click ✓ to confirm with one minimal request",
        "status.probed": "Confirmed working on {model} {time} ago",
        "status.probeError": "Last test request was inconclusive: {message}",
        "status.unknown": "Not verified",
        "status.no-balance": "Insufficient balance",
        "status.plan-quota": "Quota exhausted",
        "status.invalid": "Invalid key",
        "status.expired": "Expired",
        "status.restricted": "Client restricted",
        "status.restrictedHint": "The site serves this key to its designated clients only (for example Claude Code); requests from this plugin are refused. Use a key from another group of the site.",
        "status.error": "Verification failed",
        "status.held": "Paused until {time}",
        "status.lastError": "Last verification failed: {message}",
        "status.checked": "Last checked {time} ago",
        "status.never": "Never checked",
        "status.manual": "Keys can only be switched manually: to use another key, click Set active",
        "key.copy": "Copy key",
        "key.copied": "Copied",
        "key.active": "Active",
        "key.switch": "Set active",
        "key.validate": "Verify key (sends one minimal request)",
        "key.funds": "Refresh balance",
        "key.noFunds": "This site does not expose balance queries to keys",
        "key.edit": "Rename",
        "key.remove": "Delete",
        "key.removeConfirm": "Confirm delete",
        "key.drag": "Drag to reorder (or use ↑ ↓)",
        "balance.none": "—",
        "balance.credits": "{amount} credits",
        "balance.creditsTitle": "Hypercredits remaining ≈ {usd} (1 credit = $0.05)",
        "balance.unlimited": "Unlimited quota",
        "balance.used": "{amount} used",
        "balance.keyScope": "This key's token quota on the site (not the account balance)",
        "balance.accountScope": "Account balance on the site (read through this key)",
        "balance.tokenLine": "This key's token quota: {left} left, {used} used",
        "balance.tokenUnlimited": "This key's token quota: unlimited, {used} used",
        "balance.accountHint": "Shown is this key's token quota. To show the account balance, enable “Allow querying account quota” for this token in the site's token settings.",
        "balance.billing": "Billing multiplier ×{rate}",
        "balance.billingPeak": "Billing multiplier ×{rate}; peak hours {start}–{end} ×{peak} ({zone})",
        "balance.accountEmpty": "The site rejected the request: insufficient account balance (shown here is this key's token quota). After topping up, send a message or click ✓ to resume",
        "balance.expires": "Expires {time}",
        "balance.plan": "Plan: {name}",
        "balance.window": "{window} limit: {used} of {limit} used",
        "balance.windowAt": "{window} limit: {used} of {limit} used, resets {time}",
        "balance.windowLeft": "remaining in the {window} limit",
        "balance.window.5h": "5-hour",
        "balance.window.1d": "daily",
        "balance.window.claude7d": "Claude weekly",
        "balance.window.rate": "rate window",
        "balance.rateRequests": "Rate window ({minutes} min): {used} of {limit} requests",
        "balance.rateTokens": "Rate window ({minutes} min): {used} of {limit} tokens",
        "balance.clients": "Restricted to clients: {clients}",
        "balance.concurrency": "Concurrency limit: {n}",
        "relay.title": "Site records",
        "stat.requestsCount": "{count} requests",
        "relay.today": "Billed today",
        "relay.d7": "7 days",
        "relay.d30": "30 days",
        "relay.month": "This month",
        "relay.sourceLog": "Read from the site's own log for these keys: every request the site billed them, from any client using them, since {time}.",
        "relay.sourceStats": "Read from the site's own usage statistics for these keys (every client using them).",
        "relay.partial": "Some log entries were missed between two reads (more than 1,000 requests in between): the figure is lower than what was billed.",
        "relay.read": "Read {time} ago",
        "relay.notRead": "Not read yet: click Refresh balance.",
        "relay.key": "{key}",
        "relay.group": "group {group}",
        "relay.groupTitle": "The site's group this key is in (from the site's log); its models are priced at this group.",
        "relay.subscription": "subscription {title}: {remain} left of {total}",
        "relay.logError": "log not read: {error}",
        "relay.account": "Account",
        "relay.accountValue": "{amount} left · {used} used",
        "relay.accountGroup": "group {group}",
        "relay.accountDenied": "The account token was refused (expired, revoked, or without read permission).",
        "relay.accountOrigin": "The account token was set for another address of this site and is not sent to the current one. Set it again.",
        "relay.accountError": "The account could not be read: {error}",
        "relay.subLine": "Subscription: {used} of {total} used{end}",
        "relay.subEnd": ", ends {time}",
        "relay.accountToken": "Account access token (read-only)",
        "relay.accountHint": "Optional. In the site's account settings, create a personal access token with only “Profile: View”, “Usage: View” and “Wallet: View”. It is used only to read this account's balance and subscriptions from this site, never sent anywhere else, and not shown again. An older system access token also works together with the user ID; it carries every permission of the account.",
        "relay.tokenPlaceholder": "Paste the token",
        "relay.userId": "User ID (older system tokens only)",
        "relay.tokenSet": "Set ({masked})",
        "relay.save": "Save",
        "relay.remove": "Remove",
        "relay.plaza": "Model plaza: {groups} groups",
        "relay.plazaTitle": "Model prices come from the site's model plaza, at this key's billing multiplier.",
        "relay.perf": "Performance figures: {models} models",
        "relay.perfTitle": "The site's own success rate, latency and output speed per model (last 24 hours), shown under Model verification.",
        "models.billedTitle": "Billed by the site: {billed}; plugin estimate: {estimate}",
        "price.perRequest": "{price} per request",
        "price.group": "group {group}",
        "price.rate": "multiplier ×{rate}",
        "price.peak": "peak hours {start}–{end} ×{multiplier}",
        "price.expr": "The site bills this model by tiers of its own; estimates use the base price (the site's records show what was billed)",
        "price.estimated": "No price was found for this key's group: official price × multiplier",
        "edit.served": "The site serves it in: {protocols}",
        "metric.site-log": "Site log (new-api)",
        "metric.site-log.value": "{n} requests read: {mapped} mapped, {returned} answered as another model, {overwritten} with the system prompt overwritten",
        "metric.site-log.na": "Not read (new-api sites, while passive monitoring is on)",
        "ev.relayMapped": "The site's log states it mapped this model to {upstream} ({n} of {total} requests)",
        "ev.relayVariant": "The site's log states it served this model as {upstream}, a variant of the same model ({n} of {total} requests)",
        "ev.relayReturned": "Per the site's log, the upstream answered as {returned} ({n} of {total} requests)",
        "ev.relayPrompt": "Per the site's log, it overwrote the system prompt ({n} of {total} requests)",
        "source.site-log": "Site log",
        "panel.sitePerf": "Site's own figures (24 h): success {success}, average latency {latency}, {tps} tokens/s",
        "balance.window.7d": "7-day",
        "balance.window.30d": "monthly",
        "balance.siteToday": "Today's usage per the site: {requests} requests, {tokens} tokens, {cost}",
        "funds.failed": "Balance query failed",
        "funds.failedLine": "{label}: {error}",
        "list.sep": ", ",
        "usage.today": "{requests} req · {tokens}",
        "usage.none": "—",
        "usage.cost": "≈{cost}",
        "usage.month": "This month: {requests} requests, {tokens} tokens, ≈{cost}",
        "usage.quotaNote": " (priced in site quota)",
        "dialog.addTitle": "Add site",
        "dialog.id": "Provider ID",
        "dialog.idHint": "Must start with a lowercase letter and contain only lowercase letters, digits and hyphens; used as the route name (groups and constructor are reserved)",
        "dialog.name": "Display name",
        "dialog.baseUrl": "API base URL",
        "dialog.protocol": "API protocol",
        "dialog.keys": "API key",
        "dialog.keysPlaceholder": "Enter API key (for multiple keys, one per line)",
        "dialog.keyless": "No key required (local server)",
        "dialog.advanced": "Advanced settings",
        "dialog.headers": "Request headers",
        "dialog.headersPlaceholder": "Name: value (one per line)",
        "dialog.defaultContext": "Default context window (K tokens)",
        "dialog.defaultContextTitle": "Applies to models whose site provides no context window and that have not been edited manually (also when the reference catalog lists a larger value). DeepSeek Harness auto-compacts at about 80% usage. Leave empty for {value}K, which is below DeepSeek Harness's built-in default (1M), so that compaction does not start too late when a relay's actual context window is smaller.",
        "dialog.imageBudget": "Image budget (MB)",
        "dialog.imageBudgetTitle": "Upper limit on the total size of all images (base64) in one request. When exceeded, DeepSeek Harness replaces the oldest images with text descriptions. Lower this value if the site limits request body size (returns 413). Leave empty for {value} MB.",
        "dialog.imageMaxBytes": "Per-image limit (KB)",
        "dialog.imageMaxBytesTitle": "Each image is compressed to within this size before sending. Leave empty for {value} KB.",
        "dialog.learned": "Image budget automatically lowered to {size} after the site returned 413",
        "dialog.learnedReset": "Reset",
        "dialog.catalog": "Model catalog",
        "dialog.fetch": "Fetch models",
        "dialog.fetching": "Fetching…",
        "dialog.fetchFirst": "Click Fetch models, or enter a model ID manually",
        "dialog.found": "{platform} · {count} models",
        "dialog.keyRejected": "The site rejected this key",
        "dialog.manual": "Model ID",
        "dialog.manualAdd": "Add",
        "dialog.save": "Save",
        "dialog.saving": "Saving…",
        "dialog.cancel": "Cancel",
        "dialog.selected": "{count} selected",
        "models.addChosen": "Add selected ({count})",
        "models.remove": "Remove",
        "models.edit": "Edit",
        "models.search": "Search",
        "models.all": "Select all",
        "models.none": "Deselect all",
        "models.close": "Close",
        "models.context": "{k}k",
        "models.contextM": "{m}M",
        "models.image": "Image",
        "models.textOnly": "Text only",
        "models.textOnlyTitle": "The site has rejected image input for this model, so DSH now sends text descriptions of images instead. To retry, check Image input when editing the model",
        "models.ctxCapped": "Reference catalog lists {listed}; the site provides no context window, so the site default of {applied} applies (editable on the model). Auto-compaction at about {at}.",
        "models.ctxReference": "The site provides no context window; the reference catalog value applies. Auto-compaction at about {at}.",
        "models.ctxDefault": "Neither the site nor the reference catalog provides this model's context window; the site default applies. Auto-compaction at about {at}.",
        "models.ctxKnown": "Auto-compaction at about {at}.",
        "models.ctxSuggested": "The site recommends keeping context within {suggested} (its official client compacts there); to reduce per-request usage, set the context window to this value.",
        "models.thinking": "Thinking",
        "models.free": "Free",
        "models.price": "${input}/${output}",
        "models.quotaPrice": "Quota {symbol}{input}/{symbol}{output}",
        "models.priceTitle": "Price per million tokens: input / output",
        "models.quotaPriceTitle": "Site quota price per million tokens (at the site's ratios and default group)",
        "models.unusable": "Unavailable",
        "models.switch": "Switch-limited",
        "models.switchTitle": "DSH does not allow switching to this model mid-conversation: its context window cannot hold DSH's default compaction reserve (65,536 tokens). It can be used in a new conversation, but DSH will not auto-compact ahead of time for it, so long conversations may exceed the context window.",
        "groups.switchTitle": "DSH does not allow switching to this switch group mid-conversation: the selected member's context window cannot hold DSH's default compaction reserve (65,536 tokens). It can be used in a new conversation, but DSH will not auto-compact ahead of time for it.",
        "protocol.geminiGone": "Google Gemini (no longer supported: use Gemini through the Intl_Ex plugin, or switch this site to an OpenAI-compatible protocol)",
        "platform.generic": "OpenAI-compatible",
        "models.reference": "Details filled in from the reference catalog by model ID",
        "models.manual": "No information found for this model: defaults applied (editable)",
        "edit.title": "Model — {id}",
        "edit.name": "Display name",
        "edit.protocol": "Protocol",
        "edit.protocolSite": "Same as site ({protocol})",
        "edit.context": "Context window (tokens)",
        "edit.output": "Max output tokens",
        "edit.image": "Image input",
        "edit.reasoning": "Reasoning effort",
        "edit.off": "Thinking can be disabled",
        "edit.noReasoning": "Reasoning parameters not supported",
        "edit.format": "Reasoning parameter format",
        "edit.formatAuto": "Same as site platform",
        "edit.format.effort": "reasoning_effort",
        "edit.format.openrouter": "reasoning: { effort }",
        "edit.format.deepseek": "thinking: { type } (DeepSeek)",
        "edit.format.qwen": "enable_thinking (Qwen)",
        "edit.format.none": "Do not send",
        "edit.replay": "Replay reasoning on every turn",
        "edit.reset": "Restore site-provided details",
        "edit.save": "Save",
        "edit.cancel": "Cancel",
        "key.addTitle": "Add keys — {name}",
        "key.addPlaceholder": "One key per line",
        "key.label": "Name (optional)",
        "key.add": "Add",
        "key.adding": "Adding…",
        "key.renameTitle": "Rename {masked}",
        "groups.title": "Switch groups",
        "groups.titleHint": "Appears as one entry in the model picker, served by the selected member; never switches automatically",
        "groups.add": "New switch group",
        "groups.edit": "Edit",
        "groups.remove": "Delete",
        "groups.removeConfirm": "Confirm delete",
        "groups.missing": "(model removed)",
        "groups.siteOff": "(site disabled)",
        "group.addTitle": "New switch group",
        "group.editTitle": "Switch group — {name}",
        "group.name": "Name shown in the model picker",
        "group.members": "Members (the same model on different sites)",
        "group.save": "Save",
        "group.cancel": "Cancel",
        "group.pick": "Select at least one site's model",
        "card.summary": "{count} keys · active: {key} ({state})",
        "card.none": "No keys added to this site yet",
        "card.group": "{count} switch groups",
        "time.days": "{d}d {h}h",
        "time.hours": "{h}h {m}m",
        "time.minutes": "{m} min",
        "time.now": "less than 1 minute",
        "nav.overview": "Overview",
        "nav.sites": "Sites",
        "nav.off": "Disabled",
        "nav.dragHint": "Drag (or press Alt+↑ ↓) to reorder; this order is used in the model picker",
        "overview.sub": "{count} sites in total, {on} enabled",
        "add.site": "Site",
        "add.sub": "Relays, aggregation gateways and local servers (OpenAI / Anthropic protocols) are supported",
        "stat.requests": "Requests today",
        "stat.tokens": "Tokens today",
        "stat.hit": "Cache hit rate today",
        "stat.cost": "Estimated cost today",
        "stat.d30": "Last 30 days: {value}",
        "chart.title": "Token usage, last 30 days",
        "chart.label": "Daily token usage over the last 30 days",
        "chart.empty": "No usage recorded yet (recording started in version 0.4.0)",
        "chart.today": "Today",
        "chart.tipRequests": "{requests} requests · {tokens} tokens",
        "chart.tipNone": "No requests",
        "chart.tipSplit": "Input {input} · cache hits {cache} · output {output}",
        "usage.costTitle": "Estimated at current prices: a price set manually on the model takes precedence, then the price provided by the site; where a site reports its own cost, the site's figure is used. Models without a price count tokens only.",
        "usage.costReported": "Includes costs reported by the site.",
        "usage.costQuota": "Includes costs at the relay's quota price (at the site's ratios), in the currency the site displays.",
        "usage.costUnpriced": "Some models have no price; their tokens are not included in the cost (click ✎ on the model to set a price).",
        "usage.estimatedNote": "≈ includes estimates: for sites that do not report usage, usage is estimated from the text sent and received (images excluded).",
        "usage.estimatedTag": "Includes estimates",
        "col.site": "Site",
        "col.keyInUse": "Active key",
        "col.d30": "Last 30 days",
        "col.cost30": "Cost (last 30 days)",
        "col.model": "Model",
        "col.context": "Context",
        "col.requests": "Requests",
        "col.input": "Input",
        "col.cache": "Cache hits",
        "col.output": "Output",
        "col.hitRate": "Hit rate",
        "col.cost": "Cost",
        "sites.open": "Open {name}",
        "keys.title": "API keys",
        "site.verify": "Verify",
        "site.verifyHint": "Verify every key on this site: confirm the site accepts it, then send one minimal real request to the first model",
        "models.tableTitle": "Models and usage",
        "models.add": "Add models",
        "models.addTitle": "Add models — {name}",
        "models.allAdded": "All models listed by the site have been added",
        "models.noneListed": "The site lists no chat models: enter a model ID manually below",
        "models.removeConfirm": "Confirm removal",
        "models.total": "Total",
        "models.empty": "No models added yet: click Add models to add models from the site",
        "models.rowAvgInput": "Average input per request: {value} (roughly the conversation's context usage)",
        "models.rowTtft": "Time to first token: {value}",
        "models.rowSpeed": "Output speed: {value} tokens/s",
        "models.rowFailures": "{count} failed",
        "models.priceUser": "Price (set manually, per million tokens, input / output): {price}",
        "models.priceSite": "Price (provided by the site, per million tokens, input / output): {price}",
        "models.priceQuota": "Price (relay quota price, per million tokens, input / output): {price}",
        "models.priceNone": "No price set: click ✎ to set a price and enable cost estimates",
        "range.label": "Time range",
        "range.today": "Today",
        "range.d7": "7 days",
        "range.d30": "30 days",
        "settings.title": "Site settings",
        "settings.idFixed": "Route name; cannot be changed (to change it, delete the site and add it again)",
        "settings.saved": "Saved",
        "settings.revert": "Revert",
        "groups.needModels": "Add models to a site first",
        "groups.emptyHint": "No switch groups yet. A switch group combines the same model on several sites into one model picker entry, served by the selected member",
        "groups.members": "{count} members",
        "edit.price": "Price (per million tokens)",
        "edit.priceInput": "Input",
        "edit.priceCache": "Cache hits",
        "edit.priceOutput": "Output",
        "edit.priceCurrency": "Currency",
        "edit.priceSite": "Used to estimate cost. Leave empty to use the price provided by the site ({price}).",
        "edit.priceSiteNone": "Used to estimate cost. Leave empty for no price (the site provides none); only tokens are counted.",
        "edit.priceBad": "Price must be a number greater than or equal to 0",
        "time.seconds": "{s} s",
        "status.upfront": "This site uses upfront billing based on each request's context and max output tokens: when the key's remaining quota cannot cover the upfront charge, the request is rejected, although a minimal verification request may still pass. Use another key, or ask the site to raise this key's quota.",
        "stat.failed": "{count} failed",
        "chart.onlyFailures": "No successful requests in the last 30 days ({count} failed)",
        "models.ctxMeasured": "Measured value ({how}): the site's model list states no context window. Auto-compaction at about {at}.",
        "models.measured.header": "read from response headers",
        "models.measured.error": "read from the error returned when an oversized request was rejected",
        "models.measured.probe": "probed from the site when fetching models",
        "models.measured.search": "the site's errors state no figure; determined by probing step by step for the largest request the site accepts",
        "site.someNoUsage": "Some models report no usage",
        "site.someNoUsageTitle": "The following models' responses include no token usage ({models}): their usage is estimated from text, and the context usage shown by DeepSeek Harness is also its own estimate.",
        "models.noUsage": "No usage reported",
        "models.noUsageTitle": "This model's responses include no token usage: usage shown here is estimated from text.",
        "stat.speed": "Output speed today",
        "stat.ttftTitle": "Time to first token: today {today}, last 30 days {month}",
        "col.speed": "Output speed",
        "col.speedTitle": "Output tokens per second, measured from the first token to the end of output (same method as DeepSeek Harness)",
        "error.hostOutdated": "The plugin page is version {page}, but the host process is still running {host}: restart DeepSeek Harness. Host-side features such as usage statistics and context window probing are updated after the restart.",
        "error.hostOld": "an older version",
        "error.generic": "Operation failed: {message}",
        "error.unavailable": "The plugin host process has not loaded yet: restart the app after installing.",
        "lang.code": "en",
        "lang.en": "English",
        "lang.zh": "Chinese",
        "authn.nav": "Model verification",
        "authn.title": "Model verification",
        "authn.sub": "Checks whether the models a site serves match what it declares: passive monitoring of conversation responses, active tests on demand. Informational only: it never switches sites or keys and never blocks requests.",
        "authn.passive": "Passive monitoring",
        "authn.passiveTitle": "Records metadata of each response in monitored conversations (identifier formats, timing, usage). Sends no extra requests and stores no conversation content.",
        "authn.active": "Active testing",
        "authn.activeTitle": "Allows protocol tests and signature verification to be run manually. Test requests use the site's active API key and count toward usage.",
        "authn.offHint": "Passive monitoring and active testing are both off.",
        "authn.loading": "Loading…",
        "authn.siteTabs": "Sites",
        "authn.results": "Verification results",
        "authn.siteNoModels": "This site has no models yet.",
        "authn.col.model": "Model",
        "authn.col.channel": "Upstream",
        "authn.col.samples": "Samples",
        "authn.samples": "{passive} responses · {probes} tests",
        "authn.samplesTitle": "Passive monitoring: {passive} responses in {sessions} conversations ({failed} failed). Active tests: {probes}.",
        "authn.noRows": "No models have been added to any site.",
        "authn.evidenceCount": "Click to show the measurements and the basis",
        "authn.evidenceHide": "Click to hide",
        "authn.evidenceTitle": "Basis of the verdict",
        "authn.noSamples": "No samples yet",
        "authn.quickTitle": "Protocol test: {requests} small requests",
        "authn.signatureTitle": "Signature verification: {requests} requests (Claude on Anthropic Messages only)",
        "authn.forget": "Clear this model's verification records",
        "authn.forgetConfirm": "Confirm",
        "authn.stop": "Stop test",
        "authn.runTitle": "{kind} in progress: step {step} of {steps} (each request waits up to 90 seconds)",
        "kind.fingerprint": "Knowledge fingerprint",
        "source.fingerprint": "Knowledge fingerprint",
        "dock.run.fingerprint": "Knowledge fingerprint",
        "dock.menuFingerprint": "Knowledge fingerprint · ~{requests} requests (background)",
        "authn.fingerprintTitle": "Knowledge fingerprint: compares with the set \"{set}\" (recorded {date}), about {requests} requests, runs in the background",
        "authn.fingerprintVersionTitle": "Knowledge fingerprint: compares with the set \"{set}\" (recorded {date}), about {requests} requests, runs in the background. The model's version tag differs from the reference model's; the result shows only how the two versions' knowledge differs",
        "authn.fingerprintRunTitle": "Knowledge fingerprint running in the background: step {step} of {steps}. Requests go one at a time, a second apart; it waits on rate limits and pauses while you use this site; after DSH restarts it continues.",
        "confirm.body.fingerprint": "Sends about {requests} requests (10 knowledge questions each) to {model} on {site} with the active API key, about {tokens} tokens{cost}, and compares the answers with the reference model's in the set \"{set}\" ({date}). It runs in the background and can be stopped at any time; if DSH closes, it continues on the next start. Each request counts toward the site's usage as it is sent and is marked as model verification.",
        "confirm.fingerprintNamed": "The reference answers were recorded on {date}. If the model under this name has been updated since, the result shows its difference from the version recorded then.",
        "confirm.fingerprintVariant": "The model checked ({model}) and the reference model ({reference}) carry different version tags. The result shows only how the two versions' knowledge differs and is not used to judge a substitution.",
        "metric.knowledge": "Knowledge fingerprint",
        "metric.knowledge.value": "{verdict}: {mismatch}% differ (the reference's own {self}%, {answered}/{asked} answered) · {set} ({date}) · {time} ago",
        "metric.knowledge.same": "Matches the reference model",
        "metric.knowledge.diff": "Differs from the reference model",
        "metric.knowledge.sameVersion": "Matches the reference version",
        "metric.knowledge.diffVersion": "Differs from the reference version",
        "metric.knowledge.na": "Undetermined",
        "metric.knowledge.ready": "Not run yet (set \"{set}\", recorded {date}, about {requests} requests)",
        "metric.knowledge.readyVersion": "Not run yet (set \"{set}\", recorded {date}, another version than the model checked; about {requests} requests)",
        "metric.knowledge.none": "The rule pack has no set for this model",
        "metric.knowledge.paused": "{next} steps done; continues when active testing is on or DSH restarts",
        "probe.kbfSame": "The knowledge fingerprint matches \"{set}\" (recorded {date}): {mismatch}% of answers differ, the reference model's own repeat {self}% ({answered}/{asked} answered)",
        "probe.kbfSameVersion": "The knowledge fingerprint matches \"{set}\" (recorded {date}, reference version {reference}): {mismatch}% of answers differ, the reference model's own repeat {self}% ({answered}/{asked} answered). The model checked carries another version tag than the reference model",
        "probe.kbfDiff": "The knowledge fingerprint does not match \"{set}\" (recorded {date}): {mismatch}% of answers differ, significantly more than the reference model's own {self}% (p = {p}, {answered}/{asked} answered). The site serves a model other than the reference model, possibly another tier of the same family; if the vendor has updated the model under this name since the recording, the difference may also come from that update",
        "probe.kbfDiffVersion": "The knowledge fingerprint differs significantly from \"{set}\" (recorded {date}, reference version {reference}): {mismatch}% of answers differ, the reference model's own {self}% (p = {p}, {answered}/{asked} answered). The model checked carries another version tag than the reference model; the difference may come from the version change and is not used to judge a substitution",
        "probe.kbfUndetermined": "Too few usable answers ({answered}/{asked}, {coverage}% answered) to decide",
        "probe.kbfTooFew": "No significant difference, but too few usable answers to establish agreement ({answered}/{asked}; at least {need} needed)",
        "probe.kbfNotClose": "No significant difference from \"{set}\" (recorded {date}), but {mismatch}% of answers differ (the reference's own {self}%): not close enough to establish agreement with the reference model",
        "probe.kbfKeyRefused": "The site refused the API key (HTTP {status}); the knowledge fingerprint stopped",
        "panel.spent": "Verification spend (within the retention period): {requests} requests · input {input} · output {output} tokens",
        "rules.fingerprints": "Knowledge-fingerprint sets: {sets} ({name}, {license}, up to {date})",
        "rules.fingerprintsUpstream": "New upstream sets: {sets} (checked {time} ago)",
        "rules.fingerprintsUpstreamError": "Checking upstream sets failed: {error}",
        "rules.fingerprintsCheck": "Check upstream sets",
        "rules.fingerprintsChecking": "Checking…",
        "aset.fingerprintUpstream": "Use sets the KBF authors published that the rule pack has not listed yet",
        "aset.fingerprintUpstreamTitle": "For example the Claude 5.5 sets, once published and before a rule pack update. The rule pack has not checked these sets; their result is at most \"Possible substitution\".",
        "authn.col.identity": "Identity",
        "authn.col.service": "Service",
        "authn.identityTitle": "Identity check: {requests} small requests comparing the tokenizer and the model name returned",
        "identity.unchecked": "Not verified",
        "identity.clean": "No sign of substitution",
        "identity.consistent": "Consistent",
        "identity.confirmed": "Backend verified",
        "identity.suspect": "Possible substitution",
        "identity.substituted": "Not the named model",
        "identity.excluded": "Not included",
        "identity.likely": "Likely: {name}",
        "identityTitle.unchecked": "Nothing yet tells which model this is. Run an identity check (2 small requests comparing the tokenizer); passive monitoring needs enough answers without thinking.",
        "identityTitle.clean": "In passive monitoring, characters per token stay within the model family's range: no sign of substitution. This cannot tell generations or tiers of one family apart.",
        "identityTitle.consistent": "Consistent with the named model: the tokenizer counts the site reports, or the knowledge fingerprint, match it. The counts are the site's own figures and no proof; tiers of one generation (such as Opus and Sonnet) share a tokenizer and cannot be told apart this way.",
        "identityTitle.confirmed": "The thinking signature passed verification by the official Anthropic API: this check's response came from a genuine Claude backend. The tier and version, and where the site sends other requests, are not covered.",
        "identityTitle.suspect": "Signs of substitution were found, but the evidence is not conclusive.",
        "identityTitle.substituted": "Conclusive evidence shows the site does not serve the named model.",
        "identityTitle.excluded": "This site does not take part in model verification (change it in the site settings).",
        "service.insufficient": "Insufficient data",
        "service.ok": "Normal",
        "service.issues": "{count} issue(s)",
        "service.bad": "Serious issues",
        "service.failed": "Check failed",
        "service.excluded": "—",
        "serviceTitle.insufficient": "Not enough responses yet to assess the site's service.",
        "serviceTitle.ok": "No service issues: no canned notices, parameters honoured, no empty responses, tool calls and usage in order.",
        "serviceTitle.issues": "The site's service shows issues, unrelated to the model's identity; see the basis below.",
        "serviceTitle.bad": "Conclusive service problems, such as replayed responses or canned notices instead of model output more than once.",
        "serviceTitle.failed": "The latest protocol check could not be completed (every request failed). A failed request proves neither a fake model nor a sound service.",
        "serviceTitle.excluded": "This site does not take part in model verification (change it in the site settings).",
        "panel.metrics": "Measurements",
        "panel.info": "Notes",
        "panel.none": "No issues",
        "panel.runIdentity": "Run identity check",
        "level.hard": "Conclusive evidence",
        "level.soft": "Possible, not conclusive",
        "level.info": "Note; does not affect the verdict",
        "basis.site": "Site-reported",
        "basis.observed": "Observed",
        "basis.statistical": "Statistical",
        "basis.verified": "Official check",
        "basisTitle.site": "Rests on what the site reports of itself (model name, usage counts, its log); a site can report anything.",
        "basisTitle.observed": "Rests on what the plugin saw the responses do.",
        "basisTitle.statistical": "A comparison over many responses: a hint with an error rate, affected by load, length and topic.",
        "basisTitle.verified": "Checked by the official Anthropic API, within the scope stated.",
        "level.pass": "Passed",
        "metric.echo": "Model name returned",
        "metric.echo.value": "{value} ({n} of {total})",
        "metric.echo.na": "Responses carry no model name",
        "metric.cpt-en": "Characters per token (English)",
        "metric.cpt-zh": "Characters per token (Chinese)",
        "metric.cpt.value": "{value} ({family} range {low}–{high}, {n} answers)",
        "metric.cpt.valueNoBand": "{value} ({n} answers; no reference range in the rule pack)",
        "metric.cpt.na": "Not enough answers ({n}/{need}; only answers without tool calls whose thinking, if any, is counted apart)",
        "metric.tokenizer": "Tokenizer (identity check)",
        "metric.tokenizer.value": "Difference {delta} · {group} ({time} ago)",
        "metric.tokenizer.na": "No identity check yet",
        "metric.signature": "Thinking signatures",
        "metric.signature.value": "{signed} of {total} answers with thinking carry a signature",
        "metric.signature.verified": "Verified by the official Anthropic API",
        "metric.signature.consistent": "Accepted by another site (no proof)",
        "metric.signature.na": "No answers with thinking yet",
        "metric.upstream": "Upstream (recent)",
        "metric.upstream.na": "Not identified yet",
        "metric.speed": "Output speed",
        "metric.speed.value": "{value} tokens/s (recent median, {n} answers)",
        "metric.ttft": "Time to first token",
        "metric.ttft.value": "{value} s (recent median)",
        "metric.stub": "Canned notices",
        "metric.empty": "Empty responses",
        "metric.count": "{n} of {total}",
        "metric.tools": "Invalid tool calls",
        "metric.tools.value": "{bad} of {calls}",
        "metric.tools.na": "No tool calls yet",
        "metric.usage": "Reported input / local estimate",
        "metric.usage.value": "{value} (normal {low}–{high})",
        "metric.usage.na": "Not enough answers ({n}/{need})",
        "metric.na": "Not enough data",
        "metricStatus.ok": "Normal",
        "metricStatus.warn": "Anomaly",
        "metricStatus.bad": "Mismatch",
        "metricStatus.na": "Not enough data",
        "metricStatus.info": "For reference",
        "kind.identity": "Identity check",
        "source.identity": "Identity check",
        "dock.run.identity": "Identity check",
        "dock.menuIdentity": "Identity check · {requests} requests",
        "dock.identity": "Identity",
        "dock.service": "Service",
        "dock.upstream": "Upstream",
        "dock.passive": "Passive monitoring",
        "dock.active": "Active testing",
        "dock.passiveValue": "{here} here · {all} in all",
        "dock.activeValue": "{kind} · {time} ago",
        "dock.activeFailed": "{kind} could not be completed · {time} ago",
        "dock.activeRun": "{kind} running {step}/{steps}",
        "dock.hint": "Click for actions · details in Custom → Model verification",
        "confirm.body.identity": "Sends {requests} small requests with fixed texts to {model} on {site} with the active API key, about {tokens} tokens{cost}, to compare its tokenizer and the model name it returns. The usage counts toward the site and is marked as model verification.",
        "ev.echoVersion": "Asked for {asked}; the site returned the model name {echo} (another version of the tier, {n} times)",
        "probe.echoVersion": "Asked for {asked}; the model name returned is {echo} (another version of the tier)",
        "probe.echoArn": "The model name returned is an AWS Bedrock inference profile ARN, which names no model",
        "probe.tokenizerMatch": "The tokenizer count the site reports matches {group} (difference {delta})",
        "probe.tokenizerAmbiguous": "The tokenizer count the site reports matches {group}, and also {others} (difference {delta}): consistent, not exclusive",
        "probe.tokenizerGeneration": "The tokenizer count the site reports matches {likely} (difference {delta}), while the named model has {expected}: possibly another generation from the same vendor",
        "probe.tokenizerOther": "The tokenizer matches {likely} (difference {delta}), while the named model has {expected}: possibly a substitute model, or the site counts usage itself",
        "probe.tokenizerUnknown": "The tokenizer (difference {delta}) does not match {expected} (difference {want}) of the named model, nor any tokenizer on record: possibly a model not on record, or the site counts usage itself",
        "probe.tokenizerFamily": "The tokenizer matches {likely} (difference {delta}), outside the named model's family: possibly a substitute model, or the site counts usage itself",
        "probe.tokenizerNoRef": "The rule pack has no tokenizer reference for this model yet (difference {delta}; closest: {likely})",
        "probe.tokenizerNoUsage": "The site returned no input token usage: the tokenizer cannot be compared",
        "probe.tokenizerNoPack": "The rule pack in use has no tokenizer references",
        "channel.unknown": "Unidentified",
        "channel.unknownTitle": "The responses carry no feature that identifies the upstream yet.",
        "channel.via": "{upstream} (via {relay})",
        "source.passive": "Monitoring",
        "source.quick": "Protocol test",
        "source.signature": "Signature",
        "kind.quick": "protocol test",
        "kind.signature": "signature verification",
        "ev.withNote": "{text} ({note})",
        "ev.channelDrift": "Responses alternate between {a} and {b}: the site mixes backends of different vendors",
        "ev.channelHosts": "Responses alternate between {a} and {b}: both host the same vendor's models (a relay's account pool or provider routing)",
        "ev.replay": "{n} response(s) repeat an earlier response's ID and content: replayed or cached, not newly generated",
        "ev.idSynth": "Different responses share one ID: the site generates its own response IDs",
        "ev.fixedAnswer": "Identical responses to different requests ({n}): the site returns fixed content",
        "ev.sameOpening": "Responses to different requests open the same way ({n}); older records keep only the opening: possibly a template",
        "ev.stub": "{n} response(s) are a site's canned notice rather than model output",
        "ev.echoMismatch": "Requested {asked}; the site reported {echo} ({n} times)",
        "ev.echoDrift": "The reported model identifier changes: {a} / {b}",
        "ev.stitched": "{n} response(s) were assembled from frames with different IDs",
        "ev.speedUp": "Output speed rose markedly: {now} tok/s (previously {base})",
        "ev.speedDown": "Output speed dropped markedly: {now} tok/s (previously {base})",
        "ev.cptBand": "{lang} responses average {value} characters per token, outside {family}'s typical {low}–{high}: a different tokenizer (possibly another model), or usage computed by the site ({n} responses)",
        "ev.cptDrift": "{lang} characters per token changed from {base} to {now}: possibly another tokenizer",
        "ev.inputHigh": "Reported input tokens are {ratio}× the estimate of what was sent ({n} responses): usage may be inflated",
        "ev.inputLow": "Reported input tokens are only {ratio}× the estimate of what was sent ({n} responses): the site may truncate the context",
        "ev.toolHealth": "{bad} of {calls} tool calls invalid (malformed JSON, missing required fields or unknown tools)",
        "ev.empty": "{n} of {total} responses empty or reasoning-only",
        "ev.overMax": "{n} response(s) exceeded the requested output limit",
        "ev.contextEarly": "Rejected as too long at about {est} tokens, far below the declared {context} context window",
        "ev.signatureStripped": "Reasoning arrives without signatures ({n} responses): signature verification is not possible on this site",
        "probe.requestFailed": "Request failed ({status}): {error}",
        "probe.runFailed": "The test failed to run: {error}",
        "probe.replay": "Two requests returned the same ID and content ({id}…): replayed or cached",
        "probe.sameId": "Two requests returned the same ID ({id}…): the site generates its own IDs",
        "probe.uniqueId": "The two responses have distinct IDs",
        "probe.noId": "The responses carry no ID",
        "probe.shortId": "Response IDs ({id}…) are short counters (common on local servers) and are not compared",
        "probe.echoMismatch": "Requested {asked}; reported {echo}",
        "probe.echo": "Reported model: {echo}",
        "probe.maxTokens": "max_tokens ({limit}) applied; the response was truncated",
        "probe.maxTokensEmpty": "The response was empty: whether max_tokens ({limit}) applies cannot be judged",
        "probe.maxTokensShort": "The response ended ({output} tokens) before reaching max_tokens ({limit}): cannot be judged",
        "probe.maxTokensIgnored": "max_tokens ({limit}) not applied: finish reason {finish}, {output} output tokens",
        "probe.stopRefused": "The site does not accept the stop parameter: {error}",
        "probe.stopIgnored": "The stop parameter had no effect (not passed on by the site)",
        "probe.stop": "The stop parameter applied",
        "probe.stopEmpty": "The response did not count up to the stop sequence: whether stop applies cannot be judged",
        "probe.toolMissing": "A tool call was required, but the response contains none",
        "probe.toolMissingAuto": "The site rejects forced tool calls; offered optionally, the tool was not called",
        "probe.toolArgs": "Invalid tool call arguments: {args}",
        "probe.tool": "Tool call valid (ID prefix {prefix}…)",
        "probe.toolAuto": "The site rejects forced tool calls; offered optionally, the call was valid (ID prefix {prefix}…)",
        "probe.image": "Identified the test image's colour",
        "probe.imageWrong": "Did not identify the test image's colour: {answer}",
        "sig.redacted": "Only redacted reasoning was returned; the signature cannot be verified",
        "sig.noThinking": "No reasoning was returned; the signature cannot be verified",
        "sig.stripped": "The site strips thinking signatures; nothing to verify",
        "sig.checked": "The tampered signature was rejected and the original accepted: the backend verifies signatures",
        "sig.refusesAll": "Both the tampered and the original signature were rejected ({status})",
        "sig.notChecked": "The tampered signature was accepted: no signature verification behind this site",
        "sig.verified": "This site's signature passed verification by the official Anthropic API ({peer}): this check's response came from a genuine Claude backend (tier, version and other requests not covered)",
        "sig.peerAccepted": "{peer} accepted this site's signature. That site was seen rejecting tampered signatures, but a relay station's acceptance is no proof and does not change the verdict",
        "sig.forged": "This site's signature failed {peer}'s verification: forged",
        "sig.peerFailed": "{peer} could not complete the verification ({status})",
        "sig.peerBound": "{peer} rejected the block as bound to another account, conversation or model: inconclusive",
        "dock.title": "Model verification",
        "dock.aria": "Model verification: {verdict}",
        "dock.notCustomShort": "Not applicable",
        "dock.notCustom": "This conversation's model does not go through the Custom plugin and cannot be verified",
        "dock.trackedHere": "This conversation is monitored (responses through Custom are recorded)",
        "dock.line": "{label}: {value}",
        "dock.group": "(switch group {group})",
        "dock.passiveOff": "This conversation is not monitored",
        "dock.passiveDisabled": "Off",
        "dock.activeDisabled": "Off",
        "dock.excluded": "This site does not take part in model verification",
        "dock.activeNone": "None yet",
        "dock.rules": "Rule pack {version}",
        "dock.run": "{kind} {step}/{steps}",
        "dock.run.quick": "Protocol test",
        "dock.run.signature": "Signature",
        "dock.menuPassive": "Monitor this conversation (response metadata only)",
        "dock.menuActive": "Active testing",
        "dock.menuQuick": "Protocol test · {requests} requests",
        "dock.menuSignature": "Signature verification · {requests} requests",
        "dock.menuCancel": "Stop the test",
        "dock.menuPage": "Details: Custom tab → Model verification",
        "dock.fallbackPassive": "{label}: {state}",
        "dock.on": "On",
        "dock.off": "Off",
        "confirm.title": "Run a {kind}?",
        "confirm.body.quick": "Sends {requests} small requests to {model} on {site} with the active API key, about {tokens} tokens{cost}. The usage counts toward the site's usage and is marked as verification.",
        "confirm.body.signature": "Sends about {requests} requests to {model} on {site} with the active API key (one with reasoning), about {tokens} tokens{cost}. Where another site's backend has been confirmed to verify signatures, this site's signature (from the test request, no conversation content) is also sent there for verification. The usage counts toward the site's usage and is marked as verification.",
        "confirm.cost": " (about {cost})",
        "confirm.max": "At most {requests} requests{cost}.",
        "confirm.maxCost": ", up to about {cost}",
        "confirm.peers": "The cross-site check may also send up to {n} requests to {sites}; they count toward those sites' usage.",
        "confirm.peerSep": ", ",
        "confirm.run": "Run",
        "confirm.cancel": "Cancel",
        "rules.title": "Rule pack",
        "rules.version": "{version} · published {published}",
        "rules.builtin": "Built-in",
        "rules.online": "Downloaded",
        "rules.check": "Check for updates",
        "rules.checking": "Checking…",
        "rules.rollback": "Revert to built-in",
        "rules.notConfigured": "Online updates are not available yet (the data repository has not been published).",
        "rules.checkedAt": "Last checked {time} ago",
        "rules.error": "Last check failed: {error}",
        "rules.hint": "The rule pack contains judgement data only (upstream features, canned notices, model families, test wording); the plugin reads it and never executes it. A downloaded pack must carry the publisher's signature.",
        "aset.title": "Settings",
        "aset.group.passive": "Passive monitoring",
        "aset.group.active": "Active testing",
        "aset.group.rules": "Rule pack",
        "aset.group.data": "Display and data",
        "aset.dock": "Show verification status in the conversation status bar",
        "aset.dockTitle": "The shield, eye and radar icons beside the context bar",
        "aset.passiveDefault": "Monitor new conversations by default",
        "aset.passiveDefaultTitle": "Passive monitoring sends no extra requests; it records identifier formats, timing and counts of responses, never their content. Each conversation can be switched from its status bar.",
        "aset.confirm": "Confirm request count and cost before running",
        "aset.confirmTitle": "Shows the number of requests and the estimated cost first",
        "aset.crossSite": "Allow cross-site signature verification",
        "aset.crossSiteTitle": "Only signatures produced by test requests are sent, never those of conversations.",
        "aset.autoIdentity": "Run an identity check automatically when passive monitoring doubts a model's identity",
        "aset.autoIdentityTitle": "Takes effect only while active testing is on. Each check sends 2 small requests with fixed texts and counts toward the site's usage. While the doubt persists, the same model is checked again after the interval below.",
        "aset.autoInterval": "Minimum interval per model",
        "aset.autoInterval.30": "30 minutes",
        "aset.autoInterval.60": "1 hour",
        "aset.autoInterval.120": "2 hours",
        "aset.autoInterval.360": "6 hours",
        "aset.autoInterval.720": "12 hours",
        "aset.autoInterval.1440": "24 hours",
        "aset.autoDaily": "Automatic checks per day (all models)",
        "aset.autoDaily.option": "{n} checks",
        "metric.input-ratio": "Input tokens (reported / estimated)",
        "metric.input-ratio.value": "{value} (recent median, {n} requests)",
        "metric.input-ratio.na": "Not enough requests ({n}/{need})",
        "metric.speed.hidden": "Answers carry thinking not counted apart ({hidden}); speed cannot be measured",
        "ev.inputStep": "Within a conversation, reported input tokens over the local estimate went from {from} to {to} ({change}%) and stayed there: the tokenizer changed, so the model was possibly switched midway (or the relay moved to another account pool)",
        "ev.cleared": "Ruled out by a later identity check",
        "ev.attemptFailed": "The latest check could not be completed ({status} {error}); the verdict rests on earlier results",
        "source.auto": "{source} (automatic)",
        "dock.activeValueAuto": "{kind} (automatic) · {time} ago",
        "aset.autoUpdate": "Update the rule pack automatically",
        "aset.autoUpdateTitle": "Checked once a day while model verification is on; packs without a valid signature are rejected.",
        "aset.keepDays": "Retention (days)",
        "aset.keepDaysTitle": "Monitoring records and test results older than this are deleted (1–365)",
        "aset.source": "Update source",
        "aset.source.github": "GitHub",
        "aset.source.jsdelivr": "jsDelivr",
        "aset.source.custom": "Custom URL",
        "aset.customUrl": "URL (https, serving pack.json and pack.json.sig)",
        "aset.clearAll": "Clear all verification records",
        "aset.clearConfirm": "Click again to confirm",
        "site.authn": "Take part in model verification",
        "site.authnTitle": "When off, this site's responses are not monitored and no tests are run on it.",
        "models.rowProbes": "{count} of them were verification requests",
      },
      zh: {
        "tab.label": "Custom",
        "head.title": "自定义 API 站点",
        "head.add": "添加站点",
        "head.validate": "全部校验",
        "head.validating": "校验中…",
        "head.validateHint": "逐一校验所有 Key：确认站点是否接受该 Key，并使用站点的首个模型发送一次极小的真实请求",
        "head.funds": "刷新余额",
        "head.fundsing": "刷新中…",
        "head.fundsHint": "重新查询各站点向 Key 开放的余额（不产生费用）；打开本标签页时、每 5 分钟及每次请求后也会自动刷新",
        "empty": "尚未添加站点。支持添加中转站、聚合网关及本地服务（OpenAI / Anthropic 协议）。",
        "site.switch": "启用",
        "site.switchTitle": "停用后，该站点的模型将不再显示在底部的模型选择栏中（Key 与模型配置均保留）",
        "site.modelsTitle": "该站点在模型选择栏中提供的模型",
        "site.addKey": "添加 Key",
        "site.remove": "删除站点",
        "site.removeConfirm": "确认删除该站点及其全部 Key？",
        "site.keyless": "无需 Key",
        "site.noUsage": "不返回用量",
        "site.noUsageTitle": "该站点的响应不包含 token 用量：DeepSeek Harness 显示的上下文占用与输出速度均为其自行估算，今日用量仅统计请求次数。",
        "site.keylessTitle": "本地服务无需 Key：请求将不携带 Key 发送",
        "http.warn": "该地址为公网 http 地址，传输未加密。API Key 与完整对话内容将以明文经互联网传输，沿途的运营商、公共 Wi-Fi 或代理均可读取，并可篡改模型响应——包括 DSH 将在本机执行的工具调用。站点支持 https 时，请使用 https。",
        "http.httpsWorks": "该站点同时支持 https 访问。",
        "http.useHttps": "改用 https",
        "http.confirm": "我已知晓该站点未加密，仍使用 http 连接",
        "http.confirmFirst": "请先在上方确认使用未加密的 http",
        "http.publicTitle": "未加密：Key 与对话内容以明文经互联网传输",
        "http.privateTitle": "本机或局域网 http 地址",
        "http.direct": "未设置 HTTP_PROXY：直接连接（HTTPS_PROXY 对 http 不生效）",
        "http.proxied": "通过 HTTP_PROXY / ALL_PROXY 代理连接",
        "site.noKeys": "尚未添加 Key",
        "site.publicList": "该站点的模型列表接口不校验 Key：请点击 ✓ 发送一次极小请求以确认 Key 可用",
        "col.status": "状态",
        "col.balance": "余额",
        "col.usage": "今日用量",
        "status.ok": "可用",
        "status.valid": "Key 有效",
        "status.validHint": "站点已接受该 Key；可点击 ✓ 发送一次极小请求，确认模型可正常响应",
        "status.unproven": "未确认",
        "status.unprovenHint": "该站点的模型列表接口不校验 Key：请点击 ✓ 发送一次极小请求进行确认",
        "status.probed": "{time}前经 {model} 实测可用",
        "status.probeError": "上次测试请求未得出结论：{message}",
        "status.unknown": "未校验",
        "status.no-balance": "余额不足",
        "status.plan-quota": "额度已用尽",
        "status.invalid": "Key 无效",
        "status.expired": "已过期",
        "status.restricted": "仅限特定客户端",
        "status.restrictedHint": "站点仅允许指定客户端（如 Claude Code）使用该 Key，本插件的请求会被拒绝。请改用站点其他分组的 Key。",
        "status.error": "校验失败",
        "status.held": "暂停至 {time}",
        "status.lastError": "上次校验失败：{message}",
        "status.checked": "上次检查：{time}前",
        "status.never": "从未检查",
        "status.manual": "Key 仅支持手动切换：如需使用其他 Key，请点击「设为当前」",
        "key.copy": "复制 Key",
        "key.copied": "已复制",
        "key.active": "当前使用",
        "key.switch": "设为当前",
        "key.validate": "校验 Key（发送一次极小请求）",
        "key.funds": "刷新余额",
        "key.noFunds": "该站点未向 Key 开放余额查询",
        "key.edit": "重命名",
        "key.remove": "删除",
        "key.removeConfirm": "确认删除",
        "key.drag": "拖动以排序（或使用 ↑ ↓）",
        "balance.none": "—",
        "balance.credits": "{amount} credits",
        "balance.creditsTitle": "剩余 Hypercredits ≈ {usd}（1 credit = $0.05）",
        "balance.unlimited": "无限额度",
        "balance.used": "已用 {amount}",
        "balance.keyScope": "该 Key 在站点上的令牌额度（非账户余额）",
        "balance.accountScope": "站点账户余额（通过该 Key 读取）",
        "balance.tokenLine": "该 Key 的令牌额度：剩余 {left}，已用 {used}",
        "balance.tokenUnlimited": "该 Key 的令牌额度：无限，已用 {used}",
        "balance.accountHint": "此处为该 Key 的令牌额度。如需显示账户余额，请在站点的令牌设置中开启「允许查询账户额度」。",
        "balance.billing": "计费倍率 ×{rate}",
        "balance.billingPeak": "计费倍率 ×{rate}；高峰时段 {start}–{end} ×{peak}（{zone}）",
        "balance.accountEmpty": "站点已拒绝请求：账户余额不足（此处显示的是该 Key 的令牌额度）。充值后发送一条消息或点击 ✓ 即可恢复",
        "balance.expires": "{time} 到期",
        "balance.plan": "套餐：{name}",
        "balance.window": "{window}限额：已用 {used} / {limit}",
        "balance.windowAt": "{window}限额：已用 {used} / {limit}，{time} 重置",
        "balance.windowLeft": "{window}限额剩余",
        "balance.window.5h": "5 小时",
        "balance.window.1d": "每日",
        "balance.window.claude7d": "Claude 每周",
        "balance.window.rate": "限流窗口",
        "balance.rateRequests": "限流窗口（{minutes} 分钟）：已用 {used} / {limit} 次请求",
        "balance.rateTokens": "限流窗口（{minutes} 分钟）：已用 {used} / {limit} tokens",
        "balance.clients": "仅限客户端：{clients}",
        "balance.concurrency": "并发上限：{n}",
        "relay.title": "站点记录",
        "stat.requestsCount": "{count} 次请求",
        "relay.today": "今日站点扣费",
        "relay.d7": "7 天",
        "relay.d30": "30 天",
        "relay.month": "本月",
        "relay.sourceLog": "读取自站点为这些 Key 记录的调用日志：站点对这些 Key 的全部扣费，包括使用它们的其他客户端，自 {time} 起。",
        "relay.sourceStats": "读取自站点对这些 Key 的用量统计（包括使用它们的所有客户端）。",
        "relay.partial": "两次读取之间请求超过 1,000 条，部分日志未读到，此数字低于实际扣费。",
        "relay.read": "{time}前读取",
        "relay.notRead": "尚未读取：请点击「刷新余额」。",
        "relay.key": "{key}",
        "relay.group": "分组 {group}",
        "relay.groupTitle": "该 Key 在站点上所在的分组（读取自站点日志），模型价格按此分组计算。",
        "relay.subscription": "订阅「{title}」：剩余 {remain} / {total}",
        "relay.logError": "日志读取失败：{error}",
        "relay.account": "账户",
        "relay.accountValue": "剩余 {amount} · 已用 {used}",
        "relay.accountGroup": "分组 {group}",
        "relay.accountDenied": "账户访问令牌被拒绝（已过期、已吊销或缺少读取权限）。",
        "relay.accountOrigin": "账户访问令牌是为该站点的其他地址设置的，不会发送至当前地址，请重新设置。",
        "relay.accountError": "账户读取失败：{error}",
        "relay.subLine": "订阅：已用 {used} / {total}{end}",
        "relay.subEnd": "，{time} 到期",
        "relay.accountToken": "账户访问令牌（只读）",
        "relay.accountHint": "可选。在站点的账户设置中创建个人访问令牌，仅勾选「个人资料：查看」「用量：查看」「钱包：查看」。仅用于从该站点读取账户余额与订阅，不会发往其他地址，保存后不再显示。旧版系统访问令牌需同时填写用户 ID，其权限为整个账户。",
        "relay.tokenPlaceholder": "粘贴令牌",
        "relay.userId": "用户 ID（仅旧版系统访问令牌需要）",
        "relay.tokenSet": "已设置（{masked}）",
        "relay.save": "保存",
        "relay.remove": "移除",
        "relay.plaza": "模型广场：{groups} 个分组",
        "relay.plazaTitle": "模型价格读取自站点的模型广场，并按该 Key 的计费倍率计算。",
        "relay.perf": "性能指标：{models} 个模型",
        "relay.perfTitle": "站点自报的各模型成功率、延迟与输出速度（近 24 小时），显示在「模型核验」中。",
        "models.billedTitle": "站点实际扣费：{billed}；插件估算：{estimate}",
        "price.perRequest": "按次 {price}",
        "price.group": "分组 {group}",
        "price.rate": "倍率 ×{rate}",
        "price.peak": "高峰时段 {start}–{end} ×{multiplier}",
        "price.expr": "站点对该模型按阶梯计费，估算按基础价计算（实际扣费以站点记录为准）",
        "price.estimated": "未找到该 Key 所在分组的价格，按官方价 × 倍率估算",
        "edit.served": "站点支持的协议：{protocols}",
        "metric.site-log": "站点日志（new-api）",
        "metric.site-log.value": "已读取 {n} 次请求：模型映射 {mapped} 种，返回模型不符 {returned} 种，系统提示词被改写 {overwritten} 次",
        "metric.site-log.na": "未读取（仅 new-api 站点，且需开启被动监测）",
        "ev.relayMapped": "站点日志记录：该模型被映射为 {upstream}（{total} 次请求中 {n} 次）",
        "ev.relayVariant": "站点日志记录：以 {upstream} 提供（同一模型的变体，{total} 次请求中 {n} 次）",
        "ev.relayReturned": "站点日志记录：上游返回的模型为 {returned}（{total} 次请求中 {n} 次）",
        "ev.relayPrompt": "站点日志记录：站点改写了系统提示词（{total} 次请求中 {n} 次）",
        "source.site-log": "站点日志",
        "panel.sitePerf": "站点自报（24 小时）：成功率 {success}，平均延迟 {latency}，输出 {tps} tokens/s",
        "balance.window.7d": "7 天",
        "balance.window.30d": "每月",
        "balance.siteToday": "站点统计的今日用量：{requests} 次请求，{tokens} tokens，{cost}",
        "funds.failed": "余额查询失败",
        "funds.failedLine": "{label}：{error}",
        "list.sep": "、",
        "usage.today": "{requests} 次 · {tokens}",
        "usage.none": "—",
        "usage.cost": "≈{cost}",
        "usage.month": "本月：{requests} 次请求，{tokens} tokens，≈{cost}",
        "usage.quotaNote": "（按站点额度计价）",
        "dialog.addTitle": "添加站点",
        "dialog.id": "Provider ID",
        "dialog.idHint": "须以小写字母开头，仅可包含小写字母、数字和连字符；用作线路名称（groups 与 constructor 为保留名称）",
        "dialog.name": "显示名称",
        "dialog.baseUrl": "API 地址",
        "dialog.protocol": "API 协议",
        "dialog.keys": "API Key",
        "dialog.keysPlaceholder": "请输入 API Key（多个 Key 请每行填写一个）",
        "dialog.keyless": "无需 Key（本地服务）",
        "dialog.advanced": "高级设置",
        "dialog.headers": "请求头",
        "dialog.headersPlaceholder": "名称: 值（每行一个）",
        "dialog.defaultContext": "默认上下文窗口（K tokens）",
        "dialog.defaultContextTitle": "适用于站点未提供上下文窗口且未手动修改过的模型（参考目录中的数值更大时，同样以此值为准）。DeepSeek Harness 会在占用约 80% 时自动压缩。留空则为 {value}K，小于 DeepSeek Harness 的内置默认值（1M），以避免中转站实际提供的上下文窗口不足时压缩过晚。",
        "dialog.imageBudget": "图片总额度（MB）",
        "dialog.imageBudgetTitle": "单次请求中所有图片（base64）的总大小上限。超出时，DeepSeek Harness 会将最早的图片替换为文字说明。站点限制请求体大小（返回 413）时，请调低此值。留空则为 {value} MB。",
        "dialog.imageMaxBytes": "单张图片上限（KB）",
        "dialog.imageMaxBytesTitle": "每张图片在发送前将压缩至此大小以内。留空则为 {value} KB。",
        "dialog.learned": "因站点返回 413，图片总额度已自动下调至 {size}",
        "dialog.learnedReset": "重置",
        "dialog.catalog": "模型目录",
        "dialog.fetch": "获取可用模型",
        "dialog.fetching": "获取中…",
        "dialog.fetchFirst": "请点击「获取可用模型」，或手动输入模型 ID",
        "dialog.found": "{platform} · {count} 个模型",
        "dialog.keyRejected": "站点拒绝了该 Key",
        "dialog.manual": "模型 ID",
        "dialog.manualAdd": "添加",
        "dialog.save": "保存",
        "dialog.saving": "保存中…",
        "dialog.cancel": "取消",
        "dialog.selected": "已选择 {count} 个",
        "models.addChosen": "添加所选（{count}）",
        "models.remove": "移除",
        "models.edit": "编辑",
        "models.search": "搜索",
        "models.all": "全选",
        "models.none": "取消全选",
        "models.close": "关闭",
        "models.context": "{k}k",
        "models.contextM": "{m}M",
        "models.image": "图片",
        "models.textOnly": "仅文本",
        "models.textOnlyTitle": "站点曾拒绝该模型的图片输入，DSH 已改为发送图片的文字说明。如需重试，请在模型编辑中勾选「图片输入」",
        "models.ctxCapped": "参考目录标注为 {listed}；站点未提供上下文窗口，按站点默认值 {applied} 计（可在模型编辑中修改）。上下文达到约 {at} 时自动压缩。",
        "models.ctxReference": "站点未提供上下文窗口，按参考目录计。上下文达到约 {at} 时自动压缩。",
        "models.ctxDefault": "站点与参考目录均未提供该模型的上下文窗口，按站点默认值计。上下文达到约 {at} 时自动压缩。",
        "models.ctxKnown": "上下文达到约 {at} 时自动压缩。",
        "models.ctxSuggested": "站点建议将上下文控制在 {suggested} 以内（其官方客户端在此处压缩）；如需降低单次请求的用量，可将上下文窗口设为该值。",
        "models.thinking": "思考",
        "models.free": "免费",
        "models.price": "${input}/${output}",
        "models.quotaPrice": "额度 {symbol}{input}/{symbol}{output}",
        "models.priceTitle": "每百万 tokens 价格：输入 / 输出",
        "models.quotaPriceTitle": "每百万 tokens 的站点额度价格（按站点倍率及默认分组计算）",
        "models.unusable": "不可用",
        "models.switch": "切换受限",
        "models.switchTitle": "DSH 不允许在对话中途切换至该模型：其上下文窗口无法容纳 DSH 默认的压缩预留量（65,536 tokens）。该模型可在新对话中使用，但 DSH 不会为其提前自动压缩，长对话可能超出上下文窗口。",
        "groups.switchTitle": "DSH 不允许在对话中途切换至该切换组：所选成员的上下文窗口无法容纳 DSH 默认的压缩预留量（65,536 tokens）。该切换组可在新对话中使用，但 DSH 不会为其提前自动压缩。",
        "protocol.geminiGone": "Google Gemini（已停止支持：请通过 Intl_Ex 插件使用 Gemini，或将该站点改为 OpenAI 兼容协议）",
        "platform.generic": "OpenAI 兼容",
        "models.reference": "已按模型 ID 从参考目录补全信息",
        "models.manual": "未找到该模型的信息：已使用默认值（可编辑）",
        "edit.title": "模型 — {id}",
        "edit.name": "显示名称",
        "edit.protocol": "协议",
        "edit.protocolSite": "跟随站点（{protocol}）",
        "edit.context": "上下文窗口（tokens）",
        "edit.output": "最大输出（tokens）",
        "edit.image": "图片输入",
        "edit.reasoning": "推理强度",
        "edit.off": "支持关闭思考",
        "edit.noReasoning": "不支持推理参数",
        "edit.format": "推理参数格式",
        "edit.formatAuto": "跟随站点平台",
        "edit.format.effort": "reasoning_effort",
        "edit.format.openrouter": "reasoning: { effort }",
        "edit.format.deepseek": "thinking: { type }（DeepSeek）",
        "edit.format.qwen": "enable_thinking（Qwen）",
        "edit.format.none": "不发送",
        "edit.replay": "每轮回传思考内容",
        "edit.reset": "恢复为站点提供的信息",
        "edit.save": "保存",
        "edit.cancel": "取消",
        "key.addTitle": "添加 Key — {name}",
        "key.addPlaceholder": "每行填写一个 Key",
        "key.label": "名称（可选）",
        "key.add": "添加",
        "key.adding": "添加中…",
        "key.renameTitle": "重命名 {masked}",
        "groups.title": "切换组",
        "groups.titleHint": "在模型选择栏中显示为一个条目，由选定的成员提供服务；不会自动切换",
        "groups.add": "新建切换组",
        "groups.edit": "编辑",
        "groups.remove": "删除",
        "groups.removeConfirm": "确认删除",
        "groups.missing": "（模型已移除）",
        "groups.siteOff": "（站点已停用）",
        "group.addTitle": "新建切换组",
        "group.editTitle": "切换组 — {name}",
        "group.name": "在模型选择栏中显示的名称",
        "group.members": "成员（不同站点上的同一模型）",
        "group.save": "保存",
        "group.cancel": "取消",
        "group.pick": "请至少选择一个站点上的模型",
        "card.summary": "{count} 个 Key · 当前使用：{key}（{state}）",
        "card.none": "该站点尚未添加 Key",
        "card.group": "{count} 个切换组",
        "time.days": "{d}天{h}小时",
        "time.hours": "{h}小时{m}分",
        "time.minutes": "{m}分钟",
        "time.now": "不足 1 分钟",
        "nav.overview": "总览",
        "nav.sites": "站点",
        "nav.off": "已停用",
        "nav.dragHint": "拖动（或按 Alt+↑ ↓）调整顺序，该顺序即模型选择栏中的顺序",
        "overview.sub": "共 {count} 个站点，已启用 {on} 个",
        "add.site": "站点",
        "add.sub": "支持中转站、聚合网关及本地服务（OpenAI / Anthropic 协议）",
        "stat.requests": "今日请求数",
        "stat.tokens": "今日 Token",
        "stat.hit": "今日缓存命中率",
        "stat.cost": "今日估算费用",
        "stat.d30": "近 30 天：{value}",
        "chart.title": "近 30 天 Token 用量",
        "chart.label": "近 30 天每日 Token 用量",
        "chart.empty": "暂无用量记录（自 0.4.0 版起开始记录）",
        "chart.today": "今日",
        "chart.tipRequests": "{requests} 次请求 · {tokens} tokens",
        "chart.tipNone": "无请求",
        "chart.tipSplit": "输入 {input} · 缓存命中 {cache} · 输出 {output}",
        "usage.costTitle": "按当前价格估算：优先采用模型上手动设置的价格，其次采用站点提供的价格；站点自行报告费用的，以站点数据为准。未设置价格的模型仅统计 Token。",
        "usage.costReported": "其中包含站点自行报告的费用。",
        "usage.costQuota": "其中包含按中转站额度价格（按站点倍率）计算的费用，以站点显示的币种计。",
        "usage.costUnpriced": "部分模型未设置价格，其 Token 未计入费用（可点击模型上的 ✎ 设置价格）。",
        "usage.estimatedNote": "≈ 含估算值：对不返回用量的站点，按发送与接收的文本估算（不含图片）。",
        "usage.estimatedTag": "含估算值",
        "col.site": "站点",
        "col.keyInUse": "当前使用的 Key",
        "col.d30": "近 30 天",
        "col.cost30": "费用（近 30 天）",
        "col.model": "模型",
        "col.context": "上下文",
        "col.requests": "请求数",
        "col.input": "输入",
        "col.cache": "缓存命中",
        "col.output": "输出",
        "col.hitRate": "命中率",
        "col.cost": "费用",
        "sites.open": "打开 {name}",
        "keys.title": "API Key",
        "site.verify": "校验",
        "site.verifyHint": "逐一校验本站点的所有 Key：确认站点是否接受该 Key，并使用首个模型发送一次极小的真实请求",
        "models.tableTitle": "模型与用量",
        "models.add": "添加模型",
        "models.addTitle": "添加模型 — {name}",
        "models.allAdded": "站点列出的模型均已添加",
        "models.noneListed": "站点未列出对话模型：请在下方手动输入模型 ID",
        "models.removeConfirm": "确认移除",
        "models.total": "合计",
        "models.empty": "尚未添加模型：请点击「添加模型」添加站点上的模型",
        "models.rowAvgInput": "平均每次请求输入 {value}（约等于对话的上下文占用）",
        "models.rowTtft": "首字延迟 {value}",
        "models.rowSpeed": "输出速度 {value} tokens/秒",
        "models.rowFailures": "失败 {count} 次",
        "models.priceUser": "价格（手动设置，每百万 tokens 输入 / 输出）：{price}",
        "models.priceSite": "价格（站点提供，每百万 tokens 输入 / 输出）：{price}",
        "models.priceQuota": "价格（中转站额度价，每百万 tokens 输入 / 输出）：{price}",
        "models.priceNone": "未设置价格：点击 ✎ 设置价格后即可估算费用",
        "range.label": "时间范围",
        "range.today": "今日",
        "range.d7": "7 天",
        "range.d30": "30 天",
        "settings.title": "站点设置",
        "settings.idFixed": "线路名称，不可修改（如需更改，请删除站点后重新添加）",
        "settings.saved": "已保存",
        "settings.revert": "还原",
        "groups.needModels": "请先为站点添加模型",
        "groups.emptyHint": "尚未创建切换组。切换组将多个站点上的同一模型合并为模型选择栏中的一个条目，由选定的成员提供服务",
        "groups.members": "{count} 个成员",
        "edit.price": "价格（每百万 tokens）",
        "edit.priceInput": "输入",
        "edit.priceCache": "缓存命中",
        "edit.priceOutput": "输出",
        "edit.priceCurrency": "币种",
        "edit.priceSite": "用于估算费用。留空则采用站点提供的价格（{price}）。",
        "edit.priceSiteNone": "用于估算费用。留空则不设价格（站点未提供价格），仅统计 Token。",
        "edit.priceBad": "价格须为大于或等于 0 的数字",
        "time.seconds": "{s} 秒",
        "status.upfront": "该站点按每次请求的上下文与最大输出预扣费：Key 的剩余额度不足以预扣时，请求将被拒绝，但极小的校验请求可能仍会通过。请更换 Key，或联系站点提高该 Key 的额度。",
        "stat.failed": "失败 {count} 次",
        "chart.onlyFailures": "近 30 天无成功请求（失败 {count} 次）",
        "models.ctxMeasured": "实测值（{how}）：站点的模型列表未标注上下文窗口。上下文达到约 {at} 时自动压缩。",
        "models.measured.header": "读取自响应头",
        "models.measured.error": "读取自超长请求被拒时的错误信息",
        "models.measured.probe": "获取模型时向站点探测所得",
        "models.measured.search": "站点错误信息未注明数值，通过逐步探测站点可接受的最大请求得出",
        "site.someNoUsage": "部分模型不返回用量",
        "site.someNoUsageTitle": "以下模型的响应不包含 token 用量（{models}）：其用量按文本估算，DeepSeek Harness 显示的上下文占用亦为其自行估算。",
        "models.noUsage": "不返回用量",
        "models.noUsageTitle": "该模型的响应不包含 token 用量：此处用量按文本估算。",
        "stat.speed": "今日输出速度",
        "stat.ttftTitle": "首字延迟：今日 {today}，近 30 天 {month}",
        "col.speed": "输出速度",
        "col.speedTitle": "每秒输出的 token 数，从首个 token 计至输出结束（与 DeepSeek Harness 的计算方式一致）",
        "error.hostOutdated": "插件页面端版本为 {page}，但宿主端仍在运行 {host}：请重启 DeepSeek Harness。用量统计、上下文窗口探测等宿主端功能将在重启后更新。",
        "error.hostOld": "旧版本",
        "error.generic": "操作失败：{message}",
        "error.unavailable": "插件宿主端尚未加载：安装后请重启应用。",
        "lang.code": "zh",
        "lang.en": "英文",
        "lang.zh": "中文",
        "authn.nav": "模型核验",
        "authn.title": "模型核验",
        "authn.sub": "核验站点所提供的模型是否与其声明一致：被动监测对话响应，主动检测按需执行。仅提示，不切换站点或 Key，不拦截请求。",
        "authn.passive": "被动监测",
        "authn.passiveTitle": "记录受监测对话中每次响应的标识格式、耗时与用量等元数据。不发送额外请求，不保存对话内容。",
        "authn.active": "主动检测",
        "authn.activeTitle": "允许手动执行协议检测与签名校验。检测请求使用站点当前的 API Key，并计入用量。",
        "authn.offHint": "被动监测与主动检测均未启用。",
        "authn.loading": "正在加载…",
        "authn.siteTabs": "站点",
        "authn.results": "核验结果",
        "authn.siteNoModels": "该站点尚未添加模型。",
        "authn.col.model": "模型",
        "authn.col.channel": "上游来源",
        "authn.col.samples": "样本",
        "authn.samples": "{passive} 次响应 · {probes} 次检测",
        "authn.samplesTitle": "被动监测：{sessions} 个对话中的 {passive} 次响应（另有 {failed} 次失败）；主动检测：{probes} 次",
        "authn.noRows": "尚未在任何站点添加模型。",
        "authn.evidenceCount": "点击展开监测指标与判定依据",
        "authn.evidenceHide": "点击收起",
        "authn.evidenceTitle": "判定依据",
        "authn.noSamples": "暂无样本",
        "authn.quickTitle": "协议检测：{requests} 次小请求",
        "authn.signatureTitle": "签名校验：{requests} 次请求（仅限使用 Anthropic Messages 协议的 Claude 模型）",
        "authn.forget": "清除该模型的核验记录",
        "authn.forgetConfirm": "确认清除",
        "authn.stop": "停止检测",
        "authn.runTitle": "{kind}进行中：第 {step} 步，共 {steps} 步（单个请求最长等待 90 秒）",
        "kind.fingerprint": "知识指纹",
        "source.fingerprint": "知识指纹",
        "dock.run.fingerprint": "知识指纹",
        "dock.menuFingerprint": "知识指纹 · 约 {requests} 次请求（后台）",
        "authn.fingerprintTitle": "知识指纹：与「{set}」题库（{date} 录制）比对，约 {requests} 次请求，在后台运行",
        "authn.fingerprintVersionTitle": "知识指纹：与「{set}」题库（{date} 录制）比对，约 {requests} 次请求，在后台运行。被测模型与参考模型的版本标识不同，结果仅反映两个版本之间的知识差异",
        "authn.fingerprintRunTitle": "知识指纹在后台运行：第 {step} 步，共 {steps} 步。请求逐个发送、间隔 1 秒；遇到限流会等待，您使用该站点时会暂停；关闭 DSH 后，下次启动会继续。",
        "confirm.body.fingerprint": "将使用当前 API Key 向「{site}」的 {model} 发送约 {requests} 次请求（每次 10 道知识问答），约 {tokens} token{cost}，与「{set}」题库（{date}）中参考模型的答案比对。任务在后台运行，可随时停止；关闭 DSH 后，下次启动会继续。检测用量逐次计入站点用量，并标记为模型核验。",
        "confirm.fingerprintNamed": "参考答案录制于 {date}。同名模型若在此之后更新，比对结果反映的是与录制时版本之间的差异。",
        "confirm.fingerprintVariant": "被测模型（{model}）与参考模型（{reference}）的版本标识不同。比对结果仅反映两个版本之间的知识差异，不作为模型替换的判定依据。",
        "metric.knowledge": "知识指纹",
        "metric.knowledge.value": "{verdict}：不一致率 {mismatch}%（参考自检 {self}%，有效 {answered}/{asked} 题）· {set}（{date}）· {time}前",
        "metric.knowledge.same": "与参考模型一致",
        "metric.knowledge.diff": "与参考模型不符",
        "metric.knowledge.sameVersion": "与参考版本一致",
        "metric.knowledge.diffVersion": "与参考版本存在差异",
        "metric.knowledge.na": "无法判定",
        "metric.knowledge.ready": "尚未执行（题库「{set}」，{date} 录制，约 {requests} 次请求）",
        "metric.knowledge.readyVersion": "尚未执行（题库「{set}」，{date} 录制，与被测模型版本不同；约 {requests} 次请求）",
        "metric.knowledge.none": "规则库暂无该模型的题库",
        "metric.knowledge.paused": "已完成 {next} 步，开启主动检测或重启 DSH 后继续",
        "probe.kbfSame": "知识指纹与「{set}」（{date} 录制）一致：不一致率 {mismatch}%，参考模型自检为 {self}%（有效 {answered}/{asked} 题）",
        "probe.kbfSameVersion": "知识指纹与「{set}」（{date} 录制，参考版本 {reference}）一致：不一致率 {mismatch}%，参考模型自检为 {self}%（有效 {answered}/{asked} 题）。被测模型与参考模型的版本标识不同",
        "probe.kbfDiff": "知识指纹与「{set}」（{date} 录制）不符：不一致率 {mismatch}%，显著高于参考模型自检的 {self}%（p = {p}，有效 {answered}/{asked} 题）。站点提供的模型与参考模型不同，可能是同一家族的其他档位；若厂商在录制之后更新过同名模型，差异也可能来自版本更新",
        "probe.kbfDiffVersion": "知识指纹与「{set}」（{date} 录制，参考版本 {reference}）存在显著差异：不一致率 {mismatch}%，参考模型自检为 {self}%（p = {p}，有效 {answered}/{asked} 题）。被测模型与参考模型的版本标识不同，差异可能来自版本更新，不作为模型替换的判定依据",
        "probe.kbfUndetermined": "有效回答不足（{answered}/{asked} 题，覆盖 {coverage}%），无法判定",
        "probe.kbfTooFew": "未见显著差异，但有效回答不足以确认一致（{answered}/{asked} 题，至少需 {need} 题）",
        "probe.kbfNotClose": "与「{set}」（{date} 录制）未见显著差异，但不一致率 {mismatch}%（参考自检 {self}%），不足以确认与参考模型一致",
        "probe.kbfKeyRefused": "站点拒绝了 API Key（HTTP {status}），知识指纹已停止",
        "panel.spent": "核验用量（保留期内）：{requests} 次请求 · 输入 {input} · 输出 {output} tokens",
        "rules.fingerprints": "知识指纹题库：{sets} 套（{name}，{license}，截至 {date}）",
        "rules.fingerprintsUpstream": "上游新题库：{sets} 套（{time}前检查）",
        "rules.fingerprintsUpstreamError": "上游题库检查失败：{error}",
        "rules.fingerprintsCheck": "检查上游题库",
        "rules.fingerprintsChecking": "检查中…",
        "aset.fingerprintUpstream": "使用 KBF 作者新发布、规则库尚未收录的题库",
        "aset.fingerprintUpstreamTitle": "例如 Claude 5.5 系列的题库发布后、规则库更新前。这类题库未经规则库核对，结论最多为「疑似替换」。",
        "authn.col.identity": "模型身份",
        "authn.col.service": "服务表现",
        "authn.identityTitle": "身份核验：{requests} 次小请求，比对分词特征与返回的模型标识",
        "identity.unchecked": "未核验",
        "identity.clean": "未见替换",
        "identity.consistent": "身份相符",
        "identity.confirmed": "后端已验证",
        "identity.suspect": "疑似替换",
        "identity.substituted": "非标称模型",
        "identity.excluded": "未参与",
        "identity.likely": "疑似为：{name}",
        "identityTitle.unchecked": "尚无判断模型身份的依据。可执行身份核验（2 次小请求，比对分词特征）；被动监测需积累足够多不含思考过程的回答。",
        "identityTitle.clean": "被动监测中，回答的每 token 字符数处于该模型家族的范围内，未见替换迹象。该项无法区分同一家族的不同代或档位。",
        "identityTitle.consistent": "与标称模型一致：站点自报的分词计数或知识指纹与标称模型相符。计数由站点自行上报，不构成证明；同一代内的不同档位（如 Opus 与 Sonnet）共用分词器，无法据此区分。",
        "identityTitle.confirmed": "思考签名已通过 Anthropic 官方 API 校验：该次检测的响应来自真实的 Claude 后端；具体档位与版本、站点对其他请求的路由不在验证范围内。",
        "identityTitle.suspect": "发现疑似替换的迹象，但证据尚不足以下结论。",
        "identityTitle.substituted": "存在确定性证据，表明站点实际提供的并非标称模型。",
        "identityTitle.excluded": "该站点未参与模型核验（可在站点设置中更改）。",
        "service.insufficient": "数据不足",
        "service.ok": "正常",
        "service.issues": "{count} 项异常",
        "service.bad": "严重异常",
        "service.failed": "检测失败",
        "service.excluded": "—",
        "serviceTitle.insufficient": "响应样本不足，暂无法评估站点的服务表现。",
        "serviceTitle.ok": "未发现服务异常：无固定提示文本，参数正常生效，无空响应，工具调用与用量统计正常。",
        "serviceTitle.issues": "站点的服务存在异常，与模型身份无关，详见下方依据。",
        "serviceTitle.bad": "存在确定性的服务异常，如重放的响应，或多次以固定提示文本代替模型输出。",
        "serviceTitle.failed": "最近一次协议检测未能完成（全部请求失败）。请求失败既不说明模型造假，也不能证明服务正常。",
        "serviceTitle.excluded": "该站点未参与模型核验（可在站点设置中更改）。",
        "panel.metrics": "监测指标",
        "panel.info": "提示",
        "panel.none": "暂无异常",
        "panel.runIdentity": "执行身份核验",
        "level.hard": "确定性证据",
        "level.soft": "疑似，尚不确定",
        "level.info": "提示信息，不影响结论",
        "basis.site": "站点自报",
        "basis.observed": "本地观察",
        "basis.statistical": "统计推断",
        "basis.verified": "官方验证",
        "basisTitle.site": "依据站点自行上报的信息（模型名称、用量计数、站点日志），站点可任意填写。",
        "basisTitle.observed": "依据插件对响应本身的观察。",
        "basisTitle.statistical": "基于大量响应的比较：存在误报率，受负载、长度与话题影响，仅作提示。",
        "basisTitle.verified": "经 Anthropic 官方 API 校验，以所述范围为限。",
        "level.pass": "检测通过",
        "metric.echo": "返回的模型标识",
        "metric.echo.value": "{value}（{n}/{total} 次）",
        "metric.echo.na": "响应未携带模型标识",
        "metric.cpt-en": "每 token 字符数（英文）",
        "metric.cpt-zh": "每 token 字符数（中文）",
        "metric.cpt.value": "{value}（{family} 参考 {low}–{high}，{n} 次）",
        "metric.cpt.valueNoBand": "{value}（{n} 次，规则库未收录参考范围）",
        "metric.cpt.na": "样本不足（{n}/{need}；仅统计不含工具调用、且思考可单独计量的回答）",
        "metric.tokenizer": "分词特征（身份核验）",
        "metric.tokenizer.value": "差值 {delta} · {group}（{time}前）",
        "metric.tokenizer.na": "尚未执行身份核验",
        "metric.signature": "思考签名",
        "metric.signature.value": "{signed}/{total} 次含思考的回答带签名",
        "metric.signature.verified": "已由 Anthropic 官方 API 校验通过",
        "metric.signature.consistent": "已被其他站点接受（不构成证明）",
        "metric.signature.na": "暂无含思考过程的回答",
        "metric.upstream": "上游来源（近期）",
        "metric.upstream.na": "尚未识别",
        "metric.speed": "输出速度",
        "metric.speed.value": "{value} tokens/秒（近期中位数，{n} 次）",
        "metric.ttft": "首字延迟",
        "metric.ttft.value": "{value} 秒（近期中位数）",
        "metric.stub": "固定提示文本",
        "metric.empty": "空响应",
        "metric.count": "{n}/{total} 次",
        "metric.tools": "无效工具调用",
        "metric.tools.value": "{bad}/{calls} 次",
        "metric.tools.na": "暂无工具调用",
        "metric.usage": "输入用量 / 本地估算",
        "metric.usage.value": "{value}（正常范围 {low}–{high}）",
        "metric.usage.na": "样本不足（{n}/{need}）",
        "metric.na": "样本不足",
        "metricStatus.ok": "正常",
        "metricStatus.warn": "异常",
        "metricStatus.bad": "不符",
        "metricStatus.na": "数据不足",
        "metricStatus.info": "仅供参考",
        "kind.identity": "身份核验",
        "source.identity": "身份核验",
        "dock.run.identity": "身份核验",
        "dock.menuIdentity": "身份核验 · {requests} 次请求",
        "dock.identity": "模型身份",
        "dock.service": "服务表现",
        "dock.upstream": "上游来源",
        "dock.passive": "被动监测",
        "dock.active": "主动检测",
        "dock.passiveValue": "本对话 {here} 次 · 累计 {all} 次",
        "dock.activeValue": "{kind} · {time}前",
        "dock.activeFailed": "{kind}未能完成 · {time}前",
        "dock.activeRun": "{kind}进行中 {step}/{steps}",
        "dock.hint": "点击打开操作菜单 · 详情见 Custom → 模型核验",
        "confirm.body.identity": "将使用当前 API Key 向「{site}」的 {model} 发送 {requests} 次小请求（固定文本），约 {tokens} token{cost}，用于比对分词特征与返回的模型标识。检测用量计入站点用量，并标记为模型核验。",
        "ev.echoVersion": "请求模型为 {asked}，站点返回的模型标识为 {echo}（同档位的其他版本，{n} 次）",
        "probe.echoVersion": "请求模型为 {asked}，返回的模型标识为 {echo}（同档位的其他版本）",
        "probe.echoArn": "返回的模型标识为 AWS Bedrock 推理配置文件 ARN，不含模型名称",
        "probe.tokenizerMatch": "站点自报的分词计数与 {group} 一致（差值 {delta}）",
        "probe.tokenizerAmbiguous": "站点自报的分词计数与 {group} 一致，也与 {others} 一致（差值 {delta}）：一致但不唯一",
        "probe.tokenizerGeneration": "站点自报的分词计数与 {likely} 一致（差值 {delta}），而标称模型应为 {expected}：可能是同一厂商的其他代模型",
        "probe.tokenizerOther": "分词特征与 {likely} 一致（差值 {delta}），而标称模型应为 {expected}：可能为替换模型，也可能是站点自行计算用量",
        "probe.tokenizerUnknown": "分词特征（差值 {delta}）不符合标称模型应有的 {expected}（差值 {want}），也不匹配任何已收录的分词器：可能为未收录的模型，或站点自行计算用量",
        "probe.tokenizerFamily": "分词特征与 {likely} 一致（差值 {delta}），不属于标称模型所在的家族：可能为替换模型，也可能是站点自行计算用量",
        "probe.tokenizerNoRef": "规则库尚未收录该模型的分词参考值（差值 {delta}，最接近：{likely}）",
        "probe.tokenizerNoUsage": "站点未返回输入 token 用量，无法比对分词特征",
        "probe.tokenizerNoPack": "当前规则库不含分词参考数据",
        "channel.unknown": "未识别",
        "channel.unknownTitle": "响应中尚无可用于识别上游来源的特征。",
        "channel.via": "{upstream}（经 {relay}）",
        "source.passive": "被动监测",
        "source.quick": "协议检测",
        "source.signature": "签名校验",
        "kind.quick": "协议检测",
        "kind.signature": "签名校验",
        "ev.withNote": "{text}（{note}）",
        "ev.channelDrift": "响应交替来自 {a} 与 {b}：站点混用不同厂商的后端",
        "ev.channelHosts": "响应交替来自 {a} 与 {b}：二者均为同一模型厂商的托管平台（中转账号池或服务商路由）",
        "ev.replay": "{n} 次响应与此前响应的 ID 及内容完全相同：为回放或缓存结果，而非新生成的响应",
        "ev.idSynth": "不同响应共用同一 ID：响应 ID 由站点自行生成",
        "ev.fixedAnswer": "不同请求得到完全相同的响应（{n} 次）：站点返回固定内容",
        "ev.sameOpening": "不同请求的响应开头相同（{n} 次）；早期记录仅保存开头，可能为模板化输出",
        "ev.stub": "{n} 次响应为站点的固定提示文本，而非模型输出",
        "ev.echoMismatch": "请求模型为 {asked}，站点返回的模型标识为 {echo}（{n} 次）",
        "ev.echoDrift": "站点返回的模型标识发生变化：{a} / {b}",
        "ev.stitched": "{n} 次响应由不同 ID 的数据帧拼接而成",
        "ev.speedUp": "输出速度较此前显著提高：{now} tok/s（此前 {base}）",
        "ev.speedDown": "输出速度较此前显著下降：{now} tok/s（此前 {base}）",
        "ev.cptBand": "{lang}响应平均每 token {value} 个字符，超出 {family} 的典型区间 {low}–{high}：分词器不同（可能为其他模型），或用量由站点自行计算（{n} 次响应）",
        "ev.cptDrift": "{lang}响应的每 token 字符数由 {base} 变为 {now}：可能是分词器变化",
        "ev.inputHigh": "报告的输入 token 为实际发送内容估算值的 {ratio} 倍（{n} 次响应）：可能存在用量虚报",
        "ev.inputLow": "报告的输入 token 仅为实际发送内容估算值的 {ratio} 倍（{n} 次响应）：站点可能截断了上下文",
        "ev.toolHealth": "{calls} 次工具调用中有 {bad} 次无效（参数非合法 JSON、缺少必填字段或调用了不存在的工具）",
        "ev.empty": "{total} 次响应中有 {n} 次为空或仅含思考内容",
        "ev.overMax": "{n} 次响应超出请求的输出上限",
        "ev.contextEarly": "输入约 {est} token 时即报上下文超长，远低于声明的 {context} 上下文窗口",
        "ev.signatureStripped": "思考内容未附带签名（{n} 次响应）：该站点无法进行签名校验",
        "probe.requestFailed": "请求失败（{status}）：{error}",
        "probe.runFailed": "检测执行失败：{error}",
        "probe.replay": "两次请求返回相同的 ID 与内容（{id}…）：为回放或缓存结果",
        "probe.sameId": "两次请求返回相同的 ID（{id}…）：响应 ID 由站点自行生成",
        "probe.uniqueId": "两次请求的响应 ID 互不相同",
        "probe.noId": "响应中未包含 ID",
        "probe.shortId": "响应 ID（{id}…）为短序号（本地服务常见），不参与比较",
        "probe.echoMismatch": "请求模型为 {asked}，返回的模型标识为 {echo}",
        "probe.echo": "返回的模型标识：{echo}",
        "probe.maxTokens": "max_tokens（{limit}）生效，响应已截断",
        "probe.maxTokensEmpty": "响应为空，无法判断 max_tokens（{limit}）是否生效",
        "probe.maxTokensShort": "响应在达到 max_tokens（{limit}）前已结束（{output} token），无法判断",
        "probe.maxTokensIgnored": "max_tokens（{limit}）未生效：结束原因 {finish}，输出 {output} token",
        "probe.stopRefused": "站点不支持 stop 参数：{error}",
        "probe.stopIgnored": "stop 参数未生效（站点未传递该参数）",
        "probe.stop": "stop 参数生效",
        "probe.stopEmpty": "响应未计数至停止序列之前，无法判断 stop 参数是否生效",
        "probe.toolMissing": "已强制要求工具调用，但响应中无调用",
        "probe.toolMissingAuto": "站点不支持强制工具调用；改为可选后仍无调用",
        "probe.toolArgs": "工具调用参数无效：{args}",
        "probe.tool": "工具调用正常（ID 前缀 {prefix}…）",
        "probe.toolAuto": "站点不支持强制工具调用；改为可选后调用正常（ID 前缀 {prefix}…）",
        "probe.image": "正确识别测试图片的颜色",
        "probe.imageWrong": "未能识别测试图片的颜色：{answer}",
        "sig.redacted": "仅返回经脱敏的思考内容，无法校验签名",
        "sig.noThinking": "响应未包含思考内容，无法校验签名",
        "sig.stripped": "站点移除了思考签名，无法校验",
        "sig.checked": "篡改后的签名被拒绝、原始签名被接受：后端执行签名校验",
        "sig.refusesAll": "篡改签名与原始签名均被拒绝（{status}）",
        "sig.notChecked": "篡改后的签名仍被接受：站点后端未执行签名校验",
        "sig.verified": "该站点的签名已通过 Anthropic 官方 API（「{peer}」）的校验：该次检测的响应来自真实的 Claude 后端（不涵盖具体档位、版本及其他请求）",
        "sig.peerAccepted": "「{peer}」接受了该站点的签名。该站点曾拒绝篡改的签名，但中转站的接受不构成证明，不影响结论",
        "sig.forged": "该站点的签名未通过「{peer}」的校验：签名系伪造",
        "sig.peerFailed": "「{peer}」未能完成校验（{status}）",
        "sig.peerBound": "「{peer}」以「绑定至其他账号、对话或模型」为由拒绝：无法据此判断",
        "dock.title": "模型核验",
        "dock.aria": "模型核验：{verdict}",
        "dock.notCustomShort": "不适用",
        "dock.notCustom": "当前对话的模型未经 Custom 插件，无法核验",
        "dock.trackedHere": "已监测本对话（经 Custom 的响应将被记录）",
        "dock.line": "{label}：{value}",
        "dock.group": "（切换组「{group}」）",
        "dock.passiveOff": "当前对话未监测",
        "dock.passiveDisabled": "未启用",
        "dock.activeDisabled": "未启用",
        "dock.excluded": "该站点未参与模型核验",
        "dock.activeNone": "尚未执行",
        "dock.rules": "规则库 {version}",
        "dock.run": "{kind} {step}/{steps}",
        "dock.run.quick": "协议检测",
        "dock.run.signature": "签名校验",
        "dock.menuPassive": "监测本对话（仅记录响应特征）",
        "dock.menuActive": "主动检测",
        "dock.menuQuick": "协议检测 · {requests} 次请求",
        "dock.menuSignature": "签名校验 · {requests} 次请求",
        "dock.menuCancel": "停止检测",
        "dock.menuPage": "查看详情：Custom 标签页 → 模型核验",
        "dock.fallbackPassive": "{label}：{state}",
        "dock.on": "开",
        "dock.off": "关",
        "confirm.title": "执行{kind}？",
        "confirm.body.quick": "将使用当前 API Key 向「{site}」的 {model} 发送 {requests} 次小请求，约 {tokens} token{cost}。检测用量计入站点用量，并标记为模型核验。",
        "confirm.body.signature": "将使用当前 API Key 向「{site}」的 {model} 发送约 {requests} 次请求（其中一次启用思考），约 {tokens} token{cost}。如有其他站点的后端已确认执行签名校验，还将把本站点由检测请求产生的签名（不含对话内容）发送至该站点校验。检测用量计入站点用量，并标记为模型核验。",
        "confirm.cost": "（约 {cost}）",
        "confirm.max": "最多 {requests} 次请求{cost}。",
        "confirm.maxCost": "，费用最多约 {cost}",
        "confirm.peers": "跨站点校验还可能向「{sites}」发送最多 {n} 次请求，计入这些站点的用量。",
        "confirm.peerSep": "」「",
        "confirm.run": "执行",
        "confirm.cancel": "取消",
        "rules.title": "规则库",
        "rules.version": "{version} · 发布于 {published}",
        "rules.builtin": "内置",
        "rules.online": "在线",
        "rules.check": "检查更新",
        "rules.checking": "正在检查…",
        "rules.rollback": "回退至内置版本",
        "rules.notConfigured": "在线更新尚未开通（数据仓库尚未发布）。",
        "rules.checkedAt": "上次检查：{time}前",
        "rules.error": "上次检查失败：{error}",
        "rules.hint": "规则库仅包含判定数据（上游特征、固定提示文本、模型家族、检测题措辞），插件只读取、不执行；在线版本须附有发布者签名。",
        "aset.title": "设置",
        "aset.group.passive": "被动监测",
        "aset.group.active": "主动检测",
        "aset.group.rules": "规则库",
        "aset.group.data": "显示与数据",
        "aset.dock": "在对话状态栏显示核验状态",
        "aset.dockTitle": "显示于上下文用量条旁的盾牌、眼睛与雷达图标",
        "aset.passiveDefault": "新对话默认启用监测",
        "aset.passiveDefaultTitle": "被动监测不发送额外请求，仅记录响应的标识格式、耗时与计数，不保存内容；各对话可在状态栏中单独开关。",
        "aset.confirm": "执行前确认请求数与费用",
        "aset.confirmTitle": "执行前显示请求次数与估算费用",
        "aset.crossSite": "允许跨站点签名交叉校验",
        "aset.crossSiteTitle": "仅发送检测请求产生的签名，不发送对话中的签名。",
        "aset.autoIdentity": "被动监测发现身份异常时，自动执行身份核验",
        "aset.autoIdentityTitle": "仅在主动检测开启时生效。每次发送 2 次小请求（固定文本），计入站点用量。异常持续存在时，同一模型按下方间隔再次核验。",
        "aset.autoInterval": "同一模型的最短间隔",
        "aset.autoInterval.30": "30 分钟",
        "aset.autoInterval.60": "1 小时",
        "aset.autoInterval.120": "2 小时",
        "aset.autoInterval.360": "6 小时",
        "aset.autoInterval.720": "12 小时",
        "aset.autoInterval.1440": "24 小时",
        "aset.autoDaily": "每日自动核验上限（所有模型合计）",
        "aset.autoDaily.option": "{n} 次",
        "metric.input-ratio": "输入分词比（上报 / 估算）",
        "metric.input-ratio.value": "{value}（近期中位数，{n} 次请求）",
        "metric.input-ratio.na": "样本不足（{n}/{need}）",
        "metric.speed.hidden": "回答含未单独计量的思考（{hidden} 次），无法计算",
        "ev.inputStep": "同一对话中，站点上报的输入 token 与本地估算之比由 {from} 变为 {to}（{change}%）并保持：分词器发生变化，疑似中途更换了模型（也可能是中转切换了账号池）",
        "ev.cleared": "已由其后的身份核验排除",
        "ev.attemptFailed": "最近一次检测未能完成（{status} {error}），结论基于此前的有效结果",
        "source.auto": "{source}（自动）",
        "dock.activeValueAuto": "{kind}（自动）· {time}前",
        "aset.autoUpdate": "自动更新规则库",
        "aset.autoUpdateTitle": "模型核验启用期间每日检查一次；签名无效的规则库不予采用。",
        "aset.keepDays": "记录保留天数",
        "aset.keepDaysTitle": "超过该天数的监测记录与检测结果将被删除（1–365）",
        "aset.source": "更新源",
        "aset.source.github": "GitHub",
        "aset.source.jsdelivr": "jsDelivr",
        "aset.source.custom": "自定义地址",
        "aset.customUrl": "地址（https，须提供 pack.json 与 pack.json.sig）",
        "aset.clearAll": "清除全部核验记录",
        "aset.clearConfirm": "再次点击以确认清除",
        "site.authn": "参与模型核验",
        "site.authnTitle": "关闭后，不监测该站点的响应，也不对其执行检测。",
        "models.rowProbes": "其中 {count} 次为模型核验请求",
      },
    };

    const CSS = [
      ".cx-root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".cx-view{box-sizing:border-box;width:100%;max-width:1320px;margin:0 auto;padding:20px 28px calc(var(--dsh-composer-height, 152px) + 24px)}",
      ".cx-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".cx-title{font-size:15px;font-weight:600;margin-right:4px}",
      ".cx-subtitle{font-size:14px;font-weight:600}",
      ".cx-spacer{flex:1}",
      ".cx-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".cx-error{color:var(--dsw-alias-state-error-primary);font-size:12px}",
      ".cx-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}",
      ".cx-warn{color:var(--dsw-alias-state-warn-primary)}",
      ".cx-btn.cx-btn{min-width:92px;justify-content:center}",
      ".cx-section{container-type:inline-size;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden}",
      ".cx-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 14px;background:var(--dsw-alias-bg-layer-1,transparent);border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".cx-section-name{font-weight:600}",
      ".cx-section[data-off=true] .cx-section-name{color:var(--dsw-alias-label-tertiary)}",
      ".cx-section[data-off=true] .cx-keys,.cx-section[data-off=true] .cx-thead,.cx-section[data-off=true] .cx-note{opacity:.5}",
      ".cx-member input:disabled+span,.cx-member[data-off=true]{color:var(--dsw-alias-label-tertiary)}",
      ".cx-tag{flex:none;font-size:11px;padding:1px 7px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".cx-tag[title]{cursor:help}",
      ".cx-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
      ".cx-http-note{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.6;padding:8px 10px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
      ".cx-http-note .cx-check{color:var(--dsw-alias-label-primary)}",
      ".cx-grid{display:grid;grid-template-columns:minmax(150px,1fr) minmax(110px,.8fr) 236px;align-items:center;column-gap:14px;padding:3px 14px 10px 30px}",
      ".cx-section[data-funds=true] .cx-grid{grid-template-columns:minmax(150px,1fr) minmax(200px,1.5fr) minmax(110px,.8fr) 236px}",
      ".cx-thead{font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-top:6px;padding-bottom:6px}",
      ".cx-keys{list-style:none;margin:0;padding:0}",
      ".cx-key{position:relative;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".cx-key:last-child{border-bottom:none}",
      ".cx-key[data-active=true]{box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary)}",
      ".cx-key[data-dead=true] .cx-funds,.cx-key[data-dead=true] .cx-usage{opacity:.45}",
      ".cx-key[data-dragging=true]{opacity:.45}",
      ".cx-key[data-drop]::after{content:\"\";position:absolute;left:0;right:0;height:2px;background:var(--dsw-alias-state-business-primary);pointer-events:none;z-index:1}",
      ".cx-key[data-drop=before]::after{top:-1px}",
      ".cx-key[data-drop=after]::after{bottom:-1px}",
      ".cx-grip{position:absolute;left:6px;top:7px;display:flex;align-items:center;justify-content:center;width:18px;height:24px;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary);opacity:.4;cursor:grab}",
      ".cx-key:hover .cx-grip,.cx-grip:focus-visible{opacity:1}",
      ".cx-grip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".cx-line1{display:flex;align-items:center;gap:8px;min-width:0;padding:9px 14px 2px 30px}",
      ".cx-name-text{flex:none;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}",
      ".cx-full{flex:0 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-width:thin;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary);user-select:all;-webkit-user-select:all}",
      ".cx-copy{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px}",
      ".cx-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".cx-copy[data-copied=true]{color:var(--dsw-alias-state-success-primary)}",
      ".cx-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}",
      ".cx-chip::before{content:\"\";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}",
      ".cx-chip[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}",
      ".cx-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}",
      ".cx-chip[data-tone=bad]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}",
      ".cx-funds{display:flex;align-items:center;gap:8px;min-width:0}",
      ".cx-funds[data-stale=true] .cx-amount{opacity:.5}",
      ".cx-failed{flex:none;font-size:12px;color:var(--dsw-alias-state-warn-primary);cursor:help;border-bottom:1px dotted currentColor}",
      ".cx-amount{font-variant-numeric:tabular-nums;font-weight:600}",
      ".cx-usage{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".cx-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;white-space:nowrap}",
      ".cx-slot{flex:none;width:92px;display:flex;justify-content:center}",
      ".cx-badge{font-size:11px;padding:3px 8px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff);white-space:nowrap}",
      ".cx-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px}",
      ".cx-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".cx-icon:disabled{cursor:default}",
      ".cx-icon:disabled:not([aria-busy=true]){opacity:.3}",
      ".cx-icon[data-spin=true] svg{animation:cx-spin .9s linear infinite}",
      ".cx-icon[data-pulse=true] svg{animation:cx-pulse .9s ease-in-out infinite}",
      ".cx-icon[data-confirm=true]{color:var(--dsw-alias-state-error-primary);width:auto;padding:0 8px;font-size:12px}",
      "@keyframes cx-spin{to{transform:rotate(360deg)}}",
      "@keyframes cx-pulse{50%{opacity:.3}}",
      ".cx-note{padding:8px 14px 10px 30px;font-size:12px}",
      "@container (max-width: 720px){.cx-section .cx-thead.cx-thead{display:none}.cx-section .cx-grid.cx-grid:not(.cx-thead){display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.cx-funds{min-width:180px}.cx-actions{margin-left:auto}}",
      ".cx-modal.cx-modal{width:min(var(--cx-modal-width,640px),100%);max-height:100%}",
      ".cx-modal-wide{--cx-modal-width:860px}",
      ".cx-modal-xl{--cx-modal-width:1120px}",
      ".cx-modal-content{flex:1 1 auto;min-height:0;overflow-y:auto}",
      ".cx-dialog{display:flex;flex-direction:column;gap:12px}",
      ".cx-field{display:flex;flex-direction:column;gap:5px}",
      ".cx-field>label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".cx-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
      ".cx-row3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}",
      ".cx-row3 label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".cx-select,.cx-text{box-sizing:border-box;width:100%;height:32px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}",
      ".cx-text[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}",
      ".cx-textarea{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;font:12px/1.5 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px}",
      ".cx-select:focus,.cx-text:focus,.cx-textarea:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:1px}",
      ".cx-inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".cx-inline .cx-text{flex:1 1 220px;min-width:0}",
      ".cx-inline .cx-narrow{flex:0 0 150px}",
      ".cx-relay-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0;font-size:12px}",
      ".cx-relay-key{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}",
      ".cx-relay-account{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}",
      ".cx-billed{font-weight:600}",
      ".cx-hint{display:block;margin-top:4px;font-size:12px}",
      ".cx-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}",
      ".cx-link{border:none;background:none;padding:0;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));cursor:pointer;font-size:12px;align-self:flex-start}",
      ".cx-catalog{display:flex;flex-direction:column;gap:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}",
      ".cx-placeholder{padding:18px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md)}",
      ".cx-model-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(max(220px,calc((100% - 20px) / 3)),1fr));gap:10px}",
      ".cx-model-card{position:relative;display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}",
      ".cx-model-card:hover{border-color:var(--dsw-alias-border-l3)}",
      ".cx-model-card[data-selected=true]{border-color:var(--dsw-alias-state-business-primary)}",
      ".cx-model-card .cx-model-name{align-items:flex-start;overflow-wrap:anywhere}",
      ".cx-model-card .cx-model-name input{margin-top:2px}",
      ".cx-model-title{font-weight:500;overflow-wrap:anywhere;padding-right:52px}",
      ".cx-model-id{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);overflow-wrap:anywhere}",
      ".cx-model-meta{display:flex;flex-wrap:wrap;gap:2px 8px}",
      ".cx-model-card .cx-model-name+.cx-model-meta{padding-left:22px}",
      ".cx-model-tag{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".cx-model-tag[title]{cursor:help}",
      ".cx-model-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
      ".cx-model-tag[data-tone=free]{color:var(--dsw-alias-state-success-primary)}",
      ".cx-model-tools{position:absolute;top:4px;right:4px;display:flex;gap:2px}",
      ".cx-model-tools .cx-icon{width:24px;height:24px}",
      ".cx-search.cx-search{width:220px;height:30px}",
      ".cx-empty{display:flex;align-items:center;gap:12px;font-size:13px;padding:14px 16px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary)}",
      ".cx-levels{display:flex;flex-wrap:wrap;gap:4px 12px}",
      ".cx-group{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".cx-group:last-child{border-bottom:none}",
      ".cx-group-head{display:flex;align-items:center;gap:8px}",
      ".cx-members{display:flex;flex-wrap:wrap;gap:6px 18px;padding-left:2px}",
      ".cx-member{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}",
      ".cx-member[data-missing=true]{color:var(--dsw-alias-label-tertiary)}",
      ".cx-summary{display:flex;flex-direction:column;gap:4px;padding:2px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
      ".cx-view{container-type:inline-size;container-name:cxview}",
      ".cx-shell{display:grid;grid-template-columns:196px minmax(0,1fr);gap:28px;align-items:start}",
      ".cx-nav{position:sticky;top:16px;display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".cx-nav-title{padding:2px 12px 12px;font-size:16px;line-height:24px;font-weight:500}",
      ".cx-nav-group{display:flex;justify-content:space-between;padding:14px 12px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".cx-nav-item{position:relative;display:flex;align-items:center;gap:10px;width:100%;height:40px;padding:9px 12px;box-sizing:border-box;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}",
      ".cx-nav-item:hover{background:var(--dsw-specific-sidebar-nav-item-hover,var(--dsw-alias-interactive-bg-hover))}",
      ".cx-nav-item[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-interactive-bg-active));font-weight:500}",
      ".cx-nav-item:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:-2px}",
      ".cx-nav-item[data-off=true] .cx-nav-label{color:var(--dsw-alias-label-tertiary)}",
      ".cx-nav-item[data-dragging=true]{opacity:.45}",
      ".cx-nav-item[data-drop]::after{content:\"\";position:absolute;left:8px;right:8px;height:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary);pointer-events:none}",
      ".cx-nav-item[data-drop=before]::after{top:-2px}",
      ".cx-nav-item[data-drop=after]::after{bottom:-2px}",
      ".cx-nav-icon{flex:none;display:inline-flex;color:var(--dsw-alias-label-secondary)}",
      ".cx-nav-dot{flex:none;width:8px;height:8px;margin:0 4px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
      ".cx-nav-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".cx-nav-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".cx-nav-dot[data-tone=bad]{background:var(--dsw-alias-state-error-primary)}",
      ".cx-nav-dot[data-tone=off]{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-label-tertiary)}",
      ".cx-nav-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cx-nav-meta{flex:none;font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      ".cx-nav-sep{height:1px;margin:10px 12px;background:var(--dsw-alias-border-l2)}",
      ".cx-main{min-width:0}",
      ".cx-page{display:flex;flex-direction:column;gap:16px;min-width:0}",
      ".cx-page-head{display:flex;align-items:flex-start;gap:12px 16px;flex-wrap:wrap}",
      ".cx-page-titles{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:4px}",
      ".cx-page-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}",
      ".cx-page-title{margin:0;max-width:100%;font-size:18px;line-height:28px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cx-page-sub{display:flex;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".cx-page-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".cx-switch{display:inline-flex}",
      ".cx-ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cx-card{container-type:inline-size;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden}",
      ".cx-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:44px;padding:6px 12px 6px 16px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".cx-card-title{font-size:14px;font-weight:600}",
      ".cx-card-body{padding:16px}",
      ".cx-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}",
      ".cx-stat{display:flex;flex-direction:column;gap:2px;min-width:0;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}",
      ".cx-stat[title]{cursor:help}",
      ".cx-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".cx-stat-value{font-size:20px;line-height:28px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".cx-stat-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".cx-chart{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:148px auto;column-gap:10px;row-gap:8px}",
      ".cx-chart-axis{display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;margin:-6px 0;font-size:11px;line-height:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      ".cx-chart-plot{position:relative;min-width:0}",
      ".cx-chart-grid{position:absolute;left:0;right:0;height:1px;margin-bottom:-1px;background:var(--dsw-alias-border-l2)}",
      ".cx-chart-cols{position:absolute;inset:0;display:flex;align-items:stretch}",
      ".cx-chart-col{flex:1 1 0;min-width:0;display:flex;align-items:flex-end;justify-content:center;border-radius:var(--dsw-radius-xs,6px) var(--dsw-radius-xs,6px) 0 0}",
      ".cx-chart-col:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".cx-chart-bar{display:block;width:min(24px,64%);border-radius:4px 4px 0 0;background:var(--dsw-alias-state-business-primary)}",
      ".cx-chart-x{grid-column:2;display:flex;justify-content:space-between;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary)}",
      ".cx-seg{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:3px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover)}",
      ".cx-seg-indicator{position:absolute;top:3px;left:3px;width:calc((100% - 6px - 2px * (var(--cx-seg-count) - 1)) / var(--cx-seg-count));height:calc(100% - 6px);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.12));transform:translateX(calc(var(--cx-seg-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}",
      ".cx-seg-tab{position:relative;z-index:1;height:24px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer}",
      ".cx-seg-tab[aria-selected=true],.cx-seg-tab:hover{color:var(--dsw-alias-label-primary)}",
      ".cx-table{display:flex;flex-direction:column}",
      ".cx-tr{display:grid;align-items:center;column-gap:12px;min-width:0;padding:10px 12px 10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".cx-tr:last-child{border-bottom:none}",
      ".cx-tr>[role=cell]{min-width:0}",
      ".cx-th{padding-top:8px;padding-bottom:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".cx-th>[title]{cursor:help}",
      ".cx-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".cx-sites .cx-tr{grid-template-columns:minmax(150px,1.6fr) minmax(120px,1.3fr) minmax(90px,.9fr) minmax(90px,.9fr) minmax(80px,.8fr)}",
      ".cx-sites[data-funds=true] .cx-tr{grid-template-columns:minmax(150px,1.6fr) minmax(120px,1.3fr) minmax(130px,1.2fr) minmax(90px,.9fr) minmax(90px,.9fr) minmax(80px,.8fr)}",
      ".cx-row-link{cursor:pointer}",
      ".cx-row-link:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".cx-row-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:-2px}",
      ".cx-row-link[data-off=true]>*{opacity:.55}",
      ".cx-site-cell{display:flex;align-items:center;gap:6px;min-width:0}",
      ".cx-site-names{display:flex;flex-direction:column;min-width:0}",
      ".cx-site-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cx-models .cx-tr{grid-template-columns:minmax(160px,2.2fr) minmax(48px,.55fr) minmax(44px,.5fr) minmax(54px,.65fr) minmax(60px,.7fr) minmax(54px,.65fr) minmax(50px,.55fr) minmax(64px,.7fr) minmax(70px,.85fr) 60px}",
      ".cx-models .cx-tr[title]:not(.cx-th):not(.cx-tfoot){cursor:default}",
      ".cx-tfoot{font-weight:600;border-top:1px solid var(--dsw-alias-border-l3)}",
      ".cx-model-cell{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".cx-model-cell .cx-model-title{padding-right:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cx-model-sub{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;min-width:0}",
      ".cx-row-tools{display:flex;justify-content:flex-end;gap:2px}",
      ".cx-banner{padding:10px 14px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary,transparent);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
      ".cx-fail{display:block;font-size:11px;line-height:14px;color:var(--dsw-alias-state-warn-primary)}",
      ".cx-row-tools .cx-icon{width:26px;height:26px}",
      ".cx-row-tools .cx-icon[data-confirm=true]{width:auto}",
      ".cx-card .cx-members{padding:14px 16px;gap:8px 24px}",
      ".cx-member-site{color:var(--dsw-alias-label-secondary)}",
      ".cx-member-site::after{content:\"·\";margin-left:6px;color:var(--dsw-alias-label-tertiary)}",
      ".cx-form-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}",
      ".cx-field-end{justify-content:flex-end;padding-bottom:6px}",
      ".cx-grow{flex:1;min-width:0}",
      ".cx-row4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}",
      ".cx-text[readonly]{color:var(--dsw-alias-label-secondary);background:transparent;cursor:default}",
      "@container cxview (max-width: 980px){.cx-stats{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}}",
      "@container (max-width: 760px){.cx-models .cx-opt{display:none}.cx-models .cx-tr{grid-template-columns:minmax(130px,2fr) minmax(48px,.6fr) minmax(44px,.5fr) minmax(52px,.7fr) minmax(52px,.7fr) minmax(64px,.9fr) 56px}.cx-sites .cx-tr,.cx-sites[data-funds=true] .cx-tr{grid-template-columns:minmax(130px,1.5fr) minmax(110px,1.2fr) minmax(80px,.9fr) minmax(70px,.8fr)}.cx-sites [role=cell]:nth-child(n+5):not(:last-child),.cx-sites [role=columnheader]:nth-child(n+5):not(:last-child),.cx-sites[data-funds=true] [role=cell]:nth-child(3),.cx-sites[data-funds=true] [role=columnheader]:nth-child(3){display:none}}",
      ".cxa-dock{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 7px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;white-space:nowrap;cursor:pointer}",
      ".cxa-dock:hover,.cxa-dock[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
      ".cxa-dock:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:-2px}",
      ".cxa-dock svg{display:block}",
      // DSH's hover card wraps its anchor in a block span: kept inline in the dock row.
      ".cxa-dock-wrap{display:inline-flex;flex:none;align-items:center}",
      ".cxa-shield,.cxa-eye,.cxa-radar{display:inline-flex}",
      ".cxa-dock[data-tone=dim]{opacity:.5}",
      ".cxa-dock[data-tone=ok] .cxa-shield{color:var(--dsw-alias-state-success-primary)}",
      ".cxa-dock[data-tone=warn] .cxa-shield,.cxa-dock[data-tone=warn] .cxa-label{color:var(--dsw-alias-state-warn-primary)}",
      ".cxa-dock[data-tone=bad] .cxa-shield,.cxa-dock[data-tone=bad] .cxa-label{color:var(--dsw-alias-state-error-primary)}",
      ".cxa-eye[data-on=false]{opacity:.55}",
      ".cxa-radar{position:relative}",
      ".cxa-radar[data-running=true]{color:var(--dsw-alias-state-business-primary)}",
      ".cxa-radar[data-running=true] svg{animation:cx-pulse .9s ease-in-out infinite}",
      ".cxa-radar[data-tone]::after{content:\"\";position:absolute;right:-2px;bottom:-1px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
      ".cxa-radar[data-tone=ok]::after{background:var(--dsw-alias-state-success-primary)}",
      ".cxa-radar[data-tone=warn]::after{background:var(--dsw-alias-state-warn-primary)}",
      ".cxa-radar[data-tone=bad]::after{background:var(--dsw-alias-state-error-primary)}",
      ".cxa-run{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}",
      ".cxa-radar[data-off=true],.cxa-eye[data-off=true]{opacity:.35}",
      ".cxa-tabs{display:flex;gap:4px;overflow-x:auto;padding-bottom:2px;border-bottom:1px solid var(--dsw-alias-border-l2);scrollbar-width:thin}",
      ".cxa-tab{position:relative;display:inline-flex;align-items:center;gap:6px;flex:none;height:34px;padding:0 12px;border:none;border-radius:var(--dsw-radius-sm) var(--dsw-radius-sm) 0 0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}",
      ".cxa-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".cxa-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);font-weight:500}",
      ".cxa-tab[aria-selected=true]::after{content:\"\";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary)}",
      ".cxa-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:-2px}",
      ".cxa-tab[data-off=true]{color:var(--dsw-alias-label-tertiary)}",
      ".cxa-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
      ".cxa-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".cxa-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".cxa-dot[data-tone=bad]{background:var(--dsw-alias-state-error-primary)}",
      ".cxa-group{display:flex;flex-direction:column;gap:8px}",
      ".cxa-group+.cxa-group{padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}",
      ".cxa-group-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
      ".cxa-switches{display:flex;align-items:center;gap:20px;flex-wrap:wrap}",
      ".cxa-switch{display:inline-flex;align-items:center;gap:8px}",
      ".cxa-switch-label{font-size:13px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;user-select:none}",
      ".cxa-switch-label[data-on=true]{color:var(--dsw-alias-label-primary)}",
      ".cxa-error-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}",
      ".cxa-table .cx-tr{grid-template-columns:minmax(150px,1.6fr) minmax(110px,1.1fr) minmax(104px,.9fr) minmax(92px,.8fr) minmax(100px,.8fr) 148px}",
      ".cxa-spent{grid-column:1/-1;font-size:12px}",
      ".cxa-verdict{display:inline-flex;max-width:100%;padding:0;border:none;border-radius:999px;background:none;font:inherit;color:inherit;cursor:pointer}",
      ".cxa-verdict .cx-chip{cursor:pointer}",
      ".cxa-verdict:hover .cx-chip{background:var(--dsw-alias-interactive-bg-hover)}",
      ".cxa-verdict:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}",
      ".cxa-chevron{display:inline-flex;margin-right:-2px;transition:transform .15s ease}",
      ".cxa-verdict[aria-expanded=true] .cxa-chevron{transform:rotate(180deg)}",
      ".cxa-detail{padding:6px 16px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".cxa-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 28px}",
      ".cxa-part{display:flex;flex-direction:column;gap:8px;min-width:0}",
      ".cxa-part-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
      ".cxa-likely{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}",
      ".cxa-notes{grid-column:1/-1}",
      ".cxa-sub{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
      ".cxa-none{font-size:12px}",
      ".cxa-metrics{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;gap:4px 12px;margin:0;font-size:12px;line-height:18px}",
      ".cxa-metrics dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".cxa-metrics dd{margin:0;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
      ".cxa-mstatus{white-space:nowrap;text-align:right}",
      ".cxa-mstatus[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".cxa-mstatus[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
      ".cxa-mstatus[data-tone=bad]{color:var(--dsw-alias-state-error-primary)}",
      ".cxa-ev-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}",
      ".cxa-ev-list li{display:flex;gap:8px;align-items:baseline;color:var(--dsw-alias-label-secondary)}",
      ".cxa-ev-list li[data-level=hard] .cxa-ev-text{color:var(--dsw-alias-state-error-primary)}",
      ".cxa-ev-list li[data-level=soft] .cxa-ev-text{color:var(--dsw-alias-state-warn-primary)}",
      ".cxa-ev-list li[data-level=pass] .cxa-ev-text{color:var(--dsw-alias-state-success-primary)}",
      ".cxa-ev-list li[data-level=info] .cxa-ev-text{color:var(--dsw-alias-label-tertiary)}",
      ".cxa-card{display:flex;flex-direction:column;gap:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-hovercard-label-primary,var(--dsw-static-neutral-bluish-00,#fff))}",
      ".cxa-card-head{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".cxa-card-model{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cxa-card-site{color:var(--dsw-alias-hovercard-label-secondary,rgba(255,255,255,.6));overflow-wrap:anywhere}",
      ".cxa-card-rows{display:flex;flex-direction:column;gap:5px}",
      ".cxa-card-row{display:grid;grid-template-columns:56px minmax(0,1fr);gap:8px;align-items:baseline}",
      ".cxa-card-key{color:var(--dsw-alias-hovercard-label-secondary,rgba(255,255,255,.55));white-space:nowrap}",
      ".cxa-card-value{display:flex;flex-direction:column;min-width:0;overflow-wrap:anywhere}",
      ".cxa-card-state{display:inline-flex;align-items:center;gap:6px;font-weight:500}",
      ".cxa-card-state::before{content:\"\";flex:none;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.45)}",
      ".cxa-card-state[data-tone=ok]::before{background:var(--dsw-alias-state-success-primary,#30d158)}",
      ".cxa-card-state[data-tone=warn]::before{background:var(--dsw-alias-state-warn-primary,#ff9f0a)}",
      ".cxa-card-state[data-tone=bad]::before{background:var(--dsw-alias-state-error-primary,#ff453a)}",
      ".cxa-card-sub{color:var(--dsw-alias-hovercard-label-secondary,rgba(255,255,255,.6))}",
      ".cxa-card-error{color:var(--dsw-alias-hovercard-state-error,var(--dsw-alias-state-error-primary,#ff453a));overflow-wrap:anywhere}",
      ".cxa-card-foot{display:flex;flex-direction:column;gap:2px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);color:var(--dsw-alias-hovercard-label-tertiary,rgba(255,255,255,.45));font-size:11px;line-height:16px}",
      ".cxa-ev-text{flex:1;min-width:0;overflow-wrap:anywhere}",
      ".cxa-source{flex:none;font-size:11px;padding:0 6px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}",
      ".cxa-basis{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:help}",
      ".cxa-basis[data-basis=verified]{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}",
      ".cxa-settings{display:flex;flex-direction:column;gap:8px}",
      ".cxa-fp-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px}",
      ".cxa-row-run{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums;cursor:default}",
      ".cxa-row-run svg{color:var(--dsw-alias-state-business-primary);animation:cx-pulse .9s ease-in-out infinite}",
      "@container (max-width: 760px){.cxa-table .cx-tr{grid-template-columns:minmax(120px,2fr) minmax(96px,1fr) minmax(84px,1fr) 148px}.cxa-table .cx-tr>[role=cell]:nth-child(2),.cxa-table .cx-tr>[role=columnheader]:nth-child(2),.cxa-table .cx-tr>[role=cell]:nth-child(5),.cxa-table .cx-tr>[role=columnheader]:nth-child(5){display:none}.cxa-detail-grid{grid-template-columns:1fr}}",
      "@container cxview (max-width: 760px){.cx-shell{grid-template-columns:minmax(0,1fr);gap:16px}.cx-nav{position:static;flex-direction:row;overflow-x:auto;gap:4px;padding-bottom:4px;scrollbar-width:thin}.cx-nav-title,.cx-nav-group,.cx-nav-sep,.cx-nav-meta{display:none}.cx-nav-item{flex:none;width:auto;height:34px;padding:6px 12px}.cx-row4,.cx-row2,.cx-row3{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}",
    ].join("");
    const styleId = "dsh-custom-models/client.css";
    if (typeof document !== "undefined") {
      document.querySelector(`style[data-plugin-css=${JSON.stringify(styleId)}]`)?.remove();
      const style = document.createElement("style");
      style.dataset.pluginCss = styleId;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /** Register the dictionaries once per live mount (a duplicate registration throws). */
    function installLocale(ctx) {
      const locale = ctx.locale;
      if (locale === undefined || typeof locale.register !== "function") return;
      try {
        if (typeof locale.bind === "function" && locale.bind(NS)("tab.label") !== "tab.label") return;
      } catch {
        /* an unreadable locale face is not a reason to skip the registration */
      }
      try {
        ctx.effect(() => locale.register(NS, DICTS), "dsh-custom-models: locale namespace");
      } catch (error) {
        console.warn("dsh-custom-models: locale namespace already registered; reusing it", error);
      }
    }

    // ---------------------------------------------------------------- store

    let snapshot = { status: null, loading: false, checking: null, error: null, checkedAt: 0 };
    const listeners = new Set();
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const read = () => snapshot;
    const update = (patch) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of [...listeners]) listener();
    };
    const useStore = () => React.useSyncExternalStore(subscribe, read, read);

    let call = async () => {
      throw new Error("remote.customModels is not mounted");
    };

    /** Run one operation; a returned status replaces the shared one. */
    async function run(method, request) {
      const value = await call(method, request ?? {});
      if (value && typeof value === "object" && Array.isArray(value.sites)) update({ status: value, error: null });
      return value;
    }

    async function loadStatus() {
      if (snapshot.loading) return;
      update({ loading: true });
      try {
        await run("status");
      } catch (error) {
        update({ error: String(error?.message ?? error) });
      } finally {
        update({ loading: false });
      }
    }

    /** Check every key (or one site's): `funds` re-reads balances, `validity` + `deep` sends one tiny request each. */
    async function checkAll({ mode = "funds", deep = false, siteId } = {}) {
      if (snapshot.checking) return;
      update({ checking: mode });
      try {
        await run("checkKeys", { mode, ...(deep ? { deep: true } : {}), ...(siteId ? { siteId } : {}) });
        if (mode === "funds") update({ checkedAt: Date.now() });
      } catch (error) {
        update({ error: String(error?.message ?? error) });
      } finally {
        update({ checking: null });
      }
    }

    /** Keep the state live while a view is on screen: the status often, the balances every 5 minutes. */
    let watchers = 0;
    let statusTimer;
    let checkTimer;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const hasFunds = () => (snapshot.status?.keys ?? []).some((key) => key.funds);
    const onVisibility = () => {
      if (!visible()) return;
      void loadStatus();
      if (hasFunds() && Date.now() - snapshot.checkedAt > CHECK_INTERVAL_MS) void checkAll();
    };
    function watch() {
      watchers += 1;
      if (watchers === 1) {
        statusTimer = setInterval(() => { if (visible()) void loadStatus(); }, STATUS_INTERVAL_MS);
        checkTimer = setInterval(() => { if (visible() && hasFunds()) void checkAll(); }, CHECK_INTERVAL_MS);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
      }
      void loadStatus().then(() => {
        if (hasFunds() && Date.now() - snapshot.checkedAt > CHECK_INTERVAL_MS) void checkAll();
      });
      return () => {
        watchers -= 1;
        if (watchers === 0) {
          clearInterval(statusTimer);
          clearInterval(checkTimer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        }
      };
    }
    const useWatch = () => React.useEffect(() => watch(), []);

    // ---------------------------------------------------------- pure helpers

    function duration(t, ms) {
      if (!Number.isFinite(ms) || ms <= 60_000) return t("time.now");
      const minutes = Math.round(ms / 60_000);
      const d = Math.floor(minutes / 1440);
      const hh = Math.floor((minutes % 1440) / 60);
      const m = minutes % 60;
      if (d > 0) return t("time.days", { d, h: hh });
      if (hh > 0) return t("time.hours", { h: hh, m });
      return t("time.minutes", { m });
    }
    const since = (t, value, now = Date.now()) => duration(t, now - (typeof value === "number" ? value : Date.parse(value)));

    function clock(iso) {
      const date = new Date(iso);
      if (!Number.isFinite(date.getTime())) return "";
      const pad = (value) => String(value).padStart(2, "0");
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
    }

    /** A small sum in a currency: "$0.0042", "¥1.20", "12.3k tokens". */
    function amountText(value, currency = "USD") {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (currency === "tokens") return `${compact(value)} tokens`;
      const symbol = currency === "CNY" ? "¥" : "$";
      if (value === 0) return `${symbol}0`;
      const abs = Math.abs(value);
      return `${symbol}${abs >= 1 ? value.toFixed(2) : abs >= 0.01 ? value.toFixed(3) : value.toFixed(4)}`;
    }
    const usd = (value) => amountText(value, "USD");

    function compact(value) {
      const number = Number(value) || 0;
      if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`;
      if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}k`;
      return String(number);
    }
    const tokensOf = (bucket) => (Number(bucket?.input) || 0) + (Number(bucket?.output) || 0) + (Number(bucket?.cacheRead) || 0) + (Number(bucket?.cacheWrite) || 0);
    const keyTitle = (key) => key.label || key.masked;
    const unavailableError = (message) => /not mounted|invocation-unavailable|service-unavailable|definition-unavailable|binding-invalid/.test(String(message ?? ""));
    /** "0.412" — three significant digits are plenty for a price per million tokens. */
    const priceText = (value) => (typeof value === "number" && Number.isFinite(value) ? String(Number(value.toPrecision(3))) : "?");
    const contextText = (t, tokens) => (tokens >= 1e6 ? t("models.contextM", { m: Number((tokens / 1048576).toFixed(tokens % 1048576 ? 1 : 0)) }) : t("models.context", { k: Math.round(tokens / 1024) }));

    /** A key's status for its chip: tone, short label, and a full description. */
    function statusInfo(t, key, site, now = Date.now()) {
      const held = key.limitedUntil && Date.parse(key.limitedUntil) > now ? key.limitedUntil : null;
      const unproven = key.status === "ok" && !held && site?.modelsPublic && !key.probedAt;
      const valid = key.status === "ok" && !held && !key.probedAt && !unproven;
      const label = (() => {
        switch (key.status) {
          case "ok": return held ? t("status.held", { time: clock(held) }) : unproven ? t("status.unproven") : valid ? t("status.valid") : t("status.ok");
          case "no-balance": return t("status.no-balance");
          case "plan-quota": return t("status.plan-quota");
          case "invalid": return t("status.invalid");
          case "expired": return t("status.expired");
          case "restricted": return t("status.restricted");
          case "error": return t("status.error");
          default: return site?.modelsPublic ? t("status.unproven") : t("status.unknown");
        }
      })();
      const tone = key.status === "ok" ? (held ? "warn" : unproven || valid ? "neutral" : "ok") : key.status === "no-balance" || key.status === "invalid" || key.status === "expired" || key.status === "restricted" ? "bad" : key.status === "plan-quota" ? "warn" : "neutral";
      const parts = [label];
      if (key.statusMessage && key.status !== "ok") parts.push(key.statusMessage);
      if (unproven || (key.status === "unknown" && site?.modelsPublic)) parts.push(t("status.unprovenHint"));
      else if (valid) parts.push(t("status.validHint"));
      if (key.status === "ok" && !held && key.probedAt && key.probeModel) parts.push(t("status.probed", { model: key.probeModel, time: since(t, key.probedAt, now) }));
      if (key.probeError) parts.push(t("status.probeError", { message: key.probeError }));
      if (key.limitedUpfront) parts.push(t("status.upfront"));
      if (key.probeNote) parts.push(key.probeNote);
      if (key.validityError && key.status !== "error") parts.push(t("status.lastError", { message: key.validityError }));
      if (key.quotaError) parts.push(t("funds.failedLine", { label: t("funds.failed"), error: key.quotaError }));
      if (key.status === "restricted") parts.push(t("status.restrictedHint"));
      if (["no-balance", "plan-quota", "invalid", "expired", "restricted"].includes(key.status)) parts.push(t("status.manual"));
      parts.push(key.checkedAt ? t("status.checked", { time: since(t, key.checkedAt, now) }) : t("status.never"));
      return { tone, label, detail: parts.join("\n") };
    }

    /** What a balance cell shows: the amount, a note beside it, its hover text. */
    function balanceView(t, balance) {
      if (!balance) return null;
      if (balance.currency === "credits") {
        return { amount: typeof balance.amount === "number" ? t("balance.credits", { amount: compact(balance.amount) }) : "—", note: null, title: typeof balance.usd === "number" ? t("balance.creditsTitle", { usd: usd(balance.usd) }) : undefined };
      }
      const currency = balance.currency ?? "USD";
      const used = typeof balance.used === "number" ? t("balance.used", { amount: amountText(balance.used, currency) }) : typeof balance.totalUsed === "number" ? t("balance.used", { amount: usd(balance.totalUsed) }) : null;
      // A plan's spend windows (sub2api: a key's 5 hours / day / 7 days, a subscription's day / week / month).
      const windows = Array.isArray(balance.windows) ? balance.windows.filter((item) => typeof item.limit === "number") : [];
      const windowLine = (item) => t(item.resetAt ? "balance.windowAt" : "balance.window", { window: t(`balance.window.${item.id}`), used: amountText(item.used ?? 0, currency), limit: amountText(item.limit, currency), time: item.resetAt ? clock(item.resetAt) : "" });
      const today = balance.today ? t("balance.siteToday", { requests: compact(balance.today.requests ?? 0), tokens: compact(balance.today.tokens ?? 0), cost: typeof balance.today.cost === "number" ? amountText(balance.today.cost, currency) : "—" }) : null;
      // new-api: the account's balance read through the key, with the token's own quota beside it; or how to show it.
      const token = balance.token
        ? (balance.token.unlimited ? t("balance.tokenUnlimited", { used: amountText(balance.token.used ?? 0, currency) }) : t("balance.tokenLine", { left: typeof balance.token.amount === "number" ? amountText(balance.token.amount, currency) : "—", used: amountText(balance.token.used ?? 0, currency) }))
        : null;
      // sub2api: what the key's spend is billed at, and its peak hours.
      const rate = (value) => String(Number(Number(value).toPrecision(3)));
      const billing = balance.billing
        ? (balance.billing.peak ? t("balance.billingPeak", { rate: rate(balance.billing.resolved ?? balance.billing.effective), start: balance.billing.peak.start, end: balance.billing.peak.end, peak: rate(balance.billing.peak.multiplier), zone: balance.billing.timezone ?? "UTC" }) : t("balance.billing", { rate: rate(balance.billing.resolved ?? balance.billing.effective) }))
        : null;
      // CRS: its rate window's request and token counts, the clients a key is restricted to, its concurrency.
      const rateLines = balance.rate ? [
        balance.rate.requests ? t("balance.rateRequests", { minutes: balance.rate.minutes, used: compact(balance.rate.requests.used), limit: compact(balance.rate.requests.limit) }) : null,
        balance.rate.tokens ? t("balance.rateTokens", { minutes: balance.rate.minutes, used: compact(balance.rate.tokens.used), limit: compact(balance.rate.tokens.limit) }) : null,
      ] : [];
      const title = [balance.plan ? t("balance.plan", { name: balance.plan }) : null, balance.scope === "account" && balance.token ? t("balance.accountScope") : null, token, balance.scope === "key" ? (balance.accountHint ? t("balance.accountHint") : t("balance.keyScope")) : null, ...windows.map(windowLine), ...rateLines, billing, balance.clients ? t("balance.clients", { clients: balance.clients.join(", ") }) : null, balance.concurrency ? t("balance.concurrency", { n: balance.concurrency }) : null, balance.expiresAt ? t("balance.expires", { time: clock(balance.expiresAt) }) : null, today].filter(Boolean).join("\n") || undefined;
      const full = windows.some((item) => (item.used ?? 0) >= item.limit);
      // No total to show: the tightest window's room stands in for it.
      const tightest = windows.slice().sort((a, b) => (a.limit - (a.used ?? 0)) - (b.limit - (b.used ?? 0)))[0];
      if (balance.unlimited && tightest) return { amount: amountText(Math.max(0, tightest.limit - (tightest.used ?? 0)), currency), note: t("balance.windowLeft", { window: t(`balance.window.${tightest.id}`) }), title, low: full };
      if (balance.unlimited) return { amount: t("balance.unlimited"), note: used, title };
      return { amount: typeof balance.amount === "number" ? amountText(balance.amount, currency) : "—", note: used, title, low: full || (typeof balance.amount === "number" && balance.amount < (currency === "CNY" ? 5 : 1) && currency !== "tokens") };
    }

    /** What a relay says of a price beside the rates: per request, the group, the key's multiplier and peak hours, tiers, an estimate. */
    function relayPriceNotes(t, cost, money = siteCurrency(null)) {
      if (!cost) return null;
      const symbol = cost.unit === "quota" ? money.symbol : "$";
      const scale = cost.unit === "quota" ? money.rate : 1;
      return [
        typeof cost.perRequest === "number" ? t("price.perRequest", { price: `${symbol}${priceText(cost.perRequest * scale)}` }) : null,
        cost.group ? t("price.group", { group: cost.group }) : null,
        typeof cost.rate === "number" && cost.rate !== 1 ? t("price.rate", { rate: String(Number(cost.rate.toPrecision(3))) }) : null,
        cost.peak ? t("price.peak", { start: cost.peak.start, end: cost.peak.end, multiplier: String(Number(Number(cost.peak.multiplier).toPrecision(3))) }) : null,
        cost.expr ? t("price.expr") : null,
        cost.estimated ? t("price.estimated") : null,
      ].filter(Boolean).join("\n") || null;
    }

    /** The currency a site counts its quota in: a new-api site set to CNY converts at its own rate; else dollars. */
    function siteCurrency(platformInfo) {
      const rate = Number(platformInfo?.rate);
      return platformInfo?.display === "CNY" && rate > 0 ? { currency: "CNY", symbol: "¥", rate } : { currency: "USD", symbol: "$", rate: 1 };
    }

    /** Where a model's context came from (a reference figure is capped at the site's default) and where DSH compacts. */
    function contextTitle(t, model) {
      const at = model.compactAt ? contextText(t, model.compactAt) : "—";
      const main = model.contextListed ? t("models.ctxCapped", { listed: contextText(t, model.contextListed), applied: contextText(t, model.context), at })
        : model.contextOrigin === "measured" ? t("models.ctxMeasured", { how: t(`models.measured.${model.contextMeasured ?? "probe"}`), at })
        : model.contextOrigin === "reference" ? t("models.ctxReference", { at })
          : model.contextOrigin === "none" ? t("models.ctxDefault", { at })
            : model.compactAt ? t("models.ctxKnown", { at }) : undefined;
      const suggested = model.contextSuggested && model.context && model.contextSuggested < model.context ? t("models.ctxSuggested", { suggested: contextText(t, model.contextSuggested) }) : null;
      return [main, suggested].filter(Boolean).join(" ") || undefined;
    }

    /** A model's tags in a card: context, image, thinking, price (or 免费), where its description came from. */
    function modelTags(t, model, money = siteCurrency(null)) {
      const tags = [];
      if (model.context) tags.push({ key: "ctx", text: contextText(t, model.context), title: contextTitle(t, model) });
      if (model.image) tags.push({ key: "image", text: t("models.image") });
      else if (model.imageRefused) tags.push({ key: "image", text: t("models.textOnly"), title: t("models.textOnlyTitle") });
      if (model.reasoning) tags.push({ key: "thinking", text: t("models.thinking"), title: [...(model.reasoning.off ? ["off"] : []), ...(model.reasoning.levels ?? [])].join(" / ") });
      const cost = model.cost;
      if (cost && cost.input === 0 && cost.output === 0) tags.push({ key: "free", text: t("models.free"), tone: "free" });
      else if (cost) tags.push(cost.unit === "quota"
        ? { key: "price", text: t("models.quotaPrice", { symbol: money.symbol, input: priceText(cost.input * money.rate), output: priceText(cost.output * money.rate) }), title: t("models.quotaPriceTitle") }
        : { key: "price", text: t("models.price", { input: priceText(cost.input), output: priceText(cost.output) }), title: t("models.priceTitle") });
      if (model.protocol) tags.push({ key: "protocol", text: PROTOCOL_SHORT[model.protocol] ?? model.protocol });
      if (model.unusable) tags.push({ key: "unusable", text: t("models.unusable"), tone: "warn", title: model.unusable });
      // DSH 0.2.2 won't switch a conversation to it midway (a desktop profile cannot change that: compaction lives in the agent presets).
      if (model.switchLimit) tags.push({ key: "switch", text: t("models.switch"), tone: "warn", title: t("models.switchTitle") });
      return tags;
    }
    const tagNodes = (tags) => tags.map((tag) => h("span", { key: tag.key, className: "cx-model-tag", "data-tone": tag.tone, title: tag.title }, tag.text));

    /** A discovered model as the host takes it (no fields beyond the model's own). */
    function modelPayload(model) {
      const out = { id: model.id };
      for (const field of ["name", "protocol", "context", "contextFrom", "contextSuggested", "output", "image", "reasoning", "cost", "flags", "endpoints", "source"]) if (model[field] !== undefined && model[field] !== null) out[field] = model[field];
      return out;
    }

    /** `Name: value` lines → a headers map (blank and malformed lines skipped). */
    function headersOf(text) {
      const out = {};
      for (const line of String(text ?? "").split(/\r?\n/)) {
        const match = /^\s*([A-Za-z0-9-]{1,64})\s*:\s*(.*?)\s*$/.exec(line);
        if (match && match[2]) out[match[1]] = match[2];
      }
      return out;
    }
    const headersText = (headers) => Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\n");

    /**
     * The host's rule (endpoints.js `isPrivateHost`), repeated here so the dialog can ask before
     * anything is sent: this machine, private and overlay networks (Tailscale's 100.64.0.0/10),
     * link-local, `.local`-style and single-label names.
     */
    const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".home.arpa", ".corp"];
    function isPrivateHost(hostname) {
      const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
      if (!host) return false;
      if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
      if (v4) {
        const a = Number(v4[1]);
        const b = Number(v4[2]);
        return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
          || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a === 0;
      }
      if (host.includes(":")) return host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host) || /^::ffff:(127|10|192\.168)\./.test(host);
      return !host.includes(".");
    }
    /** Plain HTTP to a public host: unencrypted across the internet, so the dialog asks first. */
    function isPublicHttp(value) {
      try {
        const url = new URL(String(value ?? "").trim());
        return url.protocol === "http:" && !isPrivateHost(url.hostname);
      } catch {
        return false;
      }
    }
    /** The hover text of a site's `http` tag. */
    const httpTitle = (t, site) => [
      site.publicHttp ? t("http.publicTitle") : t("http.privateTitle"),
      site.httpProxied === false ? t("http.direct") : site.httpProxied === true ? t("http.proxied") : null,
    ].filter(Boolean).join("\n");

    /** A site id from a display name or an address, unique among `taken` (as the host suggests one). */
    function suggestId(text, taken = []) {
      let base = String(text ?? "").toLowerCase();
      try {
        if (/^https?:\/\//.test(base)) base = new URL(base).hostname.replace(/^(api|www)\./, "").split(".").slice(0, -1).join("-") || new URL(base).hostname;
      } catch {
        /* plain text */
      }
      base = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 32) || "site";
      let id = base;
      for (let n = 2; taken.includes(id) || RESERVED_SITE_IDS.includes(id); n += 1) id = `${base}-${n}`;
      return id;
    }

    function reordered(ids, dragId, targetId, after) {
      if (dragId === targetId || !ids.includes(dragId) || !ids.includes(targetId)) return null;
      const rest = ids.filter((id) => id !== dragId);
      const at = rest.indexOf(targetId) + (after ? 1 : 0);
      const next = [...rest.slice(0, at), dragId, ...rest.slice(at)];
      return next.every((id, index) => id === ids[index]) ? null : next;
    }
    function moved(ids, id, delta) {
      const from = ids.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return null;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, id);
      return next;
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* fall back below */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.appendChild(area);
        area.select();
        const done = document.execCommand("copy");
        area.remove();
        return done;
      } catch {
        return false;
      }
    }

    const Grip = () => h("svg", { width: 10, height: 16, viewBox: "0 0 10 16", fill: "currentColor", "aria-hidden": true },
      [3, 8, 13].flatMap((cy) => [h("circle", { key: `l${cy}`, cx: 2.5, cy, r: 1.3 }), h("circle", { key: `r${cy}`, cx: 7.5, cy, r: 1.3 })]));
    const CopyIcon = () => h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }), h("path", { d: "M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" }));
    const PenIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M10.5 2.5l3 3L6 13H3v-3z" }));
    const TrashIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" }));
    const ShieldIcon = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M8 1.8l5 2v3.6c0 3.1-2.1 5.6-5 6.8-2.9-1.2-5-3.7-5-6.8V3.8z" }), h("path", { d: "M5.8 8.1l1.6 1.6 3-3.2" }));
    const errorLine = (t, error) => (error ? h("div", { className: "cx-error", role: "alert" }, t("error.generic", { message: error })) : null);

    // ------------------------------------------------------------ components

    function FundsCell({ t, keyInfo: key }) {
      const failed = key.quotaError ? h("span", { className: "cx-failed", title: key.quotaError }, t("funds.failed")) : null;
      const view = balanceView(t, key.balance);
      if (!view) return h("div", { className: "cx-funds" }, failed ?? h("span", { className: "cx-muted", title: key.quotaHint ?? undefined }, t("balance.none")));
      // A relay refused for the account's money while the token itself reads unlimited (or has quota left).
      const accountEmpty = key.status === "no-balance" && key.limitedScope === "account" && (key.balance.unlimited === true || key.balance.scope === "key");
      return h("div", { className: "cx-funds", "data-stale": failed ? "true" : "false", title: accountEmpty ? [t("balance.accountEmpty"), view.title].filter(Boolean).join("\n") : view.title },
        h("span", { className: `cx-amount${view.low || accountEmpty ? " cx-warn" : ""}` }, view.amount),
        view.note ? h("span", { className: "cx-muted" }, view.note) : null,
        failed);
    }

    function KeyRow({ t, keyInfo: key, site, drag, onRename }) {
      const [busy, setBusy] = React.useState(null);
      const [confirming, setConfirming] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [copied, setCopied] = React.useState(false);
      const info = statusInfo(t, key, site);
      const dead = key.status === "invalid" || key.status === "expired" || key.status === "restricted";
      const quota = site.models.some((model) => model.cost?.unit === "quota");
      const money = quota ? siteCurrency(site.platformInfo) : siteCurrency(null);
      const spent = (value) => amountText((Number(value) || 0) * money.rate, money.currency);
      const act = async (method, request) => {
        setError(null);
        try {
          await run(method, request);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };
      const check = async (mode) => {
        setBusy(mode);
        await act("checkKeys", { keyIds: [key.id], mode, ...(mode === "validity" ? { deep: true } : {}) });
        setBusy(null);
      };
      const day = key.usage?.day;
      const month = key.usage?.month;
      return h("li", {
        className: "cx-key",
        "data-active": key.active ? "true" : "false",
        "data-dead": dead ? "true" : "false",
        "data-dragging": drag?.dragging ? "true" : "false",
        "data-drop": drag?.drop ?? undefined,
        onDragOver: drag?.onDragOver,
        onDrop: drag?.onDrop,
      },
        drag?.enabled ? h("span", {
          className: "cx-grip",
          role: "button",
          tabIndex: 0,
          draggable: true,
          title: t("key.drag"),
          "aria-label": t("key.drag"),
          onKeyDown: (event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            drag.onMove(event.key === "ArrowUp" ? -1 : 1);
          },
          onDragStart: drag.onDragStart,
          onDragEnd: drag.onDragEnd,
        }, h(Grip)) : null,
        h("div", { className: "cx-line1" },
          key.label ? h("span", { className: "cx-name-text", title: key.label }, key.label) : null,
          h("code", { className: "cx-full" }, key.key ?? key.masked),
          key.key ? h("button", {
            type: "button",
            className: "cx-copy",
            title: copied ? t("key.copied") : t("key.copy"),
            "aria-label": t("key.copy"),
            "data-copied": copied ? "true" : "false",
            onClick: async () => {
              if (await copyText(key.key ?? "")) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            },
          }, copied ? "✓" : h(CopyIcon)) : null),
        h("div", { className: "cx-grid" },
          h("div", null, h("span", { className: "cx-chip", "data-tone": info.tone, title: info.detail }, info.label)),
          site.showsBalance ? h(FundsCell, { t, keyInfo: key }) : null,
          h("div", {
            className: "cx-usage",
            title: month ? `${t("usage.month", { requests: month.requests ?? 0, tokens: compact(tokensOf(month)), cost: spent(month.cost) })}${quota ? t("usage.quotaNote") : ""}` : undefined,
          }, day?.requests ? [t("usage.today", { requests: day.requests, tokens: compact(tokensOf(day)) }), day.cost > 0 ? t("usage.cost", { cost: spent(day.cost) }) : null].filter(Boolean).join(" · ") : t("usage.none")),
          h("div", { className: "cx-actions" },
            h("span", { className: "cx-slot" }, key.active
              ? h("span", { className: "cx-badge" }, t("key.active"))
              : h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", onClick: () => void act("switchKey", { keyId: key.id }) }, t("key.switch"))),
            h("button", { type: "button", className: "cx-icon", title: t("key.validate"), "aria-label": t("key.validate"), "aria-busy": busy === "validity", disabled: busy !== null, "data-pulse": busy === "validity" ? "true" : "false", onClick: () => void check("validity") }, h(ShieldIcon)),
            h("button", { type: "button", className: "cx-icon", title: key.funds ? t("key.funds") : t("key.noFunds"), "aria-label": t("key.funds"), "aria-busy": busy === "funds", disabled: busy !== null || !key.funds, "data-spin": busy === "funds" ? "true" : "false", onClick: () => void check("funds") }, h(P.IconRefreshOutlineRegular, { size: 14 })),
            h("button", { type: "button", className: "cx-icon", title: t("key.edit"), "aria-label": t("key.edit"), onClick: () => onRename(key) }, h(PenIcon)),
            h("button", {
              type: "button",
              className: "cx-icon",
              "data-confirm": confirming ? "true" : "false",
              title: t("key.remove"),
              "aria-label": confirming ? t("key.removeConfirm") : t("key.remove"),
              onClick: () => {
                if (!confirming) {
                  setConfirming(true);
                  setTimeout(() => setConfirming(false), 4000);
                  return;
                }
                void act("removeKey", { keyId: key.id });
              },
            }, confirming ? t("key.removeConfirm") : h(TrashIcon)))),
        error ? h("div", { className: "cx-error cx-note", role: "alert" }, t("error.generic", { message: error })) : null);
    }

    /** One model card: a checkbox (choosing) or edit / remove tools (added). */
    function ModelCard({ t, model, money, checked, onToggle, onEdit, onRemove }) {
      const sourceTitle = model.source === "reference" ? t("models.reference") : model.source === "manual" && !model.context ? t("models.manual") : undefined;
      const title = h("span", { className: "cx-model-title", title: sourceTitle }, model.name ?? model.id);
      return h("div", { className: "cx-model-card", "data-selected": checked ? "true" : undefined, title: model.id },
        onToggle
          ? h(P.Checkbox, { className: "cx-model-name", checked: Boolean(checked), label: model.name ?? model.id, onChange: (next) => onToggle(next) })
          : title,
        model.name && model.name !== model.id ? h("span", { className: "cx-model-id" }, model.id) : null,
        h("div", { className: "cx-model-meta" }, tagNodes(modelTags(t, model, money))),
        onEdit || onRemove ? h("div", { className: "cx-model-tools" },
          onEdit ? h("button", { type: "button", className: "cx-icon", title: t("models.edit"), "aria-label": t("models.edit"), onClick: onEdit }, h(PenIcon)) : null,
          onRemove ? h("button", { type: "button", className: "cx-icon", title: t("models.remove"), "aria-label": t("models.remove"), onClick: onRemove }, h(TrashIcon)) : null) : null);
    }

    /** A searchable grid of discovered models to choose from. */
    function ModelChooser({ t, models, money, chosen, onChange }) {
      const [query, setQuery] = React.useState("");
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const shown = models.filter((model) => words.every((word) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(word)));
      const set = (ids, next) => {
        const out = new Set(chosen);
        for (const id of ids) {
          if (next) out.add(id);
          else out.delete(id);
        }
        onChange(out);
      };
      return h(React.Fragment, null,
        h("div", { className: "cx-inline" },
          models.length > 12 ? h("input", { className: "cx-text cx-search", type: "search", value: query, placeholder: t("models.search"), "aria-label": t("models.search"), spellCheck: false, onChange: (event) => setQuery(event.target.value) }) : null,
          h("button", { type: "button", className: "cx-link", onClick: () => set(shown.map((model) => model.id), true) }, t("models.all")),
          h("button", { type: "button", className: "cx-link", onClick: () => set(shown.map((model) => model.id), false) }, t("models.none")),
          h("span", { className: "cx-muted" }, t("dialog.selected", { count: chosen.size }))),
        h("div", { className: "cx-model-grid" }, shown.map((model) => h(ModelCard, { key: model.id, t, model, money, checked: chosen.has(model.id), onToggle: (next) => set([model.id], next) }))));
    }

    /**
     * A site's form, on its own page. Adding one: DSH's own form (id, name, address, protocol, keys),
     * then "获取可用模型" and the models to add. A saved one's settings: no keys, no catalog (the
     * site's page has both); its buttons show once something changed.
     */
    function SiteForm({ t, status, site, onSaved, onCancel }) {
      const editing = Boolean(site);
      const taken = (status?.sites ?? []).map((item) => item.id);
      const limits = site?.limits ?? {};
      const defaults = limits.defaults ?? { defaultContext: 262144, imageBudget: 20971520, imageMaxBytes: 1048576 };
      // The site's values in the units shown (K tokens, MB, KB); empty is the default.
      const savedValues = () => ({
        name: site?.name ?? "",
        baseUrl: site?.baseUrl ?? "",
        protocol: PROTOCOLS.includes(site?.protocol) ? site.protocol : "chat",
        keyless: site?.keyless === true,
        headers: headersText(site?.headers),
        contextK: limits.defaultContext ? String(Math.round(limits.defaultContext / 1024)) : "",
        budgetMb: limits.imageBudget ? String(Number((limits.imageBudget / 1048576).toFixed(1))) : "",
        imageKb: limits.imageMaxBytes ? String(Math.round(limits.imageMaxBytes / 1024)) : "",
        allowHttp: site?.allowHttp === true,
        resetLearned: false,
      });
      const [values, setValues] = React.useState(savedValues);
      const set = (patch) => setValues((current) => ({ ...current, ...patch }));
      const { name, baseUrl, protocol, keyless, headers, contextK, budgetMb, imageKb, allowHttp, resetLearned } = values;
      const [id, setId] = React.useState("");
      const [idTouched, setIdTouched] = React.useState(false);
      const [keys, setKeys] = React.useState("");
      const [advanced, setAdvanced] = React.useState(Boolean(site && (Object.keys(site.headers ?? {}).length || limits.defaultContext || limits.imageBudget || limits.imageMaxBytes || limits.imageBudgetLearned)));
      const [found, setFound] = React.useState(null);
      const [chosen, setChosen] = React.useState(new Set());
      const [manual, setManual] = React.useState("");
      const [extra, setExtra] = React.useState([]);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [saved, setSaved] = React.useState(false);
      const scaled = (text, unit) => {
        const value = Number(String(text).replace(/[,_\s]/g, ""));
        return String(text).trim() === "" || !(value > 0) ? null : Math.round(value * unit);
      };
      // Public plain HTTP: confirmed per site; nothing is sent over it before that.
      const publicHttp = isPublicHttp(baseUrl);
      const httpBlocked = publicHttp && !allowHttp;
      const httpFlag = publicHttp ? { allowHttp } : {};
      // A name without latin letters names nothing an id can carry: the address does.
      const autoId = suggestId(/[a-z]/i.test(name) ? name : baseUrl || name, taken);
      const siteId = idTouched ? id : autoId;
      const idBad = !editing && (!SITE_ID_PATTERN.test(siteId) || RESERVED_SITE_IDS.includes(siteId));
      const dirty = editing && JSON.stringify({ ...values, name: name.trim(), baseUrl: baseUrl.trim(), headers: headersText(headersOf(headers)) }) !== JSON.stringify(savedValues());
      const fetchModels = async () => {
        setBusy("fetch");
        setError(null);
        try {
          const value = await run("discoverModels", { baseUrl, protocol, ...httpFlag, ...(keys.trim() ? { key: keys.trim().split(/\r?\n/)[0] } : {}), ...(advanced ? { headers: headersOf(headers) } : {}) });
          const discovered = value?.discovered;
          setFound(discovered);
          if (!discovered?.ok && !discovered?.needsHttpConfirm) setError(discovered?.error ?? "—");
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(null);
        }
      };
      const addManual = () => {
        const value = manual.trim();
        if (!value || extra.some((model) => model.id === value)) return;
        setExtra([...extra, { id: value, source: "manual" }]);
        setChosen(new Set([...chosen, value]));
        setManual("");
      };
      /** The limits as the host takes them: a number sets one, null goes back to the default; an unchanged budget leaves a 413's figure alone. */
      const limitsPayload = () => {
        const out = { defaultContext: scaled(contextK, 1024), imageMaxBytes: scaled(imageKb, 1024) };
        const budget = scaled(budgetMb, 1048576);
        if (budget !== (limits.imageBudget ?? null)) out.imageBudget = budget;
        if (resetLearned) out.resetImageBudget = true;
        return out;
      };
      const save = async () => {
        setBusy("save");
        setError(null);
        try {
          const models = [...(found?.models ?? []), ...extra].filter((model) => chosen.has(model.id)).map(modelPayload);
          const value = await run("saveSite", {
            ...(editing ? { id: site.id } : { newId: siteId }),
            name: name.trim() || undefined,
            baseUrl,
            protocol,
            keyless,
            ...httpFlag,
            ...(advanced ? { headers: headersOf(headers) } : {}),
            ...(advanced ? limitsPayload() : {}),
            ...(!editing && keys.trim() ? { keys } : {}),
            ...(models.length ? { models } : {}),
            ...(found?.ok ? { detected: { platform: found.platform, ...(found.platformInfo ? { platformInfo: found.platformInfo } : {}), modelsPublic: found.modelsPublic === true } } : {}),
          });
          if (editing) {
            set({ resetLearned: false });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          }
          onSaved?.(value?.saved ?? site?.id);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(null);
        }
      };
      const field = (key, label, input, title) => h("div", { className: "cx-field", key },
        h("label", { htmlFor: input.props.id, title }, label),
        input);
      const fields = h(React.Fragment, null,
        h("div", { className: "cx-row2" },
          editing
            ? field("id", t("dialog.id"), h("input", { id: `cx-site-id-${site.id}`, className: "cx-text", value: site.id, readOnly: true, "aria-readonly": "true", title: t("settings.idFixed") }), t("settings.idFixed"))
            : field("id", t("dialog.id"), h("input", { id: "cx-site-id", className: "cx-text", value: siteId, placeholder: "acme-gateway", maxLength: 40, spellCheck: false, autoComplete: "off", "aria-invalid": idBad ? "true" : "false", title: t("dialog.idHint"), onChange: (event) => { setIdTouched(true); setId(event.target.value.toLowerCase()); } }), t("dialog.idHint")),
          field("name", t("dialog.name"), h("input", { id: editing ? `cx-site-name-${site.id}` : "cx-site-name", className: "cx-text", value: name, maxLength: 60, placeholder: t("dialog.name"), ...(editing ? {} : { "data-modal-autofocus": true }), onChange: (event) => set({ name: event.target.value }) }))),
        field("url", t("dialog.baseUrl"), h("input", { id: editing ? `cx-site-url-${site.id}` : "cx-site-url", className: "cx-text", value: baseUrl, placeholder: "https://gateway.example/v1", maxLength: 500, spellCheck: false, autoComplete: "off", onChange: (event) => { set({ baseUrl: event.target.value }); if (!editing) setFound(null); } })),
        publicHttp ? h("div", { className: "cx-http-note", role: "note" },
          h("span", null, t("http.warn")),
          found?.httpsAlternative ? h("div", { className: "cx-inline" },
            h("span", null, t("http.httpsWorks")),
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", onClick: () => { set({ baseUrl: found.httpsAlternative }); setFound(null); setError(null); } }, t("http.useHttps"))) : null,
          h("label", { className: "cx-check" },
            h("input", { type: "checkbox", checked: allowHttp, onChange: (event) => set({ allowHttp: event.target.checked }) }),
            t("http.confirm"))) : null,
        h("div", { className: "cx-row2" },
          field("protocol", t("dialog.protocol"), h("select", { id: editing ? `cx-site-protocol-${site.id}` : "cx-site-protocol", className: "cx-select", value: protocol, onChange: (event) => set({ protocol: event.target.value }) },
            PROTOCOLS.map((item) => h("option", { key: item, value: item }, PROTOCOL_NAMES[item])))),
          h("div", { className: "cx-field cx-field-end" },
            h("label", { className: "cx-check", title: t("site.keylessTitle") }, h("input", { type: "checkbox", checked: keyless, onChange: (event) => set({ keyless: event.target.checked }) }), t("dialog.keyless")))),
        editing ? null : field("keys", t("dialog.keys"), h("textarea", { id: "cx-site-keys", className: "cx-textarea", value: keys, placeholder: t("dialog.keysPlaceholder"), spellCheck: false, autoComplete: "off", disabled: keyless, onChange: (event) => setKeys(event.target.value) })),
        h("button", { type: "button", className: "cx-link", "aria-expanded": advanced ? "true" : "false", onClick: () => setAdvanced(!advanced) }, `${advanced ? "▾" : "▸"} ${t("dialog.advanced")}`),
        advanced ? field("headers", t("dialog.headers"), h("textarea", { id: editing ? `cx-site-headers-${site.id}` : "cx-site-headers", className: "cx-textarea", value: headers, placeholder: t("dialog.headersPlaceholder"), spellCheck: false, onChange: (event) => set({ headers: event.target.value }) })) : null,
        advanced ? h("div", { className: "cx-row3" },
          field("context", t("dialog.defaultContext"), h("input", { id: editing ? `cx-site-context-${site.id}` : "cx-site-context", className: "cx-text", value: contextK, inputMode: "numeric", placeholder: String(Math.round(defaults.defaultContext / 1024)), title: t("dialog.defaultContextTitle", { value: Math.round(defaults.defaultContext / 1024) }), onChange: (event) => set({ contextK: event.target.value }) }), t("dialog.defaultContextTitle", { value: Math.round(defaults.defaultContext / 1024) })),
          field("budget", t("dialog.imageBudget"), h("input", { id: editing ? `cx-site-image-budget-${site.id}` : "cx-site-image-budget", className: "cx-text", value: budgetMb, inputMode: "decimal", placeholder: String(Math.round(defaults.imageBudget / 1048576)), title: t("dialog.imageBudgetTitle", { value: Math.round(defaults.imageBudget / 1048576) }), onChange: (event) => set({ budgetMb: event.target.value }) }), t("dialog.imageBudgetTitle", { value: Math.round(defaults.imageBudget / 1048576) })),
          field("image", t("dialog.imageMaxBytes"), h("input", { id: editing ? `cx-site-image-max-${site.id}` : "cx-site-image-max", className: "cx-text", value: imageKb, inputMode: "numeric", placeholder: String(Math.round(defaults.imageMaxBytes / 1024)), title: t("dialog.imageMaxBytesTitle", { value: Math.round(defaults.imageMaxBytes / 1024) }), onChange: (event) => set({ imageKb: event.target.value }) }), t("dialog.imageMaxBytesTitle", { value: Math.round(defaults.imageMaxBytes / 1024) }))) : null,
        advanced && limits.imageBudgetLearned && !resetLearned ? h("div", { className: "cx-inline cx-muted" },
          h("span", null, t("dialog.learned", { size: `${(limits.imageBudgetLearned / 1048576).toFixed(1)} MB` })),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", onClick: () => set({ resetLearned: true }) }, t("dialog.learnedReset"))) : null);
      if (editing) {
        return h("section", { className: "cx-card", "aria-label": t("settings.title") },
          h("div", { className: "cx-card-head" }, h("span", { className: "cx-card-title" }, t("settings.title"))),
          h("div", { className: "cx-card-body cx-dialog" },
            fields,
            status?.authnEnabled ? h("label", { className: "cx-check", title: t("site.authnTitle") },
              h("input", { type: "checkbox", checked: site.authn !== false, onChange: (event) => void run("setSiteAuthn", { siteId: site.id, on: event.target.checked }).catch((failure) => setError(String(failure?.message ?? failure))) }),
              t("site.authn")) : null,
            errorLine(t, error),
            dirty || saved ? h("div", { className: "cx-form-actions" },
              saved && !dirty ? h("span", { className: "cx-ok", role: "status" }, t("settings.saved")) : null,
              dirty ? h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy !== null, onClick: () => { setValues(savedValues()); setError(null); } }, t("settings.revert")) : null,
              dirty ? h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy !== null || !baseUrl.trim() || httpBlocked, title: httpBlocked ? t("http.confirmFirst") : undefined, onClick: () => void save() }, busy === "save" ? t("dialog.saving") : t("dialog.save")) : null) : null));
      }
      const listed = [...(found?.models ?? []).filter((model) => !model.added), ...extra];
      return h(React.Fragment, null,
        h("section", { className: "cx-card", "aria-label": t("add.site") },
          h("div", { className: "cx-card-head" }, h("span", { className: "cx-card-title" }, t("add.site"))),
          h("div", { className: "cx-card-body cx-dialog" }, fields)),
        h("section", { className: "cx-card", "aria-label": t("dialog.catalog") },
          h("div", { className: "cx-card-head" },
            h("span", { className: "cx-card-title" }, t("dialog.catalog")),
            found?.ok ? h("span", { className: "cx-muted" }, t("dialog.found", { platform: found.platformInfo?.name ?? platformName(t, found.platform), count: found.models.length })) : null,
            found?.ok && found.keyAccepted === false ? h("span", { className: "cx-error" }, t("dialog.keyRejected")) : null,
            h("span", { className: "cx-spacer" }),
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), disabled: busy !== null || !baseUrl.trim(), onClick: () => void fetchModels() }, busy === "fetch" ? t("dialog.fetching") : t("dialog.fetch"))),
          h("div", { className: "cx-card-body cx-dialog" },
            listed.length ? h(ModelChooser, { t, models: listed, money: siteCurrency(found?.platformInfo), chosen, onChange: setChosen }) : h("div", { className: "cx-placeholder" }, t("dialog.fetchFirst")),
            h("div", { className: "cx-inline" },
              h("input", { className: "cx-text cx-grow", value: manual, placeholder: t("dialog.manual"), "aria-label": t("dialog.manual"), maxLength: 200, spellCheck: false, onChange: (event) => setManual(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") addManual(); } }),
              h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: !manual.trim(), onClick: addManual }, t("dialog.manualAdd"))))),
        errorLine(t, error),
        h("div", { className: "cx-form-actions" },
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy !== null, onClick: onCancel }, t("dialog.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy !== null || !baseUrl.trim() || idBad || httpBlocked, title: httpBlocked ? t("http.confirmFirst") : undefined, onClick: () => void save() }, busy === "save" ? t("dialog.saving") : t("dialog.save"))));
    }

    const PLATFORM_NAMES = { newapi: "new-api", sub2api: "sub2api", crs: "CRS", hyper: "Charm Hyper", vercel: "Vercel AI Gateway", openrouter: "OpenRouter" };
    const platformName = (t, platform) => (platform === "generic" ? t("platform.generic") : PLATFORM_NAMES[platform] ?? platform);

    /** Models the site offers that are not added yet: read when the dialog opens, chosen, added; or an id typed in. */
    function AddModelsDialog({ t, site, onClose }) {
      const [found, setFound] = React.useState(null);
      const [chosen, setChosen] = React.useState(new Set());
      const [manual, setManual] = React.useState("");
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const act = async (label, method, request, after) => {
        setBusy(label);
        setError(null);
        try {
          const value = await run(method, request);
          after?.(value);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(null);
        }
      };
      const fetchList = () => act("fetch", "discoverModels", { siteId: site.id }, (value) => {
        setFound(value?.discovered);
        if (!value?.discovered?.ok) setError(value?.discovered?.error ?? "—");
      });
      React.useEffect(() => { void fetchList(); }, []);
      const more = (found?.models ?? []).filter((model) => !site.models.some((added) => added.id === model.id));
      const addChosen = () => act("add", "addModels", { siteId: site.id, models: more.filter((model) => chosen.has(model.id)).map(modelPayload) }, () => setChosen(new Set()));
      const addManual = () => {
        const id = manual.trim();
        if (!id) return;
        void act("manual", "addModels", { siteId: site.id, models: [{ id, source: "manual" }] }, () => setManual(""));
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!busy || busy === "fetch") onClose(); },
        title: t("models.addTitle", { name: site.name }),
        closeLabel: t("models.close"),
        className: "cx-modal cx-modal-xl",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          h("div", { className: "cx-inline" },
            found?.ok ? h("span", { className: "cx-muted" }, t("dialog.found", { platform: found.platformInfo?.name ?? platformName(t, found.platform), count: found.models.length })) : null,
            h("span", { className: "cx-spacer" }),
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), disabled: busy !== null, onClick: () => void fetchList() }, busy === "fetch" ? t("dialog.fetching") : t("dialog.fetch"))),
          more.length ? h(ModelChooser, { t, models: more, money: siteCurrency(found?.platformInfo ?? site.platformInfo), chosen, onChange: setChosen })
            : h("div", { className: "cx-placeholder" }, busy === "fetch" ? t("dialog.fetching") : found?.ok ? t(found.models.length ? "models.allAdded" : "models.noneListed") : t("dialog.fetchFirst")),
          h("div", { className: "cx-inline" },
            h("input", { className: "cx-text cx-grow", value: manual, placeholder: t("dialog.manual"), "aria-label": t("dialog.manual"), maxLength: 200, spellCheck: false, onChange: (event) => setManual(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") addManual(); } }),
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: !manual.trim() || busy !== null, onClick: addManual }, t("dialog.manualAdd"))),
          errorLine(t, error)),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy !== null && busy !== "fetch", onClick: onClose }, t("models.close")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy !== null || chosen.size === 0, onClick: () => void addChosen() }, t("models.addChosen", { count: chosen.size }))),
      });
    }

    /** One model's description, editable: protocol, limits, image input, reasoning levels and how they are sent. */
    function ModelEditDialog({ t, site, model, onClose }) {
      const own = model.own ?? {};
      const [name, setName] = React.useState(model.name ?? "");
      const [protocol, setProtocol] = React.useState(PROTOCOLS.includes(own.protocol) ? own.protocol : "");
      const [context, setContext] = React.useState(String(model.context ?? ""));
      const [output, setOutput] = React.useState(String(model.output ?? ""));
      const [image, setImage] = React.useState(model.image === true);
      const [thinks, setThinks] = React.useState(Boolean(model.reasoning));
      const [levels, setLevels] = React.useState(new Set(model.reasoning?.levels ?? ["low", "medium", "high"]));
      const [off, setOff] = React.useState(model.reasoning?.off === true);
      const [format, setFormat] = React.useState(own.flags?.thinkingFormat ?? "");
      const [replay, setReplay] = React.useState(model.flags?.reasoningOnAssistant === true);
      // The price the user set (per million tokens): estimates use it before the site's.
      const [priceIn, setPriceIn] = React.useState(model.price ? String(model.price.input) : "");
      const [priceCache, setPriceCache] = React.useState(model.price ? String(model.price.cacheRead) : "");
      const [priceOut, setPriceOut] = React.useState(model.price ? String(model.price.output) : "");
      const [currency, setCurrency] = React.useState(model.price?.currency === "CNY" ? "CNY" : "USD");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const number = (value) => {
        const parsed = Number(String(value).replace(/[,_\s]/g, ""));
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      };
      const save = async (patch) => {
        setBusy(true);
        setError(null);
        try {
          await run("updateModel", { siteId: site.id, modelId: model.id, patch });
          onClose();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };
      const amount = (value) => {
        const text = String(value).trim();
        if (!text) return undefined;
        const parsed = Number(text.replace(/[,_\s]/g, ""));
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      };
      const prices = [priceIn, priceCache, priceOut].map(amount);
      // Input and output go together; a cache price is optional (the input's when empty).
      const priceBad = prices.some((value) => value === null) || (prices[0] === undefined) !== (prices[2] === undefined);
      const pricePatch = () => (prices[0] === undefined ? null : { input: prices[0], output: prices[2], ...(prices[1] !== undefined ? { cacheRead: prices[1] } : {}), currency });
      const money = siteCurrency(site.platformInfo);
      const sitePrice = model.cost ? (model.cost.unit === "quota" ? { input: model.cost.input * money.rate, cacheRead: (model.cost.cacheRead ?? 0) * money.rate, output: model.cost.output * money.rate, symbol: money.symbol } : { ...model.cost, symbol: "$" }) : null;
      const priceInput = (key, label, value, setValue, placeholder) => h("div", { className: "cx-field", key },
        h("label", { htmlFor: `cx-price-${key}` }, label),
        h("input", { id: `cx-price-${key}`, className: "cx-text", value, inputMode: "decimal", placeholder: typeof placeholder === "number" ? priceText(placeholder) : "", "aria-invalid": amount(value) === null ? "true" : "false", onChange: (event) => setValue(event.target.value) }));
      const patch = () => {
        const flags = { ...(own.flags ?? {}) };
        if (format) flags.thinkingFormat = format;
        else delete flags.thinkingFormat;
        if (replay) flags.reasoningOnAssistant = true;
        else delete flags.reasoningOnAssistant;
        return {
          name: name.trim() || null,
          protocol: protocol || null,
          context: number(context),
          output: number(output),
          image,
          reasoning: thinks ? { levels: EFFORTS.filter((level) => levels.has(level)), off } : false,
          flags: Object.keys(flags).length ? flags : null,
          price: pricePatch(),
        };
      };
      // Only what changed is sent: a price alone leaves the model following its site's list.
      const first = React.useRef(undefined);
      if (first.current === undefined) first.current = patch();
      const saveChanged = () => {
        const next = patch();
        const changed = Object.fromEntries(Object.entries(next).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(first.current[field])));
        if (Object.keys(changed).length === 0) onClose();
        else void save(changed);
      };
      const toggleLevel = (level, next) => {
        const set = new Set(levels);
        if (next) set.add(level);
        else set.delete(level);
        setLevels(set);
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!busy) onClose(); },
        title: t("edit.title", { id: model.id }),
        closeLabel: t("edit.cancel"),
        className: "cx-modal",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-model-name" }, t("edit.name")),
            h("input", { id: "cx-model-name", className: "cx-text", value: name, maxLength: 120, onChange: (event) => setName(event.target.value) })),
          h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-model-protocol" }, t("edit.protocol")),
            h("select", { id: "cx-model-protocol", className: "cx-select", value: protocol, onChange: (event) => setProtocol(event.target.value) },
              h("option", { value: "" }, t("edit.protocolSite", { protocol: PROTOCOL_SHORT[site.protocol] ?? site.protocol })),
              PROTOCOLS.map((item) => h("option", { key: item, value: item }, PROTOCOL_NAMES[item]))),
            Array.isArray(model.endpoints) && model.endpoints.length ? h("span", { className: "cx-muted cx-hint" }, t("edit.served", { protocols: model.endpoints.map((type) => SERVED_NAMES[type] ?? type).join(" / ") })) : null),
          h("div", { className: "cx-row2" },
            h("div", { className: "cx-field" },
              h("label", { htmlFor: "cx-model-context", title: model.context ? contextTitle(t, model) : undefined }, t("edit.context")),
              h("input", { id: "cx-model-context", className: "cx-text", value: context, inputMode: "numeric", onChange: (event) => setContext(event.target.value) })),
            h("div", { className: "cx-field" },
              h("label", { htmlFor: "cx-model-output" }, t("edit.output")),
              h("input", { id: "cx-model-output", className: "cx-text", value: output, inputMode: "numeric", onChange: (event) => setOutput(event.target.value) }))),
          h("label", { className: "cx-check" }, h("input", { type: "checkbox", checked: image, onChange: (event) => setImage(event.target.checked) }), t("edit.image")),
          h("div", { className: "cx-field" },
            h("label", null, t("edit.reasoning")),
            h("label", { className: "cx-check" }, h("input", { type: "checkbox", checked: !thinks, onChange: (event) => setThinks(!event.target.checked) }), t("edit.noReasoning")),
            thinks ? h("div", { className: "cx-levels" },
              EFFORTS.map((level) => h("label", { key: level, className: "cx-check" }, h("input", { type: "checkbox", checked: levels.has(level), onChange: (event) => toggleLevel(level, event.target.checked) }), level)),
              h("label", { className: "cx-check" }, h("input", { type: "checkbox", checked: off, onChange: (event) => setOff(event.target.checked) }), t("edit.off"))) : null),
          thinks ? h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-model-format" }, t("edit.format")),
            h("select", { id: "cx-model-format", className: "cx-select", value: format, onChange: (event) => setFormat(event.target.value) },
              h("option", { value: "" }, t("edit.formatAuto")),
              FORMATS.map((item) => h("option", { key: item, value: item }, t(`edit.format.${item}`))))) : null,
          thinks ? h("label", { className: "cx-check" }, h("input", { type: "checkbox", checked: replay, onChange: (event) => setReplay(event.target.checked) }), t("edit.replay")) : null,
          h("div", { className: "cx-field cx-price" },
            h("label", null, t("edit.price")),
            h("div", { className: "cx-row4" },
              priceInput("in", t("edit.priceInput"), priceIn, setPriceIn, sitePrice?.input),
              priceInput("cache", t("edit.priceCache"), priceCache, setPriceCache, sitePrice?.cacheRead),
              priceInput("out", t("edit.priceOutput"), priceOut, setPriceOut, sitePrice?.output),
              h("div", { className: "cx-field" },
                h("label", { htmlFor: "cx-price-currency" }, t("edit.priceCurrency")),
                h("select", { id: "cx-price-currency", className: "cx-select", value: currency, onChange: (event) => setCurrency(event.target.value) },
                  h("option", { value: "USD" }, "USD $"),
                  h("option", { value: "CNY" }, "CNY ¥")))),
            h("span", { className: priceBad ? "cx-error" : "cx-muted" }, priceBad ? t("edit.priceBad") : sitePrice ? t("edit.priceSite", { price: `${sitePrice.symbol}${priceText(sitePrice.input)} / ${sitePrice.symbol}${priceText(sitePrice.output)}` }) : t("edit.priceSiteNone"))),
          errorLine(t, error)),
        footer: h(React.Fragment, null,
          h("button", { type: "button", className: "cx-link", disabled: busy, onClick: () => void save({ name: null, protocol: null, context: null, output: null, image: null, reasoning: null, flags: null }) }, t("edit.reset")),
          h("span", { className: "cx-spacer" }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy, onClick: onClose }, t("edit.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy || priceBad || (thinks && levels.size === 0 && !off), onClick: saveChanged }, t("edit.save"))),
      });
    }

    function AddKeysDialog({ t, site, onClose }) {
      const [text, setText] = React.useState("");
      const [label, setLabel] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [lines, setLines] = React.useState([]);
      const add = async () => {
        setBusy(true);
        setLines([]);
        try {
          const value = await run("addKeys", { siteId: site.id, text, ...(label.trim() ? { label: label.trim() } : {}) });
          const view = (value?.added ?? []).map((item) => ({ tone: item.status === "ok" ? "ok" : item.status === "invalid" || item.status === "expired" || item.status === "restricted" ? "error" : "warn", text: `${item.masked} · ${t(`status.${item.status}`) === `status.${item.status}` ? item.status : t(`status.${item.status}`)}${item.statusMessage ? ` · ${item.statusMessage}` : ""}${item.probeError ? ` · ${item.probeError}` : ""}` }));
          setLines(view);
          if (view.some((line) => line.tone === "ok")) setText("");
        } catch (failure) {
          setLines([{ tone: "error", text: t("error.generic", { message: String(failure?.message ?? failure) }) }]);
        } finally {
          setBusy(false);
        }
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!busy) onClose(); },
        title: t("key.addTitle", { name: site.name }),
        closeLabel: t("dialog.cancel"),
        className: "cx-modal",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          h("textarea", { className: "cx-textarea", style: { minHeight: "110px" }, value: text, placeholder: t("key.addPlaceholder"), "aria-label": t("key.addPlaceholder"), spellCheck: false, autoComplete: "off", "data-modal-autofocus": true, onChange: (event) => setText(event.target.value) }),
          h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-key-label" }, t("key.label")),
            h("input", { id: "cx-key-label", className: "cx-text", value: label, maxLength: 60, onChange: (event) => setLabel(event.target.value) })),
          lines.length ? h("div", { className: "cx-dialog", role: "status", style: { gap: "4px" } }, lines.map((line, index) => h("div", { key: index, className: line.tone === "ok" ? "cx-ok" : line.tone === "warn" ? "cx-warn" : "cx-error" }, line.text))) : null),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy, onClick: onClose }, t("dialog.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy || !text.trim(), onClick: () => void add() }, busy ? t("key.adding") : t("key.add"))),
      });
    }

    function RenameKeyDialog({ t, keyInfo: key, onClose }) {
      const [label, setLabel] = React.useState(key.label ?? "");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const save = async () => {
        setBusy(true);
        setError(null);
        try {
          await run("updateKey", { keyId: key.id, label: label.trim() || null });
          onClose();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!busy) onClose(); },
        title: t("key.renameTitle", { masked: key.masked }),
        closeLabel: t("dialog.cancel"),
        className: "cx-modal",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          h("input", { className: "cx-text", value: label, maxLength: 60, "aria-label": t("key.label"), "data-modal-autofocus": true, onChange: (event) => setLabel(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") void save(); } }),
          errorLine(t, error)),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy, onClick: onClose }, t("dialog.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy, onClick: () => void save() }, t("dialog.save"))),
      });
    }

    /** A switch group's name and members (models chosen across the sites). */
    function GroupDialog({ t, status, group, onClose }) {
      const sites = status?.sites ?? [];
      const all = sites.flatMap((site) => site.models.map((model) => ({ site, model, key: `${site.id}\u0000${model.id}` })));
      const [name, setName] = React.useState(group?.name ?? "");
      const [picked, setPicked] = React.useState(() => (group?.members ?? []).map((member) => `${member.site}\u0000${member.model}`));
      const [query, setQuery] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const shown = all.filter((item) => words.every((word) => `${item.model.id} ${item.model.name} ${item.site.name}`.toLowerCase().includes(word)));
      const toggle = (key, next) => setPicked(next ? [...picked.filter((item) => item !== key), key] : picked.filter((item) => item !== key));
      const save = async () => {
        setBusy(true);
        setError(null);
        try {
          const members = picked.map((key) => key.split("\u0000")).map(([site, model]) => ({ site, model }));
          const active = group ? Math.max(0, members.findIndex((member) => member.site === group.members[group.active]?.site && member.model === group.members[group.active]?.model)) : 0;
          await run("saveGroup", { ...(group ? { id: group.id } : {}), ...(name.trim() ? { name: name.trim() } : {}), members, active });
          onClose();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!busy) onClose(); },
        title: group ? t("group.editTitle", { name: group.name }) : t("group.addTitle"),
        closeLabel: t("group.cancel"),
        className: "cx-modal cx-modal-wide",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-group-name" }, t("group.name")),
            h("input", { id: "cx-group-name", className: "cx-text", value: name, maxLength: 60, placeholder: picked.length ? picked[0].split("\u0000")[1] : "", "data-modal-autofocus": true, onChange: (event) => setName(event.target.value) })),
          h("div", { className: "cx-inline" },
            h("span", { className: "cx-subtitle" }, t("group.members")),
            h("span", { className: "cx-spacer" }),
            all.length > 12 ? h("input", { className: "cx-text cx-search", type: "search", value: query, placeholder: t("models.search"), "aria-label": t("models.search"), spellCheck: false, onChange: (event) => setQuery(event.target.value) }) : null),
          shown.length ? h("div", { className: "cx-model-grid" }, shown.map((item) => h("div", { key: item.key, className: "cx-model-card", "data-selected": picked.includes(item.key) ? "true" : undefined, title: item.model.id },
            h(P.Checkbox, { className: "cx-model-name", checked: picked.includes(item.key), label: item.model.name ?? item.model.id, onChange: (next) => toggle(item.key, next) }),
            h("div", { className: "cx-model-meta" }, h("span", { className: "cx-model-tag" }, item.site.name), h("span", { className: "cx-model-tag" }, item.model.id))))) : h("div", { className: "cx-placeholder" }, t("group.pick")),
          errorLine(t, error)),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy, onClick: onClose }, t("group.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy || picked.length === 0, onClick: () => void save() }, t("group.save"))),
      });
    }

    // ---------------------------------------------------------------- pages

    const GridIcon = () => h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("rect", { x: 2.5, y: 2.5, width: 4.5, height: 4.5, rx: 1.2 }), h("rect", { x: 9, y: 2.5, width: 4.5, height: 4.5, rx: 1.2 }), h("rect", { x: 2.5, y: 9, width: 4.5, height: 4.5, rx: 1.2 }), h("rect", { x: 9, y: 9, width: 4.5, height: 4.5, rx: 1.2 }));
    const SwapIcon = () => h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M3 5.5h9.5M10 3l2.5 2.5L10 8" }), h("path", { d: "M13 10.5H3.5M6 8l-2.5 2.5L6 13" }));
    const PlusIcon = () => h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", "aria-hidden": true },
      h("path", { d: "M8 3.5v9M3.5 8h9" }));

    /** The page the tab shows, kept in this browser (a convenience: the overview when it cannot be read). */
    const PAGE_STORE = "dsh-custom-models.page";
    function readPage() {
      try {
        const value = globalThis.localStorage?.getItem(PAGE_STORE);
        return typeof value === "string" && /^(overview|groups|authn|add|site:[a-z][a-z0-9-]{0,39})$/.test(value) ? value : null;
      } catch {
        return null;
      }
    }
    function writePage(page) {
      try {
        globalThis.localStorage?.setItem(PAGE_STORE, page);
      } catch {
        /* storage blocked: the page is simply not remembered */
      }
    }

    /** "$0.0042", "¥1.20 + $0.03": a cost per currency, yuan first. */
    function moneyText(cost) {
      if (!cost) return null;
      const parts = ["CNY", "USD"].filter((currency) => typeof cost[currency] === "number").map((currency) => amountText(cost[currency], currency));
      return parts.length ? parts.join(" + ") : null;
    }
    /** Cache hits among all input (DSH's own measure: hits over input, cache writes included). */
    function hitRate(bucket) {
      const all = (Number(bucket?.input) || 0) + (Number(bucket?.cacheRead) || 0) + (Number(bucket?.cacheWrite) || 0);
      return all > 0 ? (Number(bucket.cacheRead) || 0) / all : null;
    }
    /** Output tokens per second from the first token to the end, as DSH's session statistics count it; null without timed output. */
    const speedOf = (bucket) => (bucket?.decodeMs > 0 && bucket.decodeTokens > 0 ? bucket.decodeTokens / (bucket.decodeMs / 1000) : null);
    const speedText = (bucket) => (speedOf(bucket) === null ? "—" : `${bucket.estimated ? "≈" : ""}${Math.round(speedOf(bucket))} tok/s`);
    /** Mean first-token latency, "1.2 s"; "—" without one. */
    const ttftText = (t, bucket) => (bucket?.ttftCount ? t("time.seconds", { s: (bucket.ttftMs / bucket.ttftCount / 1000).toFixed(1) }) : "—");
    const percentText = (value) => (value === null || value === undefined ? "—" : value > 0 && value < 0.01 ? "<1%" : `${Math.round(value * 100)}%`);
    const dayText = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
    /** The axis top: the smallest of 1, 2, 2.5, 5 × 10^n at or above the largest value. */
    function niceTop(max) {
      if (!(max > 0)) return 1;
      const power = 10 ** Math.floor(Math.log10(max));
      for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
      return 10 * power;
    }
    /** A site's state for its dot: its key in use (or off, or none). */
    function siteState(t, site, keys) {
      if (site.enabled === false) return { tone: "off", label: t("nav.off") };
      const own = keys.filter((key) => key.endpoint === site.id);
      const active = own.find((key) => key.active) ?? own[0];
      if (!active) return { tone: "idle", label: site.keyless ? t("site.keyless") : t("site.noKeys") };
      const info = statusInfo(t, active, site);
      return { tone: info.tone === "neutral" ? "idle" : info.tone, label: `${keyTitle(active)} · ${info.label}`, key: active };
    }
    const emptyScope = () => ({ today: null, d7: null, d30: null, daily: null });
    const estimatedNote = (t, bucket) => (bucket?.estimated ? t("usage.estimatedNote") : null);
    /** A bucket's tokens, "≈" when part of it is an estimate. */
    const tokensText = (bucket) => (bucket && bucket.tokens ? `${bucket.estimated ? "≈" : ""}${compact(bucket.tokens)}` : "—");
    /** The hover text of a cost: where its prices came from, and what went unpriced. */
    function costTitle(t, bucket) {
      if (!bucket) return undefined;
      const parts = [t("usage.costTitle")];
      if (bucket.priced?.includes("reported")) parts.push(t("usage.costReported"));
      if (bucket.quota) parts.push(t("usage.costQuota"));
      if (bucket.unpriced) parts.push(t("usage.costUnpriced"));
      return parts.join("\n");
    }

    /** DSH's segmented control where the primitives have it, else the same look by hand. */
    function Segmented({ id, value, options, onChange, label }) {
      if (typeof P.SegmentedControl === "function") return h(P.SegmentedControl, { id, value, options, onChange, label, className: "cx-segmented" });
      const index = Math.max(0, options.findIndex((option) => option.value === value));
      return h("div", { className: "cx-seg cx-segmented", role: "tablist", "aria-label": label, style: { "--cx-seg-count": String(options.length), "--cx-seg-index": String(index) } },
        h("span", { className: "cx-seg-indicator", "aria-hidden": true }),
        options.map((option) => h("button", { key: option.value, type: "button", role: "tab", id: `${id}-${option.value}`, className: "cx-seg-tab", "aria-selected": option.value === value ? "true" : "false", tabIndex: option.value === value ? 0 : -1, onClick: () => { if (option.value !== value) onChange(option.value); } }, option.label)));
    }

    /** A hover bubble: DSH's tooltip where the primitives have it, else the browser's own. */
    function Tip({ label, children }) {
      if (typeof P.Tooltip === "function") return h(P.Tooltip, { label, side: "top", portal: true, maxWidth: 320 }, children);
      return React.cloneElement(children, { title: label });
    }

    function Stat({ label, value, sub, title }) {
      return h("div", { className: "cx-stat", title },
        h("span", { className: "cx-stat-label" }, label),
        h("span", { className: "cx-stat-value" }, value),
        h("span", { className: "cx-stat-sub" }, sub ?? " "));
    }

    /** The last 30 days' tokens, one column a day (hover a day for its numbers). */
    function DailyBars({ t, daily }) {
      const days = Array.isArray(daily) ? daily : [];
      const top = niceTop(Math.max(0, ...days.map((day) => day.tokens || 0)));
      const ticks = [top, top / 2, 0];
      const tip = (day) => [
        day.date === days.at(-1)?.date ? `${dayText(day.date)} · ${t("chart.today")}` : dayText(day.date),
        day.requests || day.failures ? t("chart.tipRequests", { requests: day.requests, tokens: tokensText(day) }) : t("chart.tipNone"),
        day.tokens ? t("chart.tipSplit", { input: compact(day.input), cache: compact(day.cacheRead), output: compact(day.output) }) : null,
        moneyText(day.cost) ? `≈${moneyText(day.cost)}` : null,
        day.failures ? t("models.rowFailures", { count: day.failures }) : null,
      ].filter(Boolean).join("\n");
      return h("div", { className: "cx-chart", role: "img", "aria-label": t("chart.label") },
        h("div", { className: "cx-chart-axis", "aria-hidden": true }, ticks.map((tick, index) => h("span", { key: index }, tick ? compact(tick).replace(/\.0(?=[kM])/, "") : "0"))),
        h("div", { className: "cx-chart-plot" },
          ticks.map((tick, index) => h("span", { key: index, className: "cx-chart-grid", style: { bottom: `${(tick / top) * 100}%` }, "aria-hidden": true })),
          h("div", { className: "cx-chart-cols" }, days.map((day) => h(Tip, { key: day.date, label: tip(day) },
            h("div", { className: "cx-chart-col", "data-today": day.date === days.at(-1)?.date ? "true" : "false" },
              day.tokens ? h("span", { className: "cx-chart-bar", style: { height: `max(2px, ${((day.tokens / top) * 100).toFixed(2)}%)` } }) : null))))),
        h("div", { className: "cx-chart-x", "aria-hidden": true },
          days.length ? [days[0], days[Math.floor(days.length / 2)], days.at(-1)].map((day, index) => h("span", { key: index }, index === 2 ? t("chart.today") : dayText(day.date))) : null));
    }

    /** Today's numbers, 30 days beneath them, and the last 30 days day by day. */
    function UsageSummary({ t, scope }) {
      const today = scope?.today;
      const month = scope?.d30;
      const counted = Boolean(month && month.requests);
      const failed = (bucket) => (bucket?.failures ? h("span", { className: "cx-warn" }, t("stat.failed", { count: bucket.failures })) : null);
      const withFailures = (text, bucket) => (bucket?.failures ? h(React.Fragment, null, text, " · ", failed(bucket)) : text);
      const estimated = [today, month].map((bucket) => estimatedNote(t, bucket)).find(Boolean);
      return h(React.Fragment, null,
        h("div", { className: "cx-stats" },
          h(Stat, { label: t("stat.requests"), value: today?.requests ? String(today.requests) : "0", sub: month ? withFailures(t("stat.d30", { value: String(month.requests) }), today?.failures ? today : null) : null }),
          h(Stat, { label: t("stat.tokens"), value: tokensText(today), sub: month ? t("stat.d30", { value: tokensText(month) }) : null, title: [today?.tokens ? t("chart.tipSplit", { input: compact(today.input), cache: compact(today.cacheRead), output: compact(today.output) }) : null, estimated].filter(Boolean).join("\n") || undefined }),
          h(Stat, { label: t("stat.hit"), value: percentText(hitRate(today)), sub: month ? t("stat.d30", { value: percentText(hitRate(month)) }) : null }),
          h(Stat, { label: t("stat.speed"), value: speedText(today), sub: month ? t("stat.d30", { value: speedText(month) }) : null, title: t("stat.ttftTitle", { today: ttftText(t, today), month: ttftText(t, month) }) }),
          h(Stat, { label: t("stat.cost"), value: moneyText(today?.cost) ? `≈${moneyText(today.cost)}` : "—", sub: month ? t("stat.d30", { value: moneyText(month.cost) ? `≈${moneyText(month.cost)}` : "—" }) : null, title: costTitle(t, month) })),
        h("section", { className: "cx-card", "aria-label": t("chart.title") },
          h("div", { className: "cx-card-head" },
            h("span", { className: "cx-card-title" }, t("chart.title")),
            estimated ? h("span", { className: "cx-tag", title: estimated }, t("usage.estimatedTag")) : null),
          h("div", { className: "cx-card-body" }, counted ? h(DailyBars, { t, daily: scope.daily }) : h("div", { className: "cx-placeholder" }, month?.failures ? t("chart.onlyFailures", { count: month.failures }) : t("chart.empty")))));
    }

    /** The page's title line: what it is, a line under it, and its actions on the right. */
    function PageHead({ title, sub, tags, actions, children }) {
      return h("div", { className: "cx-page-head" },
        h("div", { className: "cx-page-titles" },
          h("div", { className: "cx-page-line" }, h("h2", { className: "cx-page-title" }, title), children, tags),
          sub ? h("div", { className: "cx-page-sub" }, sub) : null),
        actions ? h("div", { className: "cx-page-actions" }, actions) : null);
    }

    /** The left column: the overview, every site (in the picker's order, draggable), the switch groups, a new site. */
    function Nav({ t, status, page, onPage }) {
      const sites = status?.sites ?? [];
      const keys = status?.keys ?? [];
      const usage = status?.usage;
      const [dragging, setDragging] = React.useState(null);
      const [dropAt, setDropAt] = React.useState(null);
      const [order, setOrder] = React.useState(null);
      const ids = sites.map((site) => site.id);
      const shown = order ? order.map((id) => sites.find((site) => site.id === id)).filter(Boolean) : sites;
      const commit = (next) => {
        if (!next) return;
        setOrder(next);
        run("reorderSites", { siteIds: next }).catch(() => undefined).finally(() => setOrder(null));
      };
      const item = (key, label, icon, meta, extra = {}) => h("button", {
        key,
        type: "button",
        className: "cx-nav-item",
        "aria-current": page === key ? "page" : undefined,
        onClick: () => onPage(key),
        ...extra,
      }, icon, h("span", { className: "cx-nav-label" }, label), meta ? h("span", { className: "cx-nav-meta" }, meta) : null);
      return h("nav", { className: "cx-nav", "aria-label": t("tab.label") },
        h("div", { className: "cx-nav-title" }, t("head.title")),
        item("overview", t("nav.overview"), h("span", { className: "cx-nav-icon" }, h(GridIcon))),
        h("div", { className: "cx-nav-group" }, h("span", null, t("nav.sites")), sites.length ? h("span", null, String(sites.length)) : null),
        shown.map((site) => {
          const state = siteState(t, site, keys);
          const today = usage?.sites?.[site.id]?.today;
          const key = `site:${site.id}`;
          return item(key, site.name, h("span", { className: "cx-nav-dot", "data-tone": state.tone, "aria-hidden": true }), today?.tokens ? tokensText(today) : null, {
            "data-off": site.enabled === false ? "true" : "false",
            "data-dragging": dragging === site.id ? "true" : "false",
            "data-drop": dropAt?.id === site.id && dragging && dragging !== site.id ? (dropAt.after ? "after" : "before") : undefined,
            title: [site.name, site.baseUrl, state.label, today?.requests ? t("usage.today", { requests: today.requests, tokens: tokensText(today) }) : null, sites.length > 1 ? t("nav.dragHint") : null].filter(Boolean).join("\n"),
            draggable: sites.length > 1,
            onDragStart: (event) => {
              try {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", site.id);
              } catch {
                /* a minimal DataTransfer still drags */
              }
              setDragging(site.id);
            },
            onDragEnd: () => { setDragging(null); setDropAt(null); },
            onDragOver: (event) => {
              if (!dragging) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const after = event.clientY > rect.top + rect.height / 2;
              if (dropAt?.id !== site.id || dropAt.after !== after) setDropAt({ id: site.id, after });
            },
            onDrop: (event) => {
              if (!dragging) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              commit(reordered(ids, dragging, site.id, event.clientY > rect.top + rect.height / 2));
              setDragging(null);
              setDropAt(null);
            },
            onKeyDown: (event) => {
              if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              event.preventDefault();
              commit(moved(ids, site.id, event.key === "ArrowUp" ? -1 : 1));
            },
          });
        }),
        h("div", { className: "cx-nav-sep", role: "separator" }),
        item("groups", t("groups.title"), h("span", { className: "cx-nav-icon" }, h(SwapIcon)), status?.groups?.length ? String(status.groups.length) : null),
        item(AUTHN_PAGE, t("authn.nav"), h("span", { className: "cx-nav-icon" }, h(AuthnShieldIcon, { size: 16 }))),
        item("add", t("head.add"), h("span", { className: "cx-nav-icon" }, h(PlusIcon))));
    }

    /** Every site in one table: its state, balance and use; a row opens the site's page. */
    function OverviewPage({ t, status, checking, onPage }) {
      const sites = status?.sites ?? [];
      const keys = status?.keys ?? [];
      const usage = status?.usage;
      const on = sites.filter((site) => site.enabled !== false).length;
      const anyFunds = sites.some((site) => site.showsBalance);
      return h("div", { className: "cx-page" },
        h(PageHead, {
          title: t("nav.overview"),
          sub: sites.length ? t("overview.sub", { count: sites.length, on }) : null,
          actions: h(React.Fragment, null,
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(ShieldIcon), title: t("head.validateHint"), disabled: Boolean(checking) || keys.length === 0, onClick: () => void checkAll({ mode: "validity", deep: true }) }, checking === "validity" ? t("head.validating") : t("head.validate")),
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), title: t("head.fundsHint"), disabled: Boolean(checking) || !keys.some((key) => key.funds), onClick: () => void checkAll({ mode: "funds" }) }, checking === "funds" ? t("head.fundsing") : t("head.funds")),
            h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", onClick: () => onPage("add") }, t("head.add"))),
        }),
        status !== null && sites.length === 0 ? h("div", { className: "cx-empty" },
          h("span", null, t("empty")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", onClick: () => onPage("add") }, t("head.add"))) : null,
        sites.length ? h(UsageSummary, { t, scope: usage?.totals ?? emptyScope() }) : null,
        sites.length ? h("section", { className: "cx-card", "aria-label": t("nav.sites") },
          h("div", { className: "cx-card-head" }, h("span", { className: "cx-card-title" }, t("nav.sites"))),
          h("div", { className: "cx-table cx-sites", "data-funds": anyFunds ? "true" : "false", role: "table" },
            h("div", { className: "cx-tr cx-th", role: "row" },
              h("span", { role: "columnheader" }, t("col.site")),
              h("span", { role: "columnheader" }, t("col.keyInUse")),
              anyFunds ? h("span", { role: "columnheader" }, t("col.balance")) : null,
              h("span", { role: "columnheader", className: "cx-num" }, t("col.usage")),
              h("span", { role: "columnheader", className: "cx-num" }, t("col.d30")),
              h("span", { role: "columnheader", className: "cx-num" }, t("col.cost30"))),
            sites.map((site) => {
              const state = siteState(t, site, keys);
              const own = usage?.sites?.[site.id];
              const open = () => onPage(`site:${site.id}`);
              return h("div", { key: site.id, className: "cx-tr cx-row-link", role: "row", tabIndex: 0, "data-off": site.enabled === false ? "true" : "false", "aria-label": t("sites.open", { name: site.name }), onClick: open, onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } } },
                h("span", { role: "cell", className: "cx-site-cell" },
                  h("span", { className: "cx-nav-dot", "data-tone": state.tone, "aria-hidden": true }),
                  h("span", { className: "cx-site-names" }, h("span", { className: "cx-site-name" }, site.name), h("span", { className: "cx-muted cx-ellipsis", title: site.baseUrl }, site.host))),
                h("span", { role: "cell" }, state.key ? (() => {
                  const info = statusInfo(t, state.key, site);
                  return h("span", { className: "cx-chip", "data-tone": info.tone, title: info.detail }, info.label);
                })() : h("span", { className: "cx-muted" }, state.label)),
                anyFunds ? h("span", { role: "cell" }, site.showsBalance && state.key ? h(FundsCell, { t, keyInfo: state.key }) : h("span", { className: "cx-muted" }, "—")) : null,
                h("span", { role: "cell", className: "cx-num" }, own?.today?.requests ? t("usage.today", { requests: own.today.requests, tokens: tokensText(own.today) }) : own?.today?.failures ? h("span", { className: "cx-warn" }, t("stat.failed", { count: own.today.failures })) : "—"),
                h("span", { role: "cell", className: "cx-num" }, own?.d30?.requests ? t("usage.today", { requests: own.d30.requests, tokens: tokensText(own.d30) }) : "—"),
                h("span", { role: "cell", className: "cx-num", title: costTitle(t, own?.d30) }, moneyText(own?.d30?.cost) ? `≈${moneyText(own.d30.cost)}` : "—"));
            }))) : null);
    }

    /** One site's keys: the table each key takes two lines of (drag to reorder, use, check, rename, remove). */
    function KeysCard({ t, site, keys, drag, onAddKey, onRename }) {
      return h("section", { className: "cx-card cx-section", "aria-label": t("keys.title"), "data-funds": site.showsBalance ? "true" : "false", "data-off": site.enabled === false ? "true" : "false" },
        h("div", { className: "cx-card-head" },
          h("span", { className: "cx-card-title" }, t("keys.title")),
          keys.length ? h("span", { className: "cx-muted" }, String(keys.length)) : null,
          h("span", { className: "cx-spacer" }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "ghost", icon: h(PlusIcon), onClick: onAddKey }, t("site.addKey"))),
        keys.length ? h(React.Fragment, null,
          h("div", { className: "cx-grid cx-thead", "aria-hidden": true },
            h("span", null, t("col.status")),
            site.showsBalance ? h("span", null, t("col.balance")) : null,
            h("span", null, t("col.usage")),
            h("span", null, "")),
          h("ul", { className: "cx-keys" }, keys.map((key) => h(KeyRow, { key: key.id, t, keyInfo: key, site, drag: drag(site.id, keys, key), onRename }))))
          : h("div", { className: "cx-note cx-muted" }, site.keyless ? t("site.keylessTitle") : t("site.noKeys")));
    }

    const RANGES = ["today", "d7", "d30"];

    /** The site's models with what each used in the chosen period; edit or remove one; add more. */
    function ModelsCard({ t, site, usage, billed = null, onAdd, onEdit }) {
      const [range, setRange] = React.useState("today");
      const [confirming, setConfirming] = React.useState(null);
      const [error, setError] = React.useState(null);
      const counted = usage?.models ?? {};
      // A model taken off the site is gone from here, its counts too (the report leaves them out).
      const rows = site.models;
      const total = usage?.[range];
      const remove = async (model) => {
        if (confirming !== model.id) {
          setConfirming(model.id);
          setTimeout(() => setConfirming(null), 4000);
          return;
        }
        setError(null);
        try {
          await run("removeModels", { siteId: site.id, modelIds: [model.id] });
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };
      const money = siteCurrency(site.platformInfo);
      const priceLine = (model) => {
        if (model.price) return t("models.priceUser", { price: `${model.price.currency === "CNY" ? "¥" : "$"}${priceText(model.price.input)} / ${model.price.currency === "CNY" ? "¥" : "$"}${priceText(model.price.output)}` });
        if (model.cost) return [t(model.cost.unit === "quota" ? "models.priceQuota" : "models.priceSite", { price: model.cost.unit === "quota" ? `${money.symbol}${priceText(model.cost.input * money.rate)} / ${money.symbol}${priceText(model.cost.output * money.rate)}` : `$${priceText(model.cost.input)} / $${priceText(model.cost.output)}` }), relayPriceNotes(t, model.cost, money)].filter(Boolean).join("\n");
        return t("models.priceNone");
      };
      const rowTitle = (model, bucket) => [
        model.id,
        bucket?.requests ? t("models.rowAvgInput", { value: compact(Math.round((bucket.input + bucket.cacheRead + bucket.cacheWrite) / bucket.requests)) }) : null,
        bucket?.ttftCount ? t("models.rowTtft", { value: t("time.seconds", { s: (bucket.ttftMs / bucket.ttftCount / 1000).toFixed(1) }) }) : null,
        bucket?.decodeMs > 0 && bucket.decodeTokens ? t("models.rowSpeed", { value: Math.round(bucket.decodeTokens / (bucket.decodeMs / 1000)) }) : null,
        bucket?.failures ? t("models.rowFailures", { count: bucket.failures }) : null,
        bucket?.probes ? t("models.rowProbes", { count: bucket.probes }) : null,
        estimatedNote(t, bucket),
        priceLine(model),
      ].filter(Boolean).join("\n");
      const cells = (bucket) => [
        h("span", { key: "r", role: "cell", className: "cx-num" }, bucket?.requests ? String(bucket.requests) : "—", bucket?.failures ? h("span", { className: "cx-fail" }, t("stat.failed", { count: bucket.failures })) : null),
        h("span", { key: "i", role: "cell", className: "cx-num" }, bucket?.input ? `${bucket.estimated ? "≈" : ""}${compact(bucket.input)}` : "—"),
        h("span", { key: "c", role: "cell", className: "cx-num cx-opt" }, bucket?.cacheRead ? compact(bucket.cacheRead) : "—"),
        h("span", { key: "o", role: "cell", className: "cx-num" }, bucket?.output ? `${bucket.estimated ? "≈" : ""}${compact(bucket.output)}` : "—"),
        h("span", { key: "h", role: "cell", className: "cx-num cx-opt" }, percentText(hitRate(bucket))),
        h("span", { key: "s", role: "cell", className: "cx-num cx-opt", title: bucket?.ttftCount ? t("models.rowTtft", { value: ttftText(t, bucket) }) : undefined }, speedText(bucket)),
        billedCell(bucket, null),
      ];
      // What the site billed (its log or statistics) stands in the cost column where read; the estimate goes to the hover.
      const siteBilled = (modelId) => {
        const span = billed?.[range];
        if (!span) return null;
        if (modelId === null) return span.total > 0 || span.requests > 0 ? span.total : null;
        const own = span.models?.[modelId];
        return own ? own.amount : null;
      };
      function billedCell(bucket, modelId) {
        const amount = siteBilled(modelId);
        const estimate = moneyText(bucket?.cost) ? `≈${moneyText(bucket.cost)}` : "—";
        if (amount === null) return h("span", { key: "m", role: "cell", className: "cx-num", title: costTitle(t, bucket) }, estimate);
        return h("span", { key: "m", role: "cell", className: "cx-num cx-billed", title: t("models.billedTitle", { billed: amountText(amount, billed.currency ?? "USD"), estimate }) }, amountText(amount, billed.currency ?? "USD"));
      }
      return h("section", { className: "cx-card", "aria-label": t("models.tableTitle") },
        h("div", { className: "cx-card-head" },
          h("span", { className: "cx-card-title" }, t("models.tableTitle")),
          site.models.length ? h("span", { className: "cx-muted" }, String(site.models.length)) : null,
          h("span", { className: "cx-spacer" }),
          h(Segmented, { id: `cx-range-${site.id}`, value: range, label: t("range.label"), onChange: setRange, options: RANGES.map((value) => ({ value, label: t(`range.${value}`) })) }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "ghost", icon: h(PlusIcon), title: t("site.modelsTitle"), onClick: onAdd }, t("models.add"))),
        rows.length ? h("div", { className: "cx-table cx-models", role: "table" },
          h("div", { className: "cx-tr cx-th", role: "row" },
            h("span", { role: "columnheader" }, t("col.model")),
            h("span", { role: "columnheader", className: "cx-num" }, t("col.context")),
            h("span", { role: "columnheader", className: "cx-num" }, t("col.requests")),
            h("span", { role: "columnheader", className: "cx-num" }, t("col.input")),
            h("span", { role: "columnheader", className: "cx-num cx-opt" }, t("col.cache")),
            h("span", { role: "columnheader", className: "cx-num" }, t("col.output")),
            h("span", { role: "columnheader", className: "cx-num cx-opt" }, t("col.hitRate")),
            h("span", { role: "columnheader", className: "cx-num cx-opt", title: t("col.speedTitle") }, t("col.speed")),
            h("span", { role: "columnheader", className: "cx-num", title: t("usage.costTitle") }, t("col.cost")),
            h("span", { role: "columnheader" }, "")),
          rows.map((model) => {
            const bucket = counted[model.id]?.[range];
            const tags = [...modelTags(t, model, money).filter((tag) => !["ctx", "price", "free"].includes(tag.key)), ...(model.usageReported === false ? [{ key: "usage", text: t("models.noUsage"), tone: "warn", title: t("models.noUsageTitle") }] : [])];
            return h("div", { key: model.id, className: "cx-tr", role: "row", title: rowTitle(model, bucket) },
              h("span", { role: "cell", className: "cx-model-cell" },
                h("span", { className: "cx-model-title" }, model.name ?? model.id),
                h("span", { className: "cx-model-sub" },
                  model.name && model.name !== model.id ? h("span", { className: "cx-model-id" }, model.id) : null,
                  tagNodes(tags))),
              h("span", { role: "cell", className: "cx-num", title: contextTitle(t, model) }, model.context ? contextText(t, model.context) : "—"),
              ...cells(bucket).slice(0, -1),
              billedCell(bucket, model.id),
              h("span", { role: "cell", className: "cx-row-tools" }, h(React.Fragment, null,
                h("button", { type: "button", className: "cx-icon", title: t("models.edit"), "aria-label": t("models.edit"), onClick: (event) => { event.stopPropagation(); onEdit(model); } }, h(PenIcon)),
                h("button", { type: "button", className: "cx-icon", "data-confirm": confirming === model.id ? "true" : "false", title: t("models.remove"), "aria-label": confirming === model.id ? t("models.removeConfirm") : t("models.remove"), onClick: (event) => { event.stopPropagation(); void remove(model); } }, confirming === model.id ? t("models.removeConfirm") : h(TrashIcon)))));
          }),
          rows.length > 1 && total ? h("div", { className: "cx-tr cx-tfoot", role: "row" },
            h("span", { role: "cell" }, t("models.total")),
            h("span", { role: "cell" }, ""),
            ...cells(total),
            h("span", { role: "cell" }, "")) : null)
          : h("div", { className: "cx-note cx-muted" }, t("models.empty")),
        errorLine(t, error));
    }

    const RELAY_PLATFORMS = ["newapi", "sub2api", "crs"];
    /** A relay's endpoint types, by the protocol names the page uses. */
    const SERVED_NAMES = { openai: "Chat", "openai-response": "Responses", anthropic: "Messages", gemini: "Gemini" };

    /**
     * A relay site's own records (relay/): what it billed these keys (today, 7 / 30 days or this month), each key's group
     * and subscription, the account (new-api, with a read-only account token the user gave), the site's model plaza and
     * performance figures. Read-only; nothing here changes anything at the site.
     */
    function RelayCard({ t, site, keys, relay, account }) {
      const [token, setToken] = React.useState("");
      const [userId, setUserId] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const billed = relay?.billed ?? null;
      const currency = billed?.currency ?? "USD";
      const money = (value) => (typeof value === "number" ? amountText(value, currency) : "—");
      const source = billed?.source === "log" ? t("relay.sourceLog", { time: billed.since ? clock(new Date(billed.since).toISOString()) : "—" }) : billed?.source === "stats" ? t("relay.sourceStats") : null;
      const title = [source, billed?.partial ? t("relay.partial") : null, billed?.at ? t("relay.read", { time: since(t, new Date(billed.at).toISOString()) }) : null].filter(Boolean).join("\n") || undefined;
      const save = async (remove = false) => {
        setBusy(true);
        setError(null);
        try {
          const id = Number.parseInt(userId, 10);
          await run("setSiteAccount", { siteId: site.id, token: remove ? "" : token.trim(), ...(!remove && Number.isInteger(id) && id > 0 ? { userId: id } : {}) });
          setToken("");
          setUserId("");
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };
      const keyLines = keys.map((key) => {
        const own = relay?.keys?.[key.id];
        if (!own) return null;
        const parts = [
          own.group ? h("span", { key: "g", className: "cx-tag", title: t("relay.groupTitle") }, t("relay.group", { group: own.group })) : null,
          own.subscription && typeof own.subscription.total === "number" ? h("span", { key: "s", className: "cx-muted" }, t("relay.subscription", { title: own.subscription.title ?? "—", remain: money(own.subscription.remain), total: money(own.subscription.total) })) : null,
          own.logError ? h("span", { key: "e", className: "cx-warn" }, t("relay.logError", { error: own.logError })) : null,
        ].filter(Boolean);
        return parts.length ? h("div", { key: key.id, className: "cx-relay-line" }, h("span", { className: "cx-relay-key" }, key.label || key.masked), ...parts) : null;
      }).filter(Boolean);
      const acct = relay?.account ?? null;
      const accountLine = acct ? (acct.error
        ? h("div", { className: "cx-relay-line cx-warn" }, acct.error === "denied" ? t("relay.accountDenied") : acct.error === "origin" ? t("relay.accountOrigin") : t("relay.accountError", { error: acct.error }))
        : h(React.Fragment, null,
          h("div", { className: "cx-relay-line" }, h("span", { className: "cx-relay-key" }, acct.name ?? t("relay.account")), h("span", null, t("relay.accountValue", { amount: amountText(acct.amount, acct.currency), used: amountText(acct.used, acct.currency) })), acct.group ? h("span", { className: "cx-tag" }, t("relay.accountGroup", { group: acct.group })) : null),
          ...(acct.subscriptions ?? []).map((sub, index) => h("div", { key: `sub-${index}`, className: "cx-relay-line cx-muted" }, t("relay.subLine", { used: amountText(sub.used, acct.currency), total: amountText(sub.total, acct.currency), end: sub.endsAt ? t("relay.subEnd", { time: clock(sub.endsAt) }) : "" })))))
        : null;
      return h("section", { className: "cx-card", "aria-label": t("relay.title") },
        h("div", { className: "cx-card-head" },
          h("span", { className: "cx-card-title" }, t("relay.title")),
          relay?.plaza ? h("span", { className: "cx-tag", title: t("relay.plazaTitle") }, t("relay.plaza", { groups: relay.plaza.groups.length })) : null,
          relay?.perf ? h("span", { className: "cx-tag", title: t("relay.perfTitle") }, t("relay.perf", { models: Object.keys(relay.perf.models ?? {}).length })) : null),
        h("div", { className: "cx-card-body" },
          billed?.source ? h("div", { className: "cx-stats", title },
            h(Stat, { label: t("relay.today"), value: money(billed.today?.total), sub: billed.today?.requests ? t("stat.requestsCount", { count: billed.today.requests }) : null }),
            billed.d7 ? h(Stat, { label: t("relay.d7"), value: money(billed.d7.total) }) : null,
            billed.d30 ? h(Stat, { label: t("relay.d30"), value: money(billed.d30.total) }) : null,
            billed.month ? h(Stat, { label: t("relay.month"), value: money(billed.month.total) }) : null)
            : h("div", { className: "cx-note cx-muted" }, t("relay.notRead")),
          ...keyLines,
          accountLine,
          site.platform === "newapi" ? h("div", { className: "cx-relay-account" },
            h("div", { className: "cx-field" },
              h("label", { htmlFor: `cx-acct-${site.id}`, title: t("relay.accountHint") }, t("relay.accountToken"), account ? h("span", { className: "cx-muted" }, ` · ${t("relay.tokenSet", { masked: account.masked })}`) : null),
              h("div", { className: "cx-inline" },
                h("input", { id: `cx-acct-${site.id}`, className: "cx-text", type: "password", autoComplete: "off", value: token, placeholder: t("relay.tokenPlaceholder"), title: t("relay.accountHint"), onChange: (event) => setToken(event.target.value) }),
                h("input", { className: "cx-text cx-narrow", inputMode: "numeric", value: userId, placeholder: t("relay.userId"), title: t("relay.userId"), "aria-label": t("relay.userId"), onChange: (event) => setUserId(event.target.value.replace(/[^0-9]/g, "")) }),
                h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy || !token.trim(), onClick: () => void save(false) }, t("relay.save")),
                account ? h(P.Button, { className: "cx-btn", size: "sm", variant: "ghost", disabled: busy, onClick: () => void save(true) }, t("relay.remove")) : null))) : null,
          errorLine(t, error)));
    }

    /** One site's page: its state, use, keys, models and settings. */
    function SitePage({ t, status, site, keys, drag, checking, onDialog, onPage }) {
      const [confirming, setConfirming] = React.useState(false);
      const [error, setError] = React.useState(null);
      const own = status?.usage?.sites?.[site.id];
      const remove = async () => {
        if (!confirming) {
          setConfirming(true);
          setTimeout(() => setConfirming(false), 4000);
          return;
        }
        try {
          await run("removeSite", { siteId: site.id });
          onPage("overview");
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };
      const toggle = async (next) => {
        setError(null);
        try {
          await run("setSiteEnabled", { siteId: site.id, enabled: next });
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };
      const tags = [
        h("span", { key: "protocol", className: "cx-tag", "data-tone": PROTOCOLS.includes(site.protocol) ? undefined : "warn", title: protocolName(t, site.protocol) }, PROTOCOL_SHORT[site.protocol] ?? site.protocol),
        site.platform !== "generic" ? h("span", { key: "platform", className: "cx-tag", title: site.platformInfo?.name ?? undefined }, site.platformName) : null,
        site.keyless ? h("span", { key: "keyless", className: "cx-tag", title: t("site.keylessTitle") }, t("site.keyless")) : null,
        site.plainHttp ? h("span", { key: "http", className: "cx-tag", "data-tone": site.publicHttp ? "warn" : undefined, title: httpTitle(t, site) }, "http") : null,
        site.usageReported === false ? h("span", { key: "usage", className: "cx-tag", "data-tone": "warn", title: t("site.noUsageTitle") }, t("site.noUsage"))
          : site.usageReported === "mixed" ? h("span", { key: "usage", className: "cx-tag", "data-tone": "warn", title: t("site.someNoUsageTitle", { models: site.models.filter((model) => model.usageReported === false).map((model) => model.name ?? model.id).join(t("list.sep")) }) }, t("site.someNoUsage")) : null,
      ];
      return h("div", { className: "cx-page", "data-off": site.enabled === false ? "true" : "false" },
        h(PageHead, {
          title: site.name,
          sub: h("span", { className: "cx-ellipsis", title: site.baseUrl }, site.baseUrl),
          tags,
          actions: h(React.Fragment, null,
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(ShieldIcon), title: t("site.verifyHint"), disabled: Boolean(checking) || keys.length === 0, onClick: () => void checkAll({ mode: "validity", deep: true, siteId: site.id }) }, checking === "validity" ? t("head.validating") : t("site.verify")),
            site.showsBalance ? h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), title: t("head.fundsHint"), disabled: Boolean(checking) || keys.length === 0, onClick: () => void checkAll({ mode: "funds", siteId: site.id }) }, checking === "funds" ? t("head.fundsing") : t("head.funds")) : null,
            h("button", { type: "button", className: "cx-icon", "data-confirm": confirming ? "true" : "false", title: confirming ? t("site.removeConfirm") : t("site.remove"), "aria-label": t("site.remove"), onClick: () => void remove() }, confirming ? t("key.removeConfirm") : h(TrashIcon))),
        }, h("span", { className: "cx-switch", title: t("site.switchTitle") }, h(P.Switch, { checked: site.enabled !== false, label: t("site.switch"), title: t("site.switchTitle"), onChange: (next) => void toggle(next) }))),
        errorLine(t, error),
        h(UsageSummary, { t, scope: own ?? emptyScope() }),
        h(KeysCard, { t, site, keys, drag, onAddKey: () => onDialog({ kind: "keys", site: site.id }), onRename: (key) => onDialog({ kind: "rename", key: key.id }) }),
        RELAY_PLATFORMS.includes(site.platform) ? h(RelayCard, { t, site, keys, relay: status?.relay?.[site.id] ?? null, account: status?.endpoints?.[site.id]?.account ?? null }) : null,
        h(ModelsCard, { t, site, usage: own, billed: status?.relay?.[site.id]?.billed ?? null, onAdd: () => onDialog({ kind: "models", site: site.id }), onEdit: (model) => onDialog({ kind: "model", site: site.id, model: model.id }) }),
        h(SiteForm, { key: site.id, t, status, site }));
    }

    /** The switch groups: one picker entry each, served by the member chosen here. */
    function GroupsPage({ t, status, onDialog }) {
      const groups = status?.groups ?? [];
      const [confirming, setConfirming] = React.useState(null);
      const [error, setError] = React.useState(null);
      const act = async (method, request) => {
        setError(null);
        try {
          await run(method, request);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };
      const siteOf = (id) => (status?.sites ?? []).find((site) => site.id === id);
      const anyModel = (status?.sites ?? []).some((site) => site.models.length);
      return h("div", { className: "cx-page" },
        h(PageHead, {
          title: t("groups.title"),
          sub: t("groups.titleHint"),
          actions: h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: !anyModel, title: anyModel ? undefined : t("groups.needModels"), onClick: () => onDialog({ kind: "group" }) }, t("groups.add")),
        }),
        errorLine(t, error),
        groups.length === 0 ? h("div", { className: "cx-empty" }, h("span", null, anyModel ? t("groups.emptyHint") : t("groups.needModels"))) : null,
        groups.map((group) => h("section", { key: group.id, className: "cx-card", "aria-label": group.name },
          h("div", { className: "cx-card-head" },
            h("span", { className: "cx-card-title" }, group.name),
            h("span", { className: "cx-muted" }, t("groups.members", { count: group.members.length })),
            group.switchLimit ? h("span", { className: "cx-model-tag", "data-tone": "warn", title: t("groups.switchTitle") }, t("models.switch")) : null,
            h("span", { className: "cx-spacer" }),
            h("button", { type: "button", className: "cx-icon", title: t("groups.edit"), "aria-label": t("groups.edit"), onClick: () => onDialog({ kind: "group", group: group.id }) }, h(PenIcon)),
            h("button", {
              type: "button",
              className: "cx-icon",
              "data-confirm": confirming === group.id ? "true" : "false",
              title: t("groups.remove"),
              "aria-label": confirming === group.id ? t("groups.removeConfirm") : t("groups.remove"),
              onClick: () => {
                if (confirming !== group.id) {
                  setConfirming(group.id);
                  setTimeout(() => setConfirming(null), 4000);
                  return;
                }
                void act("removeGroup", { groupId: group.id });
              },
            }, confirming === group.id ? t("groups.removeConfirm") : h(TrashIcon))),
          h("div", { className: "cx-members", role: "radiogroup", "aria-label": group.name }, group.members.map((member, index) => {
            const site = siteOf(member.site);
            const missing = !site?.models.some((model) => model.id === member.model);
            const off = site?.enabled === false;
            return h("label", { key: `${member.site}/${member.model}`, className: "cx-member", "data-missing": missing ? "true" : "false", "data-off": off ? "true" : "false" },
              h("input", { type: "radio", name: `cx-group-${group.id}`, checked: index === group.active, disabled: off && index !== group.active, onChange: () => void act("switchGroup", { groupId: group.id, index }) }),
              h("span", { className: "cx-member-site" }, site?.name ?? member.site),
              h("span", { className: "cx-member-model" }, `${member.model}${missing ? ` ${t("groups.missing")}` : off ? ` ${t("groups.siteOff")}` : ""}`));
          })))));
    }

    /** The tab: the left column picks one page — the overview, a site's, the switch groups', a new site's. */
    function CustomShell({ t }) {
      useWatch();
      const state = useStore();
      const status = state.status;
      const [page, setPageState] = React.useState(() => readPage() ?? "overview");
      const [back, setBack] = React.useState("overview");
      const [dialog, setDialog] = React.useState(null);
      const [dragging, setDragging] = React.useState(null);
      const [dropAt, setDropAt] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [error, setError] = React.useState(null);
      const sites = status?.sites ?? [];
      const siteOf = (id) => sites.find((site) => site.id === id);
      const setPage = (next) => {
        if (next === "add" && page !== "add") setBack(page);
        setPageState(next);
        writePage(next);
      };
      // A site removed (here or elsewhere) leaves the overview in its place.
      const pageSite = page.startsWith("site:") ? siteOf(page.slice(5)) : null;
      const current = status !== null && page.startsWith("site:") && !pageSite ? "overview" : page;
      const keysOf = (siteId) => {
        const own = (status?.keys ?? []).filter((key) => key.endpoint === siteId);
        if (!pending || pending.site !== siteId) return own;
        const byId = new Map(own.map((key) => [key.id, key]));
        return [...pending.ids.map((id) => byId.get(id)).filter(Boolean), ...own.filter((key) => !pending.ids.includes(key.id))];
      };
      const commitOrder = (siteId, next) => {
        if (!next) return;
        setPending({ site: siteId, ids: next });
        run("reorderKeys", { siteId, keyIds: next }).catch((failure) => setError(String(failure?.message ?? failure))).finally(() => setPending(null));
      };
      const endDrag = () => {
        setDragging(null);
        setDropAt(null);
      };
      const drag = (siteId, keys, key) => {
        const ids = keys.map((item) => item.id);
        const sameSite = dragging?.site === siteId;
        return {
          enabled: keys.length > 1,
          dragging: dragging?.id === key.id,
          drop: sameSite && dropAt?.id === key.id && dragging.id !== key.id ? (dropAt.after ? "after" : "before") : null,
          onMove: (delta) => commitOrder(siteId, moved(ids, key.id, delta)),
          onDragStart: (event) => {
            try {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", key.id);
            } catch {
              /* a minimal DataTransfer still drags */
            }
            setDragging({ site: siteId, id: key.id });
          },
          onDragEnd: endDrag,
          onDragOver: (event) => {
            if (!sameSite) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            if (dropAt?.id !== key.id || dropAt.after !== after) setDropAt({ id: key.id, after });
          },
          onDrop: (event) => {
            if (!sameSite) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            commitOrder(siteId, reordered(ids, dragging.id, key.id, event.clientY > rect.top + rect.height / 2));
            endDrag();
          },
        };
      };
      const close = () => setDialog(null);
      const open = dialog?.kind;
      const dialogSite = dialog?.site ? siteOf(dialog.site) : null;
      const body = current === "groups" ? h(GroupsPage, { t, status, onDialog: setDialog })
        : current === AUTHN_PAGE ? h(AuthnPage, { t })
        : current === "add" ? h("div", { className: "cx-page" },
          h(PageHead, { title: t("dialog.addTitle"), sub: t("add.sub") }),
          h(SiteForm, { t, status, onSaved: (id) => { if (id) setPage(`site:${id}`); }, onCancel: () => setPage(back === "add" ? "overview" : back) }))
          : pageSite ? h(SitePage, { key: pageSite.id, t, status, site: pageSite, keys: keysOf(pageSite.id), drag, checking: state.checking, onDialog: setDialog, onPage: setPage })
            : h(OverviewPage, { t, status, checking: state.checking, onPage: setPage });
      // The host half not restarted yet: everything it serves (usage, probes) is the older version's.
      const outdated = status !== null && status.version !== CLIENT_VERSION;
      return h("div", { className: "cx-root" },
        outdated ? h("div", { className: "cx-banner", role: "alert" }, t("error.hostOutdated", { page: CLIENT_VERSION, host: status.version ?? t("error.hostOld") })) : null,
        error ? errorLine(t, error) : null,
        state.error ? h("div", { className: "cx-error", role: "alert" }, unavailableError(state.error) ? t("error.unavailable") : t("error.generic", { message: state.error })) : null,
        h("div", { className: "cx-shell" },
          h(Nav, { t, status, page: current, onPage: setPage }),
          h("main", { className: "cx-main" }, body)),
        open === "models" && dialogSite ? h(AddModelsDialog, { t, site: dialogSite, onClose: close }) : null,
        open === "model" && dialogSite ? (() => {
          const model = dialogSite.models.find((item) => item.id === dialog.model);
          return model ? h(ModelEditDialog, { t, site: dialogSite, model, onClose: close }) : null;
        })() : null,
        open === "keys" && dialogSite ? h(AddKeysDialog, { t, site: dialogSite, onClose: close }) : null,
        open === "rename" ? (() => {
          const key = status?.keys?.find((item) => item.id === dialog.key);
          return key ? h(RenameKeyDialog, { t, keyInfo: key, onClose: close }) : null;
        })() : null,
        open === "group" ? h(GroupDialog, { t, status, group: dialog.group ? status?.groups?.find((group) => group.id === dialog.group) : null, onClose: close }) : null);
    }

    const View = (props) => h("div", { className: "cx-view" }, h(CustomShell, props));
    View.displayName = "CustomModels";

    /** The card inside a route's row of Settings → Models: that site's keys in one line. */
    function ProviderCard({ t, provider }) {
      const state = useStore();
      React.useEffect(() => { void loadStatus(); }, []);
      const route = provider?.provider ?? "";
      if (route === "custom-groups") {
        return h("div", { className: "cx-summary" }, h("span", null, t("card.group", { count: state.status?.groups?.length ?? 0 })));
      }
      const siteId = route.startsWith("custom-") ? route.slice(7) : null;
      const site = state.status?.sites?.find((item) => item.id === siteId);
      const keys = (state.status?.keys ?? []).filter((key) => key.endpoint === siteId);
      const active = keys.find((key) => key.active) ?? keys[0];
      const line = state.status === null ? null : keys.length === 0 ? (site?.keyless ? t("site.keylessTitle") : t("card.none")) : t("card.summary", { count: keys.length, key: keyTitle(active), state: statusInfo(t, active, site).label });
      return h("div", { className: "cx-summary" },
        unavailableError(state.error) ? h("span", { className: "cx-error" }, t("error.unavailable")) : line ? h("span", null, line) : null);
    }

    // --------------------------------------------------- model checks (authn/)

    /** The 模型核验 page's id in the left column. */
    const AUTHN_PAGE = "authn";
    /** A state's tone: identity (is it the model named?) and service (is it served faithfully?). */
    const IDENTITY_TONE = Object.freeze({ unchecked: "idle", clean: "idle", consistent: "ok", confirmed: "ok", suspect: "warn", substituted: "bad", excluded: "idle" });
    const SERVICE_TONE = Object.freeze({ insufficient: "idle", failed: "idle", ok: "idle", issues: "warn", bad: "bad", excluded: "idle" });
    /** An active check's outcome's tone. */
    const OUTCOME_TONE = Object.freeze({ hard: "bad", forged: "bad", fail: "warn", pass: "ok", verified: "ok", consistent: "ok", checked: "ok", unverifiable: "idle", error: "idle" });

    const lineIcon = (size, ...children) => h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, ...children);
    const AuthnShieldIcon = ({ check = false, size = 14 }) => lineIcon(size,
      h("path", { d: "M8 1.8 13 3.6v4.1c0 3.1-2.1 5.5-5 6.5-2.9-1-5-3.4-5-6.5V3.6L8 1.8Z" }),
      check ? h("path", { d: "m5.8 8.1 1.6 1.6 2.9-3.2" }) : null);
    const EyeIcon = ({ off = false }) => lineIcon(14,
      h("path", { d: "M1.8 8S4 3.9 8 3.9 14.2 8 14.2 8 12 12.1 8 12.1 1.8 8 1.8 8Z" }),
      h("circle", { cx: 8, cy: 8, r: 1.9 }),
      off ? h("path", { d: "m2.6 2.6 10.8 10.8" }) : null);
    const RadarIcon = () => lineIcon(14,
      h("circle", { cx: 8, cy: 8, r: 1.1 }),
      h("path", { d: "M5.3 10.7a3.8 3.8 0 0 1 0-5.4M10.7 5.3a3.8 3.8 0 0 1 0 5.4M3.2 12.8a6.8 6.8 0 0 1 0-9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6" }));
    const StopIcon = () => lineIcon(14, h("rect", { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1.2 }));
    const ChevronIcon = () => lineIcon(12, h("path", { d: "m4.5 6.5 3.5 3.5 3.5-3.5" }));
    const BookIcon = () => lineIcon(14,
      h("path", { d: "M2.5 3.2c1.9-.6 3.8-.4 5.5.8v9.2c-1.7-1.2-3.6-1.4-5.5-.8V3.2Z" }),
      h("path", { d: "M13.5 3.2c-1.9-.6-3.8-.4-5.5.8v9.2c1.7-1.2 3.6-1.4 5.5-.8V3.2Z" }));
    const FingerprintIcon = () => lineIcon(14,
      h("path", { d: "M3.2 5.6a5.3 5.3 0 0 1 9.6 0" }),
      h("path", { d: "M4.6 12.8a8 8 0 0 1-.9-3.9 4.3 4.3 0 0 1 8.6 0v.6" }),
      h("path", { d: "M8 8.6v.9c0 1.7.5 3.2 1.3 4.5" }),
      h("path", { d: "M6.1 13.6A9 9 0 0 1 5.8 9a2.2 2.2 0 0 1 4.4 0v.8c0 .8.1 1.6.4 2.3" }),
      h("path", { d: "M12.1 12.4c.1-.6.2-1.2.2-1.8" }));

    /** The UI language ("en" / "zh"): rule pack texts come in both. */
    const langOf = (t) => (t("lang.code") === "en" ? "en" : "zh");
    /** A rule pack text `{ zh, en }` in the UI language (any other value as it is). */
    const localText = (t, value) => (value && typeof value === "object" && !Array.isArray(value) ? value[langOf(t)] ?? value.zh ?? value.en ?? "" : value);

    /** One piece of evidence as a line. */
    function evidenceText(t, item) {
      const params = {};
      for (const [name, value] of Object.entries(item?.params ?? {})) params[name] = name === "lang" && (value === "en" || value === "zh") ? t(`lang.${value}`) : localText(t, value);
      const text = item?.key ? t(item.key, params) : "";
      const note = localText(t, item?.note);
      return note ? t("ev.withNote", { text, note }) : text;
    }

    /** Where a model's answers come from: "AWS Bedrock", "Anthropic API (via OpenRouter)", or not recognised. */
    function channelText(t, channel) {
      const upstream = channel?.upstream ? localText(t, channel.upstream.name) : null;
      const relay = channel?.relay ? localText(t, channel.relay.name) : null;
      if (upstream && relay) return t("channel.via", { upstream, relay });
      return upstream ?? relay ?? t("channel.unknown");
    }

    /** The latest active check of a model: `{ kind, at, outcome }`, or null. */
    function lastProbeOf(target) {
      const entries = Object.entries(target?.lastProbes ?? {}).map(([kind, value]) => ({ kind, ...value }));
      return entries.sort((a, b) => b.at - a.at)[0] ?? null;
    }

    const chipTone = (tone) => (tone === "ok" || tone === "warn" || tone === "bad" ? tone : undefined);
    const identityOf = (row) => (row?.excluded ? "excluded" : row?.identity?.state ?? "unchecked");
    const serviceOf = (row) => (row?.excluded ? "excluded" : row?.service?.state ?? "insufficient");
    const serviceText = (t, row) => (serviceOf(row) === "issues" ? t("service.issues", { count: row.service?.problems ?? 0 }) : t(`service.${serviceOf(row)}`));
    const likelyText = (t, row) => (row?.identity?.likely ? t("identity.likely", { name: localText(t, row.identity.likely) }) : null);
    const SEVERITY = { bad: 3, warn: 2, ok: 1, idle: 0 };

    /** Passive monitoring of this conversation, in a few words. */
    function passiveLine(t, view, target) {
      if (view.passive === false) return t("dock.passiveDisabled");
      if (target?.excluded) return t("dock.excluded");
      if (!view.tracked) return t("dock.passiveOff");
      return target ? t("dock.passiveValue", { here: target.samples?.here ?? 0, all: target.samples?.passive ?? 0 }) : t("dock.trackedHere");
    }
    /** The latest active check ("身份核验 · 5分钟前"), the one running, or what stands instead. */
    function activeLine(t, view, target) {
      if (target.run) return t("dock.activeRun", { kind: t(`kind.${target.run.kind}`), step: target.run.step, steps: target.run.steps });
      const last = lastProbeOf(target);
      if (last) return t(last.failed ? "dock.activeFailed" : last.auto ? "dock.activeValueAuto" : "dock.activeValue", { kind: t(`kind.${last.kind}`), time: since(t, last.at) });
      return view.active === false ? t("dock.activeDisabled") : t("dock.activeNone");
    }

    /** The status bar entry's hover card: the model, its identity and service, where answers come from, both parts. */
    function DockCard({ t, view, error }) {
      const target = view.target ?? null;
      const line = (key, label, value, tone, sub) => h("div", { key, className: "cxa-card-row" },
        h("span", { className: "cxa-card-key" }, label),
        h("span", { className: "cxa-card-value" },
          tone ? h("span", { className: "cxa-card-state", "data-tone": tone }, value) : h("span", null, value),
          sub ? h("span", { className: "cxa-card-sub" }, sub) : null));
      const foot = h("div", { className: "cxa-card-foot" }, t("dock.hint"), h("span", null, t("dock.rules", { version: view.rules?.version ?? "" })));
      if (!target) {
        return h("div", { className: "cxa-card" },
          h("div", { className: "cxa-card-head" }, h("span", { className: "cxa-card-site" }, t("dock.notCustom"))),
          h("div", { className: "cxa-card-rows" }, line("passive", t("dock.passive"), passiveLine(t, view, null))),
          foot);
      }
      const identity = identityOf(target);
      const service = serviceOf(target);
      return h("div", { className: "cxa-card" },
        h("div", { className: "cxa-card-head" },
          h("span", { className: "cxa-card-model" }, target.modelName),
          h("span", { className: "cxa-card-site" }, target.group ? `${target.siteName} ${t("dock.group", { group: target.group })}` : target.siteName)),
        h("div", { className: "cxa-card-rows" },
          line("identity", t("dock.identity"), t(`identity.${identity}`), IDENTITY_TONE[identity] ?? "idle", likelyText(t, target)),
          line("service", t("dock.service"), serviceText(t, target), SERVICE_TONE[service] ?? "idle"),
          line("upstream", t("dock.upstream"), channelText(t, target.channel)),
          line("passive", t("dock.passive"), passiveLine(t, view, target)),
          line("active", t("dock.active"), activeLine(t, view, target))),
        error ? h("div", { className: "cxa-card-error" }, t("error.generic", { message: error })) : null,
        foot);
    }

    /** The same as text, where DSH has no hover card. */
    function dockTipText(t, view, error) {
      const target = view.target ?? null;
      const row = (label, value) => t("dock.line", { label, value });
      if (!target) return [t("dock.notCustom"), row(t("dock.passive"), passiveLine(t, view, null)), t("dock.rules", { version: view.rules?.version ?? "" })].join("\n");
      const identity = identityOf(target);
      return [
        `${target.modelName} · ${target.siteName}`,
        row(t("dock.identity"), [t(`identity.${identity}`), likelyText(t, target)].filter(Boolean).join(" · ")),
        row(t("dock.service"), serviceText(t, target)),
        row(t("dock.upstream"), channelText(t, target.channel)),
        row(t("dock.passive"), passiveLine(t, view, target)),
        row(t("dock.active"), activeLine(t, view, target)),
        error ? t("error.generic", { message: error }) : null,
        t("dock.rules", { version: view.rules?.version ?? "" }),
      ].filter(Boolean).join("\n");
    }

    const startProbe = (target, kind) => call("authnProbe", { siteId: target.siteId, modelId: target.modelId, kind });

    /** Before an active check: what it sends, roughly what it costs. */
    function ProbeConfirm({ t, target, kind, onRun, onClose }) {
      const estimate = target?.estimates?.[kind];
      const cost = Number.isFinite(estimate?.usd) && estimate.usd > 0 ? t("confirm.cost", { cost: amountText(estimate.usd, "USD") }) : "";
      // The most the check may take: every retry and every output token its requests allow.
      const maxCost = Number.isFinite(estimate?.maxUsd) && estimate.maxUsd > (estimate.usd ?? 0) ? t("confirm.maxCost", { cost: amountText(estimate.maxUsd, "USD") }) : "";
      const limit = (estimate?.maxRequests ?? 0) > (estimate?.requests ?? 0) || maxCost ? t("confirm.max", { requests: estimate.maxRequests ?? estimate.requests, cost: maxCost }) : null;
      return h(P.Modal, {
        open: true,
        onClose,
        title: t("confirm.title", { kind: t(`kind.${kind}`) }),
        closeLabel: t("confirm.cancel"),
        className: "cx-modal",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          h("span", null, t(`confirm.body.${kind}`, { site: target.siteName, model: target.modelName, requests: estimate?.requests ?? "?", tokens: compact(estimate?.tokens ?? 0), cost, set: target.fingerprint?.name ?? "", date: target.fingerprint?.date ?? "" })),
          kind === "fingerprint" && target.fingerprint ? h("span", { className: "cx-muted" }, t(target.fingerprint.relation === "variant" ? "confirm.fingerprintVariant" : "confirm.fingerprintNamed", { date: target.fingerprint.date ?? "", model: target.modelId ?? target.modelName, reference: target.fingerprint.reference ?? target.fingerprint.name })) : null,
          limit ? h("span", { className: "cx-muted" }, limit) : null,
          estimate?.peers?.length ? h("span", { className: "cx-muted" }, t("confirm.peers", { n: estimate.peerRequests ?? estimate.peers.length, sites: estimate.peers.join(t("confirm.peerSep")) })) : null),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", onClick: onClose }, t("confirm.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", "data-modal-autofocus": true, onClick: onRun }, t("confirm.run"))),
      });
    }

    /** Where DSH's menu primitive is missing: the same actions in a small dialog. */
    function DockFallback({ t, items, tracked, onSelect, onClose }) {
      return h(P.Modal, {
        open: true,
        onClose,
        title: t("dock.title"),
        closeLabel: t("confirm.cancel"),
        className: "cx-modal",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" }, items.filter((item) => !item.type).map((item) => h(P.Button, { key: item.id, className: "cx-btn", size: "sm", variant: "outline", disabled: item.disabled, onClick: () => onSelect(item.id) }, item.id === "passive" ? t("dock.fallbackPassive", { label: item.label, state: tracked ? t("dock.on") : t("dock.off") }) : item.label))),
      });
    }

    /**
     * The entry in each conversation's status bar (`conversation.composer.dock`): a shield (the identity of the
     * site's model this conversation uses), an eye (passive scanning of this conversation) and a radar (active
     * checks); details on hover, actions on click. Shown while model checks are on.
     */
    function AuthnDock(props) {
      const t = typeof props.t === "function" ? props.t : (key) => key;
      const use = typeof props.useProjection === "function" ? props.useProjection : null;
      const selection = use ? use("modelSelection") : undefined;
      const chosen = selection?.next ?? selection?.lastUsed ?? null;
      const route = typeof chosen?.provider === "string" ? chosen.provider : null;
      const modelId = typeof chosen?.model === "string" ? chosen.model : null;
      const sessionId = props.sessionId === undefined || props.sessionId === null ? null : String(props.sessionId);
      const [view, setView] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [confirm, setConfirm] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
      React.useEffect(() => {
        let stopped = false;
        let timer;
        const load = async () => {
          let next = null;
          try {
            if (typeof document === "undefined" || document.visibilityState !== "hidden") {
              next = await call("authnSession", { ...(sessionId ? { sessionId } : {}), ...(route ? { route } : {}), ...(modelId ? { model: modelId } : {}) });
              if (!stopped) setView(next);
            }
          } catch {
            /* the host half not loaded yet (or restarting): asked again */
          }
          if (!stopped) timer = setTimeout(load, next?.target?.run ? 1500 : next?.enabled ? 6000 : 30000);
        };
        void load();
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }, [sessionId, route, modelId, nonce]);
      if (!view || !view.enabled || view.dock === false) return null;
      const target = view.target ?? null;
      const act = async (work) => {
        setError(null);
        try {
          await work();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
        setNonce((value) => value + 1);
      };
      const identity = target ? identityOf(target) : null;
      const tone = !target ? "dim" : IDENTITY_TONE[identity] ?? "idle";
      const tracked = view.tracked === true;
      const passiveOn = view.passive !== false;
      const activeOn = view.active !== false;
      const watching = passiveOn && tracked && !target?.excluded;
      const running = target?.run ?? null;
      const last = target ? lastProbeOf(target) : null;
      const short = identity === "suspect" || identity === "substituted" ? t(`identity.${identity}`) : null;
      const onSelect = (id) => {
        setOpen(false);
        if (id === "passive" && sessionId) void act(() => call("authnTrack", { sessionId, on: !tracked }));
        else if ((id === "identity" || id === "quick" || id === "signature" || id === "fingerprint") && target) {
          if (view.confirmProbes !== false) setConfirm(id);
          else void act(() => startProbe(target, id));
        } else if (id === "cancel" && target) void act(() => call("authnCancel", { siteId: target.siteId, modelId: target.modelId }));
        else if (id === "page") {
          writePage(AUTHN_PAGE);
          if (target) writeSiteTab(target.siteId);
        }
      };
      const unusable = !target || Boolean(target.excluded);
      const items = [
        ...(passiveOn ? [{ id: "passive", label: t("dock.menuPassive"), disabled: !sessionId }, { type: "separator", id: "s1" }] : []),
        ...(activeOn ? [
          { type: "label", id: "l1", text: t("dock.menuActive") },
          ...(running ? [{ id: "cancel", label: t("dock.menuCancel") }] : [
            { id: "identity", label: t("dock.menuIdentity", { requests: target?.estimates?.identity?.requests ?? 2 }), disabled: unusable },
            { id: "quick", label: t("dock.menuQuick", { requests: target?.estimates?.quick?.requests ?? "?" }), disabled: unusable },
            target?.canSignature ? { id: "signature", label: t("dock.menuSignature", { requests: target.estimates?.signature?.requests ?? 3 }), disabled: unusable } : null,
            target?.fingerprint ? { id: "fingerprint", label: t("dock.menuFingerprint", { requests: target.estimates?.fingerprint?.requests ?? target.fingerprint.requests }), disabled: unusable } : null,
          ]),
          { type: "separator", id: "s2" },
        ] : []),
        { id: "page", label: t("dock.menuPage") },
      ].filter(Boolean);
      const button = h("button", {
        type: "button",
        className: "cxa-dock",
        "data-tone": tone,
        "aria-haspopup": "menu",
        "aria-expanded": open ? "true" : "false",
        "aria-label": t("dock.aria", { verdict: identity ? t(`identity.${identity}`) : t("dock.notCustomShort") }),
        onClick: () => setOpen(!open),
      },
        h("span", { className: "cxa-shield" }, h(AuthnShieldIcon, { check: identity === "confirmed" || identity === "consistent" })),
        short ? h("span", { className: "cxa-label" }, short) : null,
        h("span", { className: "cxa-eye", "data-on": watching ? "true" : "false", "data-off": passiveOn ? "false" : "true" }, h(EyeIcon, { off: !watching })),
        h("span", { className: "cxa-radar", "data-running": running ? "true" : "false", "data-off": activeOn ? "false" : "true", "data-tone": last && !running ? OUTCOME_TONE[last.outcome] ?? "idle" : undefined }, h(RadarIcon)),
        running ? h("span", { className: "cxa-run" }, t("dock.run", { kind: t(`dock.run.${running.kind}`), step: running.step, steps: running.steps })) : null,
        error ? h("span", { className: "cxa-error-dot", "aria-hidden": true }) : null);
      // The card while hovering (DSH's hover card; its text form in a tooltip where there is none); none while the menu is open.
      const anchor = typeof P.HoverCard === "function"
        ? h("span", { className: "cxa-dock-wrap" }, h(P.HoverCard, { anchor: button, content: h(DockCard, { t, view, error }), openDelayMs: 300, disabled: open || Boolean(confirm) }))
        : open ? button : h(Tip, { label: dockTipText(t, view, error) }, button);
      const menu = typeof P.Menu === "function"
        ? h(P.Menu, { open, anchor, items, selectedIds: tracked && passiveOn ? ["passive"] : [], selection: "check", onSelect, onClose: () => setOpen(false), side: "top", align: "end", portal: true, dense: true })
        : h(React.Fragment, null, anchor, open ? h(DockFallback, { t, items, tracked, onSelect, onClose: () => setOpen(false) }) : null);
      return h(React.Fragment, null, menu,
        confirm && target ? h(ProbeConfirm, {
          t,
          target,
          kind: confirm,
          onClose: () => setConfirm(null),
          onRun: () => {
            const kind = confirm;
            setConfirm(null);
            void act(() => startProbe(target, kind));
          },
        }) : null);
    }

    /** A measured figure as the detail panel shows it. */
    function metricValue(t, metric, row = null) {
      const params = metric.params ?? {};
      switch (metric.id) {
        case "knowledge":
          if (params.verdict) {
            const version = params.relation === "variant" ? "Version" : "";
            return t("metric.knowledge.value", { ...params, verdict: t(params.verdict === "pass" ? `metric.knowledge.same${version}` : params.verdict === "fail" ? `metric.knowledge.diff${version}` : "metric.knowledge.na"), time: since(t, params.at) });
          }
          if (row?.job && !row?.run) return t("metric.knowledge.paused", { next: row.job.next });
          return row?.fingerprint ? t(row.fingerprint.relation === "variant" ? "metric.knowledge.readyVersion" : "metric.knowledge.ready", { set: row.fingerprint.name, date: row.fingerprint.date ?? "", requests: row.estimates?.fingerprint?.requests ?? row.fingerprint.requests }) : t("metric.knowledge.none");
        case "echo": return params.value ? t("metric.echo.value", params) : t("metric.echo.na");
        case "cpt-en":
        case "cpt-zh":
          if (params.value === null || params.value === undefined) return t("metric.cpt.na", { n: params.n ?? 0, need: params.need ?? "?" });
          return params.low ? t("metric.cpt.value", { ...params, family: localText(t, params.family) }) : t("metric.cpt.valueNoBand", params);
        case "tokenizer": return params.delta === undefined || params.delta === null ? t("metric.tokenizer.na") : t("metric.tokenizer.value", { delta: params.delta, group: params.group ? localText(t, params.group) : "—", time: since(t, params.at) });
        case "signature": return metric.status === "ok" ? t(params.consistent ? "metric.signature.consistent" : "metric.signature.verified") : params.total ? t("metric.signature.value", params) : t("metric.signature.na");
        case "upstream": return params.list ? localText(t, params.list) : t("metric.upstream.na");
        case "speed": return params.value !== undefined ? t("metric.speed.value", params) : params.hidden ? t("metric.speed.hidden", params) : t("metric.na");
        case "input-ratio": return params.value ? t("metric.input-ratio.value", params) : t("metric.input-ratio.na", params);
        case "ttft": return params.value !== undefined ? t("metric.ttft.value", params) : t("metric.na");
        case "stub":
        case "empty": return params.total ? t("metric.count", params) : t("metric.na");
        case "tools": return params.calls ? t("metric.tools.value", params) : t("metric.tools.na");
        case "usage": return params.value ? t("metric.usage.value", params) : t("metric.usage.na", params);
        case "site-log": return params.n ? t("metric.site-log.value", params) : t("metric.site-log.na");
        default: return "—";
      }
    }

    /** Evidence lines: where each came from, what it says, when; its weight on hover. */
    const evidenceList = (t, items) => h("ul", { className: "cxa-ev-list" }, items.map((item, index) => h("li", { key: `${item.id}-${index}`, "data-level": item.level, title: t(`level.${item.level}`) },
      h("span", { className: "cxa-source" }, item.auto ? t("source.auto", { source: t(`source.${item.source}`) }) : t(`source.${item.source}`)),
      item.basis ? h("span", { className: "cxa-basis", "data-basis": item.basis, title: t(`basisTitle.${item.basis}`) }, t(`basis.${item.basis}`)) : null,
      h("span", { className: "cxa-ev-text" }, evidenceText(t, item), item.cleared ? h("span", { className: "cx-muted" }, ` · ${t("ev.cleared")}`) : null),
      item.at ? h("span", { className: "cx-muted" }, clock(item.at)) : null)));

    /**
     * Under a model's row: identity and service side by side, each with what passive monitoring measures (its figure,
     * reference and status) and the basis of its state; notes that judge nothing below.
     */
    function AuthnDetail({ t, row, active, onProbe }) {
      // The site's own figures for this model (new-api's performance metrics), shown beside what was measured here.
      const sitePerf = useStore().status?.relay?.[row.siteId]?.perf?.models?.[row.modelId] ?? null;
      const evidence = row.evidence ?? [];
      const metrics = row.metrics ?? [];
      const part = (axis) => {
        const state = axis === "identity" ? identityOf(row) : serviceOf(row);
        const tone = (axis === "identity" ? IDENTITY_TONE : SERVICE_TONE)[state] ?? "idle";
        const items = evidence.filter((item) => item.axis === axis);
        const figures = metrics.filter((metric) => metric.axis === axis);
        return h("section", { className: "cxa-part", "aria-label": t(`authn.col.${axis}`) },
          h("div", { className: "cxa-part-head" },
            h("span", null, t(`authn.col.${axis}`)),
            h("span", { className: "cx-chip", "data-tone": chipTone(tone), title: t(`${axis}Title.${state}`) }, axis === "identity" ? t(`identity.${state}`) : serviceText(t, row)),
            axis === "identity" && row.identity?.likely ? h("span", { className: "cxa-likely" }, likelyText(t, row)) : null),
          figures.length ? h("dl", { className: "cxa-metrics", "aria-label": t("panel.metrics") }, figures.map((metric) => h(React.Fragment, { key: metric.id },
            h("dt", null, t(`metric.${metric.id}`)),
            h("dd", null, metricValue(t, metric, row)),
            h("dd", { className: "cxa-mstatus", "data-tone": metric.status }, ["ok", "warn", "bad"].includes(metric.status) ? t(`metricStatus.${metric.status}`) : "")))) : null,
          h("span", { className: "cxa-sub" }, t("authn.evidenceTitle")),
          items.length ? evidenceList(t, items) : h("span", { className: "cx-muted cxa-none" }, t("panel.none")),
          axis === "identity" && active && !row.run && !row.excluded && (state === "unchecked" || state === "clean")
            ? h("div", null, h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(FingerprintIcon), title: t("authn.identityTitle", { requests: row.estimates?.identity?.requests ?? 2 }), onClick: () => onProbe(row, "identity") }, t("panel.runIdentity")))
            : null);
      };
      const notes = evidence.filter((item) => item.axis === "info");
      return h("div", { className: "cxa-detail", role: "row" },
        h("div", { role: "cell", className: "cxa-detail-grid" },
          part("identity"),
          part("service"),
          notes.length ? h("section", { className: "cxa-part cxa-notes", "aria-label": t("panel.info") }, h("span", { className: "cxa-sub" }, t("panel.info")), evidenceList(t, notes)) : null,
          sitePerf ? h("span", { className: "cx-muted cxa-spent" }, t("panel.sitePerf", { success: typeof sitePerf.successRate === "number" ? `${(sitePerf.successRate * 100).toFixed(1)}%` : "—", latency: typeof sitePerf.latencyMs === "number" ? t("time.seconds", { s: (sitePerf.latencyMs / 1000).toFixed(1) }) : "—", tps: typeof sitePerf.tps === "number" ? Math.round(sitePerf.tps) : "—" })) : null,
          row.spent?.requests ? h("span", { className: "cx-muted cxa-spent" }, t("panel.spent", { requests: row.spent.requests, input: compact(row.spent.input), output: compact(row.spent.output) })) : null));
    }

    /**
     * One site's models: upstream, identity (is it the model named?), service (is it served faithfully?), samples; the
     * figures and the basis under the row (open by itself when the identity is in doubt, toggled from either state);
     * the checks per row.
     */
    function AuthnTable({ t, rows, active, isOpen, onToggle, onProbe, onCancel, onForget }) {
      const [forgetting, setForgetting] = React.useState(null);
      if (!rows.length) return h("div", { className: "cx-empty" }, h("span", null, t("authn.siteNoModels")));
      return h("section", { className: "cx-card", "aria-label": t("authn.results") },
        h("div", { className: "cx-card-head" }, h("span", { className: "cx-card-title" }, t("authn.results"))),
        h("div", { className: "cx-table cxa-table", role: "table" },
          h("div", { className: "cx-tr cx-th", role: "row" },
            h("span", { role: "columnheader" }, t("authn.col.model")),
            h("span", { role: "columnheader" }, t("authn.col.channel")),
            h("span", { role: "columnheader" }, t("authn.col.identity")),
            h("span", { role: "columnheader" }, t("authn.col.service")),
            h("span", { role: "columnheader", className: "cx-num" }, t("authn.col.samples")),
            h("span", { role: "columnheader" })),
          rows.map((row) => {
            const key = `${row.siteId}/${row.modelId}`;
            const identity = identityOf(row);
            const service = serviceOf(row);
            const open = isOpen(row);
            const sampled = (row.samples?.passive ?? 0) + (row.samples?.failed ?? 0) + (row.samples?.probes ?? 0) > 0;
            const confirming = forgetting === key;
            const probeButton = (kind, icon) => h("button", { key: kind, type: "button", className: "cx-icon", disabled: row.excluded, title: t(kind === "fingerprint" && row.fingerprint?.relation === "variant" ? "authn.fingerprintVersionTitle" : `authn.${kind}Title`, { requests: row.estimates?.[kind]?.requests ?? "?", set: row.fingerprint?.name ?? "", date: row.fingerprint?.date ?? "" }), "aria-label": t(`kind.${kind}`), onClick: () => onProbe(row, kind) }, h(icon));
            // While a test runs: its step (the kind and the wait on hover) and a stop icon, within the column.
            const tools = row.run
              ? [h("span", { key: "run", className: "cxa-row-run", title: t(row.run.kind === "fingerprint" ? "authn.fingerprintRunTitle" : "authn.runTitle", { kind: t(`kind.${row.run.kind}`), step: row.run.step, steps: row.run.steps }) }, h(row.run.kind === "fingerprint" ? BookIcon : RadarIcon), `${row.run.step}/${row.run.steps}`),
                h("button", { key: "stop", type: "button", className: "cx-icon", title: t("authn.stop"), "aria-label": t("authn.stop"), onClick: () => onCancel(row) }, h(StopIcon))]
              : [
                active && !confirming ? probeButton("identity", FingerprintIcon) : null,
                active && !confirming ? probeButton("quick", RadarIcon) : null,
                active && row.canSignature && !confirming ? probeButton("signature", AuthnShieldIcon) : null,
                active && row.fingerprint && !confirming ? probeButton("fingerprint", BookIcon) : null,
                h("button", {
                  key: "forget",
                  type: "button",
                  className: "cx-icon",
                  "data-confirm": confirming ? "true" : "false",
                  disabled: !sampled,
                  title: t("authn.forget"),
                  "aria-label": confirming ? t("authn.forgetConfirm") : t("authn.forget"),
                  onClick: () => {
                    if (!confirming) {
                      setForgetting(key);
                      setTimeout(() => setForgetting(null), 4000);
                      return;
                    }
                    setForgetting(null);
                    onForget(row);
                  },
                }, confirming ? t("authn.forgetConfirm") : h(TrashIcon)),
              ];
            // Either state opens the figures and the basis under the row.
            const toggle = (axis, label, tone, tip) => h("button", { type: "button", className: "cxa-verdict", "data-axis": axis, "aria-expanded": open ? "true" : "false", title: [tip, t(open ? "authn.evidenceHide" : "authn.evidenceCount")].filter(Boolean).join("\n"), onClick: () => onToggle(row, !open) },
              h("span", { className: "cx-chip", "data-tone": chipTone(tone) }, label, h("span", { className: "cxa-chevron", "aria-hidden": true }, h(ChevronIcon))));
            const samples = { passive: row.samples?.passive ?? 0, sessions: row.samples?.sessions ?? 0, failed: row.samples?.failed ?? 0, probes: row.samples?.probes ?? 0 };
            return h(React.Fragment, { key },
              h("div", { className: "cx-tr cxa-row", role: "row", "data-off": row.siteEnabled === false ? "true" : "false" },
                h("span", { role: "cell", className: "cx-model-cell" },
                  h("span", { className: "cx-model-title", title: row.modelName }, row.modelName),
                  row.modelId !== row.modelName ? h("span", { className: "cx-model-id" }, row.modelId) : null),
                sampled
                  ? h("span", { role: "cell", className: "cx-ellipsis", title: (row.channel?.signals ?? []).map((signal) => localText(t, signal.note)).join("\n") || t("channel.unknownTitle") }, channelText(t, row.channel))
                  : h("span", { role: "cell", className: "cx-muted", title: t("authn.noSamples") }, "—"),
                h("span", { role: "cell" }, toggle("identity", t(`identity.${identity}`), IDENTITY_TONE[identity], [t(`identityTitle.${identity}`), likelyText(t, row)].filter(Boolean).join("\n"))),
                h("span", { role: "cell" }, toggle("service", serviceText(t, row), SERVICE_TONE[service], t(`serviceTitle.${service}`))),
                h("span", { role: "cell", className: "cx-num", title: sampled ? t("authn.samplesTitle", samples) : t("authn.noSamples") }, sampled ? t("authn.samples", samples) : "—"),
                h("span", { role: "cell", className: "cx-row-tools" }, tools)),
              open ? h(AuthnDetail, { t, row, active, onProbe }) : null);
          })));
    }

    /** The rule pack: which one is in use, updates, back to the built-in one. */
    function AuthnRulesCard({ t, rules, fingerprints = null, busy, onAct }) {
      if (!rules) return null;
      const upstream = fingerprints?.upstream ?? null;
      return h("section", { className: "cx-card", "aria-label": t("rules.title") },
        h("div", { className: "cx-card-head" },
          h("span", { className: "cx-card-title" }, t("rules.title")),
          h("span", { className: "cx-tag", title: t("rules.hint") }, t(rules.origin === "online" ? "rules.online" : "rules.builtin")),
          h("span", { className: "cx-spacer" }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: !rules.configured || busy === "rules", title: rules.configured ? undefined : t("rules.notConfigured"), onClick: () => void onAct("rules", () => call("authnRules", { action: "check" })) }, busy === "rules" ? t("rules.checking") : t("rules.check")),
          rules.origin === "online" ? h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy === "rollback", onClick: () => void onAct("rollback", () => call("authnRules", { action: "rollback" })) }, t("rules.rollback")) : null),
        h("div", { className: "cx-card-body cx-summary" },
          h("span", null, t("rules.version", { version: rules.version, published: rules.published })),
          !rules.configured ? h("span", { className: "cx-muted" }, t("rules.notConfigured")) : rules.checkedAt ? h("span", { className: "cx-muted" }, t("rules.checkedAt", { time: since(t, rules.checkedAt) })) : null,
          rules.error && rules.error !== "not-configured" ? h("span", { className: "cx-error" }, t("rules.error", { error: rules.error })) : null,
          fingerprints ? h("span", { className: "cxa-fp-line" },
            h("span", null, t("rules.fingerprints", { sets: fingerprints.sets, name: fingerprints.source?.name ?? "", license: fingerprints.source?.license ?? "", date: fingerprints.latest ?? "" })),
            upstream?.error ? h("span", { className: "cx-error" }, t("rules.fingerprintsUpstreamError", { error: upstream.error })) : upstream?.checkedAt ? h("span", { className: "cx-muted" }, t("rules.fingerprintsUpstream", { sets: upstream.sets, time: since(t, upstream.checkedAt) })) : null,
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy === "fingerprints", onClick: () => void onAct("fingerprints", () => call("authnRules", { action: "fingerprints" })) }, busy === "fingerprints" ? t("rules.fingerprintsChecking") : t("rules.fingerprintsCheck"))) : null));
    }

    /** The intervals the automatic identity check offers (minutes; the host takes these only). */
    const AUTO_INTERVALS = [30, 60, 120, 360, 720, 1440];
    /** The daily caps of automatic identity checks offered (all models together; the host keeps the same list). */
    const AUTO_DAILY = [3, 6, 12, 24, 48];

    /** The settings of model checks. */
    function AuthnSettingsCard({ t, settings, onSave, onClear }) {
      const [days, setDays] = React.useState(String(settings.keepDays));
      const [url, setUrl] = React.useState(settings.customUrl ?? "");
      const [clearing, setClearing] = React.useState(false);
      React.useEffect(() => { setDays(String(settings.keepDays)); }, [settings.keepDays]);
      React.useEffect(() => { setUrl(settings.customUrl ?? ""); }, [settings.customUrl]);
      const check = (field, label, title) => h("label", { className: "cx-check", title }, h("input", { type: "checkbox", checked: settings[field] === true, onChange: (event) => void onSave({ [field]: event.target.checked }) }), label);
      const daysValue = Number(days);
      const daysValid = Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 365;
      const urlValid = url === "" || /^https:\/\/\S+$/i.test(url);
      return h("section", { className: "cx-card", "aria-label": t("aset.title") },
        h("div", { className: "cx-card-head" }, h("span", { className: "cx-card-title" }, t("aset.title"))),
        h("div", { className: "cx-card-body cx-dialog" },
          h("section", { className: "cxa-group", "aria-label": t("aset.group.passive") },
            h("span", { className: "cxa-group-title" }, t("aset.group.passive")),
            check("passiveDefault", t("aset.passiveDefault"), t("aset.passiveDefaultTitle"))),
          h("section", { className: "cxa-group", "aria-label": t("aset.group.active") },
            h("span", { className: "cxa-group-title" }, t("aset.group.active")),
            check("confirmProbes", t("aset.confirm"), t("aset.confirmTitle")),
            check("crossSite", t("aset.crossSite"), t("aset.crossSiteTitle")),
            check("autoIdentity", t("aset.autoIdentity"), t("aset.autoIdentityTitle")),
            h("div", { className: "cx-field" },
              h("label", { htmlFor: "cxa-auto-interval" }, t("aset.autoInterval")),
              h("select", { id: "cxa-auto-interval", className: "cx-select", value: String(settings.autoIdentityMinutes ?? 60), disabled: settings.autoIdentity !== true, onChange: (event) => void onSave({ autoIdentityMinutes: Number(event.target.value) }) },
                AUTO_INTERVALS.map((minutes) => h("option", { key: minutes, value: String(minutes) }, t(`aset.autoInterval.${minutes}`))))),
            h("div", { className: "cx-field" },
              h("label", { htmlFor: "cxa-auto-daily" }, t("aset.autoDaily")),
              h("select", { id: "cxa-auto-daily", className: "cx-select", value: String(settings.autoIdentityDaily ?? 12), disabled: settings.autoIdentity !== true, onChange: (event) => void onSave({ autoIdentityDaily: Number(event.target.value) }) },
                AUTO_DAILY.map((count) => h("option", { key: count, value: String(count) }, t("aset.autoDaily.option", { n: count })))))),
          h("section", { className: "cxa-group", "aria-label": t("aset.group.rules") },
            h("span", { className: "cxa-group-title" }, t("aset.group.rules")),
            check("autoUpdate", t("aset.autoUpdate"), t("aset.autoUpdateTitle")),
            check("fingerprintUpstream", t("aset.fingerprintUpstream"), t("aset.fingerprintUpstreamTitle")),
            h("div", { className: "cx-field" },
              h("label", null, t("aset.source")),
              h(Segmented, { id: "cxa-source", value: settings.updateSource, label: t("aset.source"), options: ["github", "jsdelivr", "custom"].map((value) => ({ value, label: t(`aset.source.${value}`) })), onChange: (value) => void onSave({ updateSource: value }) })),
            settings.updateSource === "custom" ? h("div", { className: "cx-field" },
              h("label", { htmlFor: "cxa-url" }, t("aset.customUrl")),
              h("input", { id: "cxa-url", className: "cx-text", value: url, placeholder: "https://", spellCheck: false, "aria-invalid": urlValid ? undefined : "true", onChange: (event) => setUrl(event.target.value.trim()), onBlur: () => { if (urlValid && url !== (settings.customUrl ?? "")) void onSave({ customUrl: url }); } })) : null),
          h("section", { className: "cxa-group", "aria-label": t("aset.group.data") },
            h("span", { className: "cxa-group-title" }, t("aset.group.data")),
            check("dock", t("aset.dock"), t("aset.dockTitle")),
            h("div", { className: "cx-row2" },
              h("div", { className: "cx-field" },
                h("label", { htmlFor: "cxa-keep-days" }, t("aset.keepDays")),
                h("input", { id: "cxa-keep-days", className: "cx-text", value: days, inputMode: "numeric", title: t("aset.keepDaysTitle"), "aria-invalid": daysValid ? undefined : "true", onChange: (event) => setDays(event.target.value), onBlur: () => { if (daysValid && daysValue !== settings.keepDays) void onSave({ keepDays: daysValue }); } })))),
          h("div", { className: "cx-form-actions" },
            h(P.Button, {
              className: "cx-btn",
              size: "sm",
              variant: "outline",
              onClick: () => {
                if (!clearing) {
                  setClearing(true);
                  setTimeout(() => setClearing(false), 4000);
                  return;
                }
                setClearing(false);
                void onClear();
              },
            }, clearing ? t("aset.clearConfirm") : t("aset.clearAll")))));
    }

    /** The worst state among a site's models (identity or service), as its tab's dot. */
    function siteTone(rows) {
      let worst = "idle";
      for (const row of rows) {
        for (const tone of [IDENTITY_TONE[identityOf(row)], SERVICE_TONE[serviceOf(row)]]) if ((SEVERITY[tone] ?? 0) > SEVERITY[worst]) worst = tone;
      }
      return chipTone(worst);
    }
    const SITE_TAB_STORE = "dsh-custom-models.authn-site";
    function readSiteTab() {
      try {
        return globalThis.localStorage?.getItem(SITE_TAB_STORE) ?? null;
      } catch {
        return null;
      }
    }
    function writeSiteTab(siteId) {
      try {
        globalThis.localStorage?.setItem(SITE_TAB_STORE, siteId);
      } catch {
        /* storage blocked: the tab is simply not remembered */
      }
    }

    /** The model verification page: its two switches, one sub-tab per site (its models' identity, service, figures and tests), the rule pack, the settings. */
    function AuthnPage({ t }) {
      const [report, setReport] = React.useState(null);
      const [siteTab, setSiteTab] = React.useState(readSiteTab);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      // Rows the user opened or closed; otherwise a row whose identity is in doubt (疑似替换 / 非标称模型) opens by itself.
      const [toggled, setToggled] = React.useState({});
      const [confirm, setConfirm] = React.useState(null);
      const load = React.useCallback(async () => {
        try {
          setReport(await call("authnReport", {}));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      }, []);
      const running = (report?.rows ?? []).some((row) => row.run);
      React.useEffect(() => {
        void load();
        const timer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") void load(); }, running ? 1500 : 8000);
        return () => clearInterval(timer);
      }, [load, running]);
      const settings = report?.settings ?? null;
      const act = async (key, work) => {
        setBusy(key);
        setError(null);
        try {
          await work();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(null);
          await load();
        }
      };
      const save = (patch) => act("settings", async () => {
        await call("authnSettings", { patch });
        void loadStatus();
      });
      const probe = (row, kind) => {
        if (settings?.confirmProbes !== false) setConfirm({ row, kind });
        else void act(`${row.siteId}/${row.modelId}`, () => startProbe(row, kind));
      };
      const passiveOn = settings?.passive === true;
      const activeOn = settings?.active === true;
      const enabled = passiveOn || activeOn;
      // One sub-tab per site, in the sites' order; the remembered one, else the first.
      const sites = [];
      for (const row of report?.rows ?? []) {
        let entry = sites.find((item) => item.id === row.siteId);
        if (!entry) sites.push((entry = { id: row.siteId, name: row.siteName, enabled: row.siteEnabled !== false, rows: [] }));
        entry.rows.push(row);
      }
      const shown = sites.find((item) => item.id === siteTab) ?? sites[0] ?? null;
      const pick = (siteId) => {
        setSiteTab(siteId);
        writeSiteTab(siteId);
      };
      const rowKey = (row) => `${row.siteId}/${row.modelId}`;
      const isOpen = (row) => toggled[rowKey(row)] ?? ["suspect", "substituted"].includes(identityOf(row));
      const onToggle = (row, open) => setToggled((current) => ({ ...current, [rowKey(row)]: open }));
      // Each switch with its name beside it (the name toggles too); what it does on hover.
      const switchOf = (field, label, title) => {
        const on = settings?.[field] === true;
        return h("span", { className: "cxa-switch", title },
          h("span", { className: "cxa-switch-label", "data-on": on ? "true" : "false", "aria-hidden": true, onClick: () => void save({ [field]: !on }) }, label),
          h("span", { className: "cx-switch" }, h(P.Switch, { checked: on, label, title, onChange: (next) => void save({ [field]: next }) })));
      };
      return h("div", { className: "cx-page" },
        h(PageHead, {
          title: t("authn.title"),
          sub: t("authn.sub"),
          actions: settings ? h("span", { className: "cxa-switches" },
            switchOf("passive", t("authn.passive"), t("authn.passiveTitle")),
            switchOf("active", t("authn.active"), t("authn.activeTitle"))) : null,
        }),
        errorLine(t, error),
        !settings ? h("div", { className: "cx-placeholder" }, t("authn.loading")) : null,
        settings && !enabled ? h("div", { className: "cx-empty" }, h("span", null, t("authn.offHint"))) : null,
        settings && enabled && sites.length === 0 ? h("div", { className: "cx-empty" }, h("span", null, t("authn.noRows"))) : null,
        settings && enabled && shown ? h("div", { className: "cxa-tabs", role: "tablist", "aria-label": t("authn.siteTabs") }, sites.map((site) => h("button", {
          key: site.id,
          type: "button",
          role: "tab",
          className: "cxa-tab",
          "aria-selected": site.id === shown.id ? "true" : "false",
          "data-off": site.enabled ? "false" : "true",
          tabIndex: site.id === shown.id ? 0 : -1,
          onClick: () => pick(site.id),
          onKeyDown: (event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            const index = sites.findIndex((item) => item.id === shown.id);
            const next = sites[(index + (event.key === "ArrowRight" ? 1 : sites.length - 1)) % sites.length];
            if (next) pick(next.id);
          },
        }, h("span", { className: "cxa-dot", "data-tone": siteTone(site.rows), "aria-hidden": true }), site.name))) : null,
        settings && enabled && shown ? h(AuthnTable, {
          t,
          active: activeOn,
          rows: shown.rows,
          isOpen,
          onToggle,
          onProbe: probe,
          onCancel: (row) => void act(`${row.siteId}/${row.modelId}`, () => call("authnCancel", { siteId: row.siteId, modelId: row.modelId })),
          onForget: (row) => void act(`${row.siteId}/${row.modelId}`, () => call("authnClear", { siteId: row.siteId, modelId: row.modelId })),
        }) : null,
        settings ? h(AuthnRulesCard, { t, rules: report.rules, fingerprints: report.fingerprints ?? null, busy, onAct: act }) : null,
        settings ? h(AuthnSettingsCard, { t, settings, onSave: save, onClear: () => act("clear", () => call("authnClear", {})) }) : null,
        confirm ? h(ProbeConfirm, {
          t,
          target: confirm.row,
          kind: confirm.kind,
          onClose: () => setConfirm(null),
          onRun: () => {
            const { row, kind } = confirm;
            setConfirm(null);
            void act(`${row.siteId}/${row.modelId}`, () => startProbe(row, kind));
          },
        }) : null);
    }

    // ------------------------------------------------------------------ apply

    const METHODS = ["status", "discoverModels", "saveSite", "removeSite", "reorderSites", "setSiteEnabled", "addModels", "removeModels", "updateModel", "addKeys", "updateKey", "removeKey", "switchKey", "reorderKeys", "checkKeys", "saveGroup", "removeGroup", "switchGroup", "authnSession", "authnReport", "authnTrack", "authnSettings", "authnProbe", "authnCancel", "authnRules", "authnClear", "setSiteAuthn", "setSiteAccount"];
    const inert = (typeSymbol) => ({ mode: "strict", typeSymbol, create: () => ({ parse: (value) => value }) });
    const descriptors = METHODS.map((method) => ({
      id: `dsh-custom-models#customModels/${method}`,
      service: "customModelsKeys",
      namespace: "customModels",
      method,
      invocation: { kind: "direct" },
      parameters: [{ name: "request", wire: "request", source: "json", codec: inert(`dsh-custom-models/types#${method}Request`) }],
      cancellation: { parameter: "signal" },
      result: inert(`dsh-custom-models/types#${method}Result`),
    }));

    // ------------------------------------------------------------ hover notes

    /**
     * Hover notes drawn as DSH draws its own (ui-primitives Tooltip: the bubble's colour tokens, 13 / 20 px type, line
     * breaks kept, long words broken), at most TIP_MAX_WIDTH wide: the browser's bubble for a `title` grows to most of
     * the window's width with a long note. On this plugin's surfaces only (TIP_SCOPE): the `title` under the pointer,
     * or under keyboard focus, is held aside while its bubble shows, so the browser draws none, and put back after.
     * A reload of the plugin replaces the previous layer.
     */
    const TIP_SCOPE = "[class^=\"cx\"], [class*=\" cx\"]";
    const TIP_MAX_WIDTH = 320;
    const TIP_DELAY_MS = 350;
    const TIP_GAP = 8;
    const TIP_MARGIN = 12;
    function installTips() {
      if (typeof document === "undefined" || typeof window === "undefined" || !document.body) return () => {};
      const slot = "__dshTips:dsh-custom-models";
      if (typeof window[slot] === "function") window[slot]();
      let bubble = null;
      let current = null;
      let timer = null;
      const anchorOf = (node) => {
        const el = node && typeof node.closest === "function" ? node.closest("[title], [data-tip-held]") : null;
        return el && el.closest(TIP_SCOPE) ? el : null;
      };
      // The note, held aside at once: the browser's own bubble never starts.
      const holdText = (el) => {
        const live = el.getAttribute("title");
        if (live !== null) {
          el.setAttribute("data-tip-held", live);
          el.removeAttribute("title");
        }
        return el.getAttribute("data-tip-held") ?? "";
      };
      const ensure = () => {
        if (bubble) return bubble;
        bubble = document.createElement("div");
        bubble.setAttribute("role", "tooltip");
        Object.assign(bubble.style, {
          position: "fixed", zIndex: "1100", left: "0px", top: "0px", width: "max-content", boxSizing: "border-box",
          maxWidth: `min(${TIP_MAX_WIDTH}px, calc(100vw - ${TIP_MARGIN * 2}px))`, maxHeight: `calc(100vh - ${TIP_MARGIN * 2}px)`, overflow: "hidden",
          padding: "3px 7px", borderRadius: "var(--dsw-radius-sm, 6px)", background: "var(--dsw-alias-tooltip-bg, rgba(28, 30, 36, 0.94))",
          color: "var(--dsw-alias-tooltip-label, var(--dsw-static-neutral-bluish-00, #ffffff))", fontFamily: "var(--dsw-font-family, inherit)", fontSize: "13px", fontWeight: "400", lineHeight: "20px",
          letterSpacing: "normal", textAlign: "left", whiteSpace: "pre-line", overflowWrap: "break-word", pointerEvents: "none",
          visibility: "hidden", opacity: "0", transition: "opacity 150ms var(--ds-ease-in-out, ease-in-out)",
        });
        document.body.appendChild(bubble);
        return bubble;
      };
      const hide = () => {
        clearTimeout(timer);
        timer = null;
        if (bubble) {
          bubble.style.visibility = "hidden";
          bubble.style.opacity = "0";
        }
      };
      const release = () => {
        hide();
        const el = current;
        current = null;
        if (!el) return;
        const held = el.getAttribute("data-tip-held");
        el.removeAttribute("data-tip-held");
        if (held !== null && !el.hasAttribute("title")) el.setAttribute("title", held);
      };
      // Above the anchor, centred, kept within the window; below it when there is no room above.
      const show = () => {
        timer = null;
        const el = current;
        if (!el || !el.isConnected) return;
        const text = holdText(el).trim();
        if (!text) return;
        const node = ensure();
        // A date or a number range keeps together (2026-09-11 never breaks after "2026-"): a non-breaking hyphen between digits.
        node.textContent = text.replace(/(\d)-(?=\d)/g, "$1\u2011");
        node.style.visibility = "hidden";
        node.style.opacity = "0";
        node.style.left = "0px";
        node.style.top = "0px";
        const box = node.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        const left = Math.max(TIP_MARGIN, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - TIP_MARGIN - box.width));
        const above = rect.top - TIP_GAP - box.height;
        const top = above >= TIP_MARGIN ? above : Math.max(TIP_MARGIN, Math.min(rect.bottom + TIP_GAP, window.innerHeight - TIP_MARGIN - box.height));
        node.style.left = `${Math.round(left)}px`;
        node.style.top = `${Math.round(top)}px`;
        node.style.visibility = "visible";
        node.style.opacity = "1";
      };
      const hold = (el) => {
        if (el === current) return;
        release();
        current = el;
        holdText(el);
        timer = setTimeout(show, TIP_DELAY_MS);
      };
      const onOver = (event) => {
        const el = anchorOf(event.target);
        if (el) hold(el);
        else if (current) release();
      };
      const onOut = (event) => {
        if (current && !current.contains(event.relatedTarget)) release();
      };
      const onFocus = (event) => {
        const el = anchorOf(event.target);
        if (el && el === event.target && typeof el.matches === "function" && el.matches(":focus-visible")) hold(el);
      };
      const onBlur = (event) => {
        if (current && event.target === current) release();
      };
      const onKey = (event) => {
        if (event.key === "Escape") hide();
      };
      const listeners = [
        [document, "pointerover", onOver], [document, "pointerout", onOut], [document, "focusin", onFocus], [document, "focusout", onBlur],
        [document, "pointerdown", hide], [document, "keydown", onKey], [window, "scroll", release], [window, "blur", release],
      ];
      for (const [target, type, handler] of listeners) target.addEventListener(type, handler, true);
      const dispose = () => {
        release();
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
        bubble?.remove();
        bubble = null;
        if (window[slot] === dispose) delete window[slot];
      };
      window[slot] = dispose;
      return dispose;
    }

    async function apply(ctx) {
      installLocale(ctx);
      ctx.effect(() => installTips(), "dsh-custom-models: hover notes");
      const remote = ctx.remote;
      if (remote !== undefined && typeof remote.$mount === "function" && ctx.get("remote.customModels") === undefined) {
        const unmount = await remote.$mount({ package: "dsh-custom-models", descriptors });
        if (unmount !== undefined) ctx.effect(() => unmount, "dsh-custom-models: remote contribution");
      }
      call = async (method, request) => {
        const service = ctx.get("remote.customModels");
        if (service === undefined || typeof service[method] !== "function") throw new Error("remote.customModels is not mounted");
        const result = await service[method](request);
        if (result?.ok === true) return result.value;
        const code = typeof result?.error?.code === "string" ? ` (${result.error.code})` : "";
        throw new Error(`${String(result?.error?.message ?? "request failed")}${code}`);
      };
      const slots = ctx.slots;
      if (slots === undefined) return;
      // One tab, after dsh-cn-models' and dsh-intl-models' (41–48).
      ctx.effect(() => slots.inject("conversation.view", () => slots.register({
        name: "conversation.view",
        id: "custom-models",
        // After every vendor tab of dsh-cn-models (31…) and dsh-intl-models (41…53).
        order: 60,
        locale: NS,
        label: (t) => (typeof t === "function" ? t("tab.label") : "Custom"),
      }, View)), "dsh-custom-models: tab");
      ctx.effect(() => slots.inject("conversation.composer.dock", () => slots.register({
        name: "conversation.composer.dock",
        id: "custom-models-authn",
        order: 3,
        locale: NS,
      }, AuthnDock)), "dsh-custom-models: status bar");
      ctx.effect(() => slots.inject("settings.models.provider-card", () => slots.register({
        name: "settings.models.provider-card",
        key: SETTINGS_NS,
        locale: NS,
      }, ProviderCard)), "dsh-custom-models: models card");
    }

    exports.name = "dsh-custom-models";
    exports.apply = apply;
    exports.inject = ["remote", "slots", "locale"];
    /** Pure helpers, exposed for the self-test only. */
    exports.__internals = Object.freeze({
      duration, clock, amountText, compact, evidenceText, channelText, dockTipText, metricValue, lastProbeOf, AuthnDock, AuthnPage, statusInfo, balanceView, modelTags, siteCurrency, modelPayload, headersOf, headersText, suggestId, reordered, moved, moneyText, hitRate, niceTop, percentText, siteState, speedOf, CLIENT_VERSION, DICTS, METHODS,
      seed: (patch) => update(patch),
    });
    return module.exports;
  },
});
