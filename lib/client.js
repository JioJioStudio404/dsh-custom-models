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
 *  - one tab beside 对话 / 轨迹 (`conversation.view`), 自定义: one card per
 *    site — its keys on two lines each (the key, then its state, balance,
 *    today's use, use / ✓ / ↻ / edit / remove), its models, its settings —,
 *    the add-site dialog (DSH's own form: id, name, address, protocol, key,
 *    then "获取可用模型" and the models to add), and the switch groups (one
 *    picker entry each, its member chosen by hand);
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
    /** The settings namespace of the plugin's Models-page rows (the bundle patch's row id). */
    const SETTINGS_NS = "dsh-custom-models";
    /** The (local, cheap) status is re-read this often while the tab is open. */
    const STATUS_INTERVAL_MS = 15_000;
    /** Balances are re-read this often while the tab is open (free). */
    const CHECK_INTERVAL_MS = 5 * 60_000;
    const SITE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
    /** The protocols a site or model may be given: the ones DSH's own custom gateway serves. A Gemini site from before 0.2.0 only shows as such. */
    const PROTOCOLS = ["chat", "responses", "messages"];
    const PROTOCOL_NAMES = { chat: "OpenAI Chat Completions", responses: "OpenAI Responses", messages: "Anthropic Messages", gemini: "Google Gemini（已不支持，请在「国际模型」插件使用 Gemini，或给这个站点改用 OpenAI 兼容协议）" };
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
        "head.validateHint": "Each key: does the site accept it, and one tiny real request on the site's first model",
        "head.funds": "Refresh balances",
        "head.fundsing": "Refreshing…",
        "head.fundsHint": "Re-read the balances the sites show to a key (free); also when the tab opens, every 5 minutes and after each request",
        "empty": "No site yet: a relay, a gateway or a local server speaking OpenAI or Anthropic.",
        "site.switch": "On",
        "site.switchTitle": "Off: this site's models leave the model picker at the bottom (its keys and models are kept)",
        "site.models": "Models {count}",
        "site.modelsTitle": "The models this site offers in the picker",
        "site.edit": "Settings",
        "site.addKey": "Add key",
        "site.remove": "Remove site",
        "site.removeConfirm": "Remove the site and its keys?",
        "site.keyless": "No key needed",
        "site.noUsage": "No usage",
        "site.noUsageTitle": "This site's answers carry no token usage: DeepSeek Harness shows context use and speed from its own estimate, and today's usage counts requests only.",
        "site.keylessTitle": "A local server that takes no key: requests go out without one",
        "http.warn": "This is a public http address: no encryption. The API key and the whole conversation cross the internet in plain text, and anyone on the way (ISP, public Wi-Fi, a proxy) can read them and change the model's replies — tool calls included, which DSH runs on this computer. Use https whenever the site offers it.",
        "http.httpsWorks": "This site also answers over https.",
        "http.useHttps": "Use https",
        "http.confirm": "I know this site is not encrypted; use plain http for it",
        "http.confirmFirst": "Confirm the plain-http use above first",
        "http.publicTitle": "Not encrypted: the key and the conversation cross the internet in plain text",
        "http.privateTitle": "Plain http on this machine or a private network",
        "http.direct": "no HTTP_PROXY set: connects directly (HTTPS_PROXY does not apply to http)",
        "http.proxied": "goes through HTTP_PROXY / ALL_PROXY",
        "site.noKeys": "No key yet",
        "site.publicList": "Its model list answers any key: ✓ proves a key with one tiny request",
        "col.status": "Status",
        "col.balance": "Balance",
        "col.usage": "Today",
        "status.ok": "Available",
        "status.valid": "Key valid",
        "status.validHint": "The site accepts the key; ✓ sends one tiny request to prove a model answers",
        "status.unproven": "Not proven",
        "status.unprovenHint": "This site's model list answers any key: use ✓ (one tiny request)",
        "status.probed": "proven on {model} {time} ago",
        "status.probeError": "Last test request gave no verdict: {message}",
        "status.unknown": "Not checked",
        "status.no-balance": "No balance",
        "status.plan-quota": "Quota used up",
        "status.invalid": "Key invalid",
        "status.expired": "Expired",
        "status.error": "Check failed",
        "status.held": "Paused until {time}",
        "status.lastError": "Last check failed: {message}",
        "status.checked": "checked {time} ago",
        "status.never": "never checked",
        "status.manual": "Keys switch only by hand: use another key with 使用",
        "key.copy": "Copy the key",
        "key.copied": "Copied",
        "key.active": "In use",
        "key.switch": "Use",
        "key.validate": "Check the key with one tiny request",
        "key.funds": "Refresh the balance",
        "key.noFunds": "This site shows no balance to a key",
        "key.edit": "Rename",
        "key.remove": "Remove",
        "key.removeConfirm": "Confirm",
        "key.drag": "Drag to reorder (or ↑ ↓)",
        "balance.none": "—",
        "balance.credits": "{amount} credits",
        "balance.creditsTitle": "Hypercredits left ≈ {usd} (1 credit = $0.05)",
        "balance.unlimited": "Unlimited",
        "balance.used": "used {amount}",
        "balance.keyScope": "This key's own quota on the site (not the account balance)",
        "balance.accountEmpty": "The site refused a request: the account behind this key has no money (shown here is the key's own quota). Top up, then send a message or use ✓",
        "balance.expires": "expires {time}",
        "funds.failed": "Read failed",
        "usage.today": "{requests} req · {tokens}",
        "usage.none": "—",
        "usage.cost": "≈{cost}",
        "usage.month": "This month: {requests} requests, {tokens} tokens, ≈{cost}",
        "usage.quotaNote": "(in the site's own quota)",
        "dialog.addTitle": "Add a site",
        "dialog.editTitle": "Site settings — {name}",
        "dialog.id": "Provider ID",
        "dialog.idHint": "Lowercase first, then letters, digits and dashes; it names the route",
        "dialog.name": "Display name",
        "dialog.baseUrl": "API address",
        "dialog.protocol": "API protocol",
        "dialog.keys": "API key",
        "dialog.keysPlaceholder": "API key (several: one per line)",
        "dialog.keyless": "No key needed (a local server)",
        "dialog.advanced": "Advanced",
        "dialog.headers": "Request headers",
        "dialog.headersPlaceholder": "Name: value (one per line)",
        "dialog.defaultContext": "Default context (K tokens)",
        "dialog.defaultContextTitle": "The context of a model whose site states none and you have not edited (also when the reference lists a larger one). DeepSeek Harness compacts at about 80 % of it. Empty: {value}K, DeepSeek Harness's own default.",
        "dialog.imageBudget": "Image budget (MB)",
        "dialog.imageBudgetTitle": "All images of one request together (base64). Over it, DeepSeek Harness replaces the oldest with a note. Lower it for a site that refuses large requests (HTTP 413). Empty: {value} MB.",
        "dialog.imageMaxBytes": "Max per image (KB)",
        "dialog.imageMaxBytesTitle": "Each image is resized to this before sending. Empty: {value} KB.",
        "dialog.learned": "After a 413 the image budget was lowered to {size}",
        "dialog.learnedReset": "Restore",
        "dialog.catalog": "Model catalog",
        "dialog.fetch": "Fetch models",
        "dialog.fetching": "Fetching…",
        "dialog.fetchFirst": "Fetch models, or add a model id by hand",
        "dialog.found": "{platform} · {count} models",
        "dialog.keyRejected": "The site refused this key",
        "dialog.manual": "Model id",
        "dialog.manualAdd": "Add",
        "dialog.save": "Save",
        "dialog.saving": "Saving…",
        "dialog.cancel": "Cancel",
        "dialog.selected": "{count} chosen",
        "models.title": "Models — {name}",
        "models.added": "Added ({count})",
        "models.more": "More from the site",
        "models.addChosen": "Add {count}",
        "models.remove": "Remove",
        "models.edit": "Edit",
        "models.search": "Search",
        "models.all": "All",
        "models.none": "None",
        "models.close": "Close",
        "models.context": "{k}k",
        "models.contextM": "{m}M",
        "models.image": "Image",
        "models.ctxCapped": "The reference lists {listed}; the site states no context, so the site's default {applied} applies (edit the model to change it). Compaction at about {at}.",
        "models.ctxReference": "The site states no context: the reference's figure applies. Compaction at about {at}.",
        "models.ctxDefault": "Neither the site nor the reference knows this model's context: the site's default applies. Compaction at about {at}.",
        "models.ctxKnown": "Compaction at about {at}.",
        "models.thinking": "Thinking",
        "models.free": "Free",
        "models.price": "${input}/${output}",
        "models.quotaPrice": "quota {symbol}{input}/{symbol}{output}",
        "models.priceTitle": "Price per million tokens, input / output",
        "models.quotaPriceTitle": "Price per million tokens in the site's own quota (its ratios, default group)",
        "models.unusable": "Unavailable",
        "models.reference": "Described from the reference by its id",
        "models.manual": "No description known: defaults (edit it)",
        "edit.title": "Model — {id}",
        "edit.name": "Display name",
        "edit.protocol": "Protocol",
        "edit.protocolSite": "As the site ({protocol})",
        "edit.context": "Context (tokens)",
        "edit.output": "Max output (tokens)",
        "edit.image": "Image input",
        "edit.reasoning": "Reasoning levels",
        "edit.off": "Can switch thinking off",
        "edit.noReasoning": "No reasoning control",
        "edit.format": "Reasoning field",
        "edit.formatAuto": "As the site's platform",
        "edit.format.effort": "reasoning_effort",
        "edit.format.openrouter": "reasoning: { effort }",
        "edit.format.deepseek": "thinking: { type } (DeepSeek)",
        "edit.format.qwen": "enable_thinking (Qwen)",
        "edit.format.none": "Send none",
        "edit.replay": "Send reasoning back on every turn",
        "edit.reset": "Back to the site's description",
        "edit.save": "Save",
        "edit.cancel": "Cancel",
        "key.addTitle": "Add keys — {name}",
        "key.addPlaceholder": "One key per line",
        "key.label": "Name (optional)",
        "key.add": "Add",
        "key.adding": "Adding…",
        "key.renameTitle": "Rename {masked}",
        "groups.title": "Switch groups",
        "groups.titleHint": "One picker entry served by the member you choose; nothing switches by itself",
        "groups.add": "New group",
        "groups.empty": "None yet",
        "groups.edit": "Edit",
        "groups.remove": "Remove",
        "groups.removeConfirm": "Confirm",
        "groups.missing": "(model removed)",
        "groups.siteOff": "(site off)",
        "group.addTitle": "New switch group",
        "group.editTitle": "Switch group — {name}",
        "group.name": "Name in the picker",
        "group.members": "Members (the same model on different sites)",
        "group.save": "Save",
        "group.cancel": "Cancel",
        "group.pick": "Choose at least one site's model",
        "card.summary": "{count} keys · in use: {key} ({state})",
        "card.none": "No key on this site yet",
        "card.group": "{count} switch groups",
        "time.days": "{d}d {h}h",
        "time.hours": "{h}h {m}m",
        "time.minutes": "{m} min",
        "time.now": "under a minute",
        "error.generic": "Failed: {message}",
        "error.unavailable": "The plugin's host half is not loaded yet — restart the app once after installing.",
      },
      zh: {
        "tab.label": "自定义",
        "head.title": "自定义 API",
        "head.add": "添加站点",
        "head.validate": "验证全部",
        "head.validating": "验证中…",
        "head.validateHint": "逐个检测 Key：站点是否接受，并在站点的第一个模型上发一次极小的真实请求",
        "head.funds": "刷新余额",
        "head.fundsing": "刷新中…",
        "head.fundsHint": "重新读取站点向 Key 公开的余额（免费）；打开标签、每 5 分钟、每次请求后也会自动刷新",
        "empty": "还没有站点：中转站、聚合网关、本地服务（OpenAI / Anthropic 协议）都可以添加。",
        "site.switch": "启用",
        "site.switchTitle": "关闭后这个站点的模型不出现在底部模型选择栏（Key 和模型都保留）",
        "site.models": "模型 {count}",
        "site.modelsTitle": "这个站点在模型选择栏里提供的模型",
        "site.edit": "设置",
        "site.addKey": "添加 Key",
        "site.remove": "删除站点",
        "site.removeConfirm": "确认删除站点和它的 Key？",
        "site.keyless": "无需 Key",
        "site.noUsage": "不报用量",
        "site.noUsageTitle": "这个站点的回答里没有 token 用量：DeepSeek Harness 的上下文占用和速度按它自己的估算显示，今日用量只计请求数。",
        "site.keylessTitle": "本地服务不需要 Key：请求不带 Key 发出",
        "http.warn": "这是公网 http 地址，不加密。API Key 和整段对话都以明文经过互联网，途中的运营商、公共 Wi-Fi、代理都能看到，还能改写模型的回答——包括 DSH 会在本机执行的工具调用。站点支持 https 时请用 https。",
        "http.httpsWorks": "这个站点也能用 https 访问。",
        "http.useHttps": "改用 https",
        "http.confirm": "我知道这个站点不加密，仍用 http 连接",
        "http.confirmFirst": "先在上面确认使用不加密的 http",
        "http.publicTitle": "不加密：Key 与对话以明文经过互联网",
        "http.privateTitle": "本机或局域网内的 http",
        "http.direct": "未设置 HTTP_PROXY：直连（HTTPS_PROXY 对 http 不生效）",
        "http.proxied": "经 HTTP_PROXY / ALL_PROXY 代理",
        "site.noKeys": "还没有 Key",
        "site.publicList": "这个站点的模型列表不验证 Key：用 ✓ 发一次极小请求来证明 Key 可用",
        "col.status": "状态",
        "col.balance": "余额",
        "col.usage": "今日用量",
        "status.ok": "可用",
        "status.valid": "Key 有效",
        "status.validHint": "站点接受这个 Key；点 ✓ 发一次极小请求，确认模型能回答",
        "status.unproven": "未验证",
        "status.unprovenHint": "这个站点的模型列表不验证 Key：点 ✓（一次极小请求）",
        "status.probed": "{time}前在 {model} 上实测可用",
        "status.probeError": "上次测试请求没有结论：{message}",
        "status.unknown": "未检测",
        "status.no-balance": "余额不足",
        "status.plan-quota": "额度用尽",
        "status.invalid": "Key 无效",
        "status.expired": "已过期",
        "status.error": "检测失败",
        "status.held": "暂停至 {time}",
        "status.lastError": "上次检测失败：{message}",
        "status.checked": "{time}前检测",
        "status.never": "从未检测",
        "status.manual": "Key 只能手动切换：用其他 Key 请点「使用」",
        "key.copy": "复制 Key",
        "key.copied": "已复制",
        "key.active": "使用中",
        "key.switch": "使用",
        "key.validate": "检测 Key（一次极小请求）",
        "key.funds": "刷新余额",
        "key.noFunds": "这个站点不向 Key 公开余额",
        "key.edit": "重命名",
        "key.remove": "删除",
        "key.removeConfirm": "确认删除",
        "key.drag": "拖动排序（或 ↑ ↓）",
        "balance.none": "—",
        "balance.credits": "{amount} credits",
        "balance.creditsTitle": "剩余 Hypercredits ≈ {usd}（1 credit = $0.05）",
        "balance.unlimited": "无限额度",
        "balance.used": "已用 {amount}",
        "balance.keyScope": "这个 Key 在站点上的令牌额度（不是账户余额）",
        "balance.accountEmpty": "站点拒绝了请求：账户余额不足（这里显示的是这个 Key 的令牌额度）。充值后发一条消息或点 ✓ 即恢复",
        "balance.expires": "{time} 到期",
        "funds.failed": "读取失败",
        "usage.today": "{requests} 次 · {tokens}",
        "usage.none": "—",
        "usage.cost": "≈{cost}",
        "usage.month": "本月：{requests} 次，{tokens} tokens，≈{cost}",
        "usage.quotaNote": "（按站点额度计）",
        "dialog.addTitle": "添加站点",
        "dialog.editTitle": "站点设置 — {name}",
        "dialog.id": "Provider ID",
        "dialog.idHint": "以小写字母开头，只用小写字母、数字和连字符；用作线路名",
        "dialog.name": "显示名称",
        "dialog.baseUrl": "API 地址",
        "dialog.protocol": "API 协议",
        "dialog.keys": "API 密钥",
        "dialog.keysPlaceholder": "输入 API 密钥（多个时每行一个）",
        "dialog.keyless": "无需 Key（本地服务）",
        "dialog.advanced": "高级",
        "dialog.headers": "请求头",
        "dialog.headersPlaceholder": "名称: 值（每行一个）",
        "dialog.defaultContext": "默认上下文（K tokens）",
        "dialog.defaultContextTitle": "站点没有给出上下文、你也没改过的模型按这个值计（参考目录的数字更大时也按它计）。DeepSeek Harness 会在用到约 80% 时自动压缩。留空为 {value}K，与 DeepSeek Harness 自带的默认值相同。",
        "dialog.imageBudget": "图片总额度（MB）",
        "dialog.imageBudgetTitle": "一次请求里所有图片（base64）的上限。超过时 DeepSeek Harness 会把最早的图片换成文字说明。站点限制请求体大小（报 413）时调小。留空为 {value} MB。",
        "dialog.imageMaxBytes": "单张图片上限（KB）",
        "dialog.imageMaxBytesTitle": "每张图片发送前压缩到这个大小以内。留空为 {value} KB。",
        "dialog.learned": "遇到 413 后图片总额度已自动降到 {size}",
        "dialog.learnedReset": "恢复",
        "dialog.catalog": "模型目录",
        "dialog.fetch": "获取可用模型",
        "dialog.fetching": "获取中…",
        "dialog.fetchFirst": "点「获取可用模型」，或手动输入模型 ID",
        "dialog.found": "{platform} · {count} 个模型",
        "dialog.keyRejected": "站点不接受这个 Key",
        "dialog.manual": "模型 ID",
        "dialog.manualAdd": "添加",
        "dialog.save": "保存",
        "dialog.saving": "保存中…",
        "dialog.cancel": "取消",
        "dialog.selected": "已选 {count}",
        "models.title": "模型 — {name}",
        "models.added": "已添加（{count}）",
        "models.more": "站点上的其他模型",
        "models.addChosen": "添加 {count} 个",
        "models.remove": "移除",
        "models.edit": "编辑",
        "models.search": "搜索",
        "models.all": "全选",
        "models.none": "全不选",
        "models.close": "关闭",
        "models.context": "{k}k",
        "models.contextM": "{m}M",
        "models.image": "图片",
        "models.ctxCapped": "参考目录为 {listed}；站点没有给出上下文，按站点默认 {applied} 计（可在编辑模型里改）。约在 {at} 时自动压缩。",
        "models.ctxReference": "站点没有给出上下文，按参考目录计。约在 {at} 时自动压缩。",
        "models.ctxDefault": "站点和参考目录都没有这个模型的上下文，按站点默认计。约在 {at} 时自动压缩。",
        "models.ctxKnown": "约在 {at} 时自动压缩。",
        "models.thinking": "思考",
        "models.free": "免费",
        "models.price": "${input}/${output}",
        "models.quotaPrice": "额度 {symbol}{input}/{symbol}{output}",
        "models.priceTitle": "每百万 tokens 价格：输入 / 输出",
        "models.quotaPriceTitle": "每百万 tokens 的站点额度价（按站点倍率、默认分组）",
        "models.unusable": "不可用",
        "models.reference": "按模型 ID 从参考目录补全的信息",
        "models.manual": "没有找到这个模型的信息：使用默认值（可编辑）",
        "edit.title": "模型 — {id}",
        "edit.name": "显示名称",
        "edit.protocol": "协议",
        "edit.protocolSite": "跟随站点（{protocol}）",
        "edit.context": "上下文（tokens）",
        "edit.output": "最大输出（tokens）",
        "edit.image": "图片输入",
        "edit.reasoning": "推理档位",
        "edit.off": "可关闭思考",
        "edit.noReasoning": "不支持推理参数",
        "edit.format": "推理参数写法",
        "edit.formatAuto": "跟随站点平台",
        "edit.format.effort": "reasoning_effort",
        "edit.format.openrouter": "reasoning: { effort }",
        "edit.format.deepseek": "thinking: { type }（DeepSeek）",
        "edit.format.qwen": "enable_thinking（Qwen）",
        "edit.format.none": "不发送",
        "edit.replay": "每轮都回传思考内容",
        "edit.reset": "恢复站点给出的信息",
        "edit.save": "保存",
        "edit.cancel": "取消",
        "key.addTitle": "添加 Key — {name}",
        "key.addPlaceholder": "每行一个 Key",
        "key.label": "名称（可选）",
        "key.add": "添加",
        "key.adding": "添加中…",
        "key.renameTitle": "重命名 {masked}",
        "groups.title": "切换组",
        "groups.titleHint": "模型选择栏里的一个条目，由你选定的成员提供；不会自动切换",
        "groups.add": "新建切换组",
        "groups.empty": "还没有",
        "groups.edit": "编辑",
        "groups.remove": "删除",
        "groups.removeConfirm": "确认删除",
        "groups.missing": "（模型已移除）",
        "groups.siteOff": "（站点已关闭）",
        "group.addTitle": "新建切换组",
        "group.editTitle": "切换组 — {name}",
        "group.name": "模型选择栏中的名称",
        "group.members": "成员（同一个模型在不同站点）",
        "group.save": "保存",
        "group.cancel": "取消",
        "group.pick": "至少选择一个站点的模型",
        "card.summary": "{count} 个 Key · 使用中：{key}（{state}）",
        "card.none": "这个站点还没有 Key",
        "card.group": "{count} 个切换组",
        "time.days": "{d}天{h}小时",
        "time.hours": "{h}小时{m}分",
        "time.minutes": "{m}分钟",
        "time.now": "不到1分钟",
        "error.generic": "操作失败：{message}",
        "error.unavailable": "插件宿主端尚未加载——安装后请重启一次应用。",
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
          case "error": return t("status.error");
          default: return site?.modelsPublic ? t("status.unproven") : t("status.unknown");
        }
      })();
      const tone = key.status === "ok" ? (held ? "warn" : unproven || valid ? "neutral" : "ok") : key.status === "no-balance" || key.status === "invalid" || key.status === "expired" ? "bad" : key.status === "plan-quota" ? "warn" : "neutral";
      const parts = [label];
      if (key.statusMessage && key.status !== "ok") parts.push(key.statusMessage);
      if (unproven || (key.status === "unknown" && site?.modelsPublic)) parts.push(t("status.unprovenHint"));
      else if (valid) parts.push(t("status.validHint"));
      if (key.status === "ok" && !held && key.probedAt && key.probeModel) parts.push(t("status.probed", { model: key.probeModel, time: since(t, key.probedAt, now) }));
      if (key.probeError) parts.push(t("status.probeError", { message: key.probeError }));
      if (key.validityError && key.status !== "error") parts.push(t("status.lastError", { message: key.validityError }));
      if (key.quotaError) parts.push(`${t("funds.failed")}：${key.quotaError}`);
      if (["no-balance", "plan-quota", "invalid", "expired"].includes(key.status)) parts.push(t("status.manual"));
      parts.push(key.checkedAt ? t("status.checked", { time: since(t, key.checkedAt, now) }) : t("status.never"));
      return { tone, label, detail: parts.join(" · ") };
    }

    /** What a balance cell shows: the amount, a note beside it, its hover text. */
    function balanceView(t, balance) {
      if (!balance) return null;
      if (balance.currency === "credits") {
        return { amount: typeof balance.amount === "number" ? t("balance.credits", { amount: compact(balance.amount) }) : "—", note: null, title: typeof balance.usd === "number" ? t("balance.creditsTitle", { usd: usd(balance.usd) }) : undefined };
      }
      const currency = balance.currency ?? "USD";
      const used = typeof balance.used === "number" ? t("balance.used", { amount: amountText(balance.used, currency) }) : typeof balance.totalUsed === "number" ? t("balance.used", { amount: usd(balance.totalUsed) }) : null;
      const title = [balance.scope === "key" ? t("balance.keyScope") : null, balance.expiresAt ? t("balance.expires", { time: clock(balance.expiresAt) }) : null].filter(Boolean).join(" · ") || undefined;
      if (balance.unlimited) return { amount: t("balance.unlimited"), note: used, title };
      return { amount: typeof balance.amount === "number" ? amountText(balance.amount, currency) : "—", note: used, title, low: typeof balance.amount === "number" && balance.amount < (currency === "CNY" ? 5 : 1) && currency !== "tokens" };
    }

    /** The currency a site counts its quota in: a new-api site set to CNY converts at its own rate; else dollars. */
    function siteCurrency(platformInfo) {
      const rate = Number(platformInfo?.rate);
      return platformInfo?.display === "CNY" && rate > 0 ? { currency: "CNY", symbol: "¥", rate } : { currency: "USD", symbol: "$", rate: 1 };
    }

    /** Where a model's context came from (a reference figure is capped at the site's default) and where DSH compacts. */
    function contextTitle(t, model) {
      const at = model.compactAt ? contextText(t, model.compactAt) : "—";
      if (model.contextListed) return t("models.ctxCapped", { listed: contextText(t, model.contextListed), applied: contextText(t, model.context), at });
      if (model.contextOrigin === "reference") return t("models.ctxReference", { at });
      if (model.contextOrigin === "none") return t("models.ctxDefault", { at });
      return model.compactAt ? t("models.ctxKnown", { at }) : undefined;
    }

    /** A model's tags in a card: context, image, thinking, price (or 免费), where its description came from. */
    function modelTags(t, model, money = siteCurrency(null)) {
      const tags = [];
      if (model.context) tags.push({ key: "ctx", text: contextText(t, model.context), title: contextTitle(t, model) });
      if (model.image) tags.push({ key: "image", text: t("models.image") });
      if (model.reasoning) tags.push({ key: "thinking", text: t("models.thinking"), title: [...(model.reasoning.off ? ["off"] : []), ...(model.reasoning.levels ?? [])].join(" / ") });
      const cost = model.cost;
      if (cost && cost.input === 0 && cost.output === 0) tags.push({ key: "free", text: t("models.free"), tone: "free" });
      else if (cost) tags.push(cost.unit === "quota"
        ? { key: "price", text: t("models.quotaPrice", { symbol: money.symbol, input: priceText(cost.input * money.rate), output: priceText(cost.output * money.rate) }), title: t("models.quotaPriceTitle") }
        : { key: "price", text: t("models.price", { input: priceText(cost.input), output: priceText(cost.output) }), title: t("models.priceTitle") });
      if (model.protocol) tags.push({ key: "protocol", text: PROTOCOL_SHORT[model.protocol] ?? model.protocol });
      if (model.unusable) tags.push({ key: "unusable", text: t("models.unusable"), tone: "warn", title: model.unusable });
      return tags;
    }
    const tagNodes = (tags) => tags.map((tag) => h("span", { key: tag.key, className: "cx-model-tag", "data-tone": tag.tone, title: tag.title }, tag.text));

    /** A discovered model as the host takes it (no fields beyond the model's own). */
    function modelPayload(model) {
      const out = { id: model.id };
      for (const field of ["name", "protocol", "context", "contextFrom", "output", "image", "reasoning", "cost", "flags", "source"]) if (model[field] !== undefined && model[field] !== null) out[field] = model[field];
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
    ].filter(Boolean).join(" · ");

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
      for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
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
      return h("div", { className: "cx-funds", "data-stale": failed ? "true" : "false", title: accountEmpty ? [t("balance.accountEmpty"), view.title].filter(Boolean).join(" · ") : view.title },
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
      const dead = key.status === "invalid" || key.status === "expired";
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
     * The add-site dialog (DSH's own form) and, for a saved site, its settings.
     * A new site fetches its models here; a saved one manages them in its models dialog.
     */
    function SiteDialog({ t, status, site, onClose }) {
      const editing = Boolean(site);
      const taken = (status?.sites ?? []).map((item) => item.id);
      const [name, setName] = React.useState(site?.name ?? "");
      const [baseUrl, setBaseUrl] = React.useState(site?.baseUrl ?? "");
      const [id, setId] = React.useState("");
      const [idTouched, setIdTouched] = React.useState(false);
      const [protocol, setProtocol] = React.useState(PROTOCOLS.includes(site?.protocol) ? site.protocol : "chat");
      const [keys, setKeys] = React.useState("");
      const [keyless, setKeyless] = React.useState(site?.keyless === true);
      const limits = site?.limits ?? {};
      const defaults = limits.defaults ?? { defaultContext: 262144, imageBudget: 20971520, imageMaxBytes: 1048576 };
      const [advanced, setAdvanced] = React.useState(Boolean(site && (Object.keys(site.headers ?? {}).length || limits.defaultContext || limits.imageBudget || limits.imageMaxBytes || limits.imageBudgetLearned)));
      const [headers, setHeaders] = React.useState(headersText(site?.headers));
      // The site's limits, in the units shown (K tokens, MB, KB); empty is DSH's default.
      const [contextK, setContextK] = React.useState(limits.defaultContext ? String(Math.round(limits.defaultContext / 1024)) : "");
      const [budgetMb, setBudgetMb] = React.useState(limits.imageBudget ? String(Number((limits.imageBudget / 1048576).toFixed(1))) : "");
      const [imageKb, setImageKb] = React.useState(limits.imageMaxBytes ? String(Math.round(limits.imageMaxBytes / 1024)) : "");
      const [resetLearned, setResetLearned] = React.useState(false);
      const scaled = (text, unit) => {
        const value = Number(String(text).replace(/[,_\s]/g, ""));
        return String(text).trim() === "" || !(value > 0) ? null : Math.round(value * unit);
      };
      const [found, setFound] = React.useState(null);
      const [chosen, setChosen] = React.useState(new Set());
      const [manual, setManual] = React.useState("");
      const [extra, setExtra] = React.useState([]);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      // Public plain HTTP: confirmed per site; nothing is sent over it before that.
      const [allowHttp, setAllowHttp] = React.useState(site?.allowHttp === true);
      const publicHttp = isPublicHttp(baseUrl);
      const httpBlocked = publicHttp && !allowHttp;
      const httpFlag = publicHttp ? { allowHttp } : {};
      // A name without latin letters ("我的中转站") names nothing an id can carry: the address does.
      const autoId = suggestId(/[a-z]/i.test(name) ? name : baseUrl || name, taken);
      const siteId = idTouched ? id : autoId;
      const idBad = !editing && !SITE_ID_PATTERN.test(siteId);
      const useHttps = (address) => {
        setBaseUrl(address);
        setFound(null);
        setError(null);
      };
      const fetchModels = async () => {
        setBusy("fetch");
        setError(null);
        try {
          const value = await run("discoverModels", { baseUrl, protocol, ...httpFlag, ...(keys.trim() ? { key: keys.trim().split(/\r?\n/)[0] } : {}), ...(advanced ? { headers: headersOf(headers) } : {}) });
          const discovered = value?.discovered;
          setFound(discovered);
          // Unconfirmed public HTTP: the note above the button already asks; no error line too.
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
          await run("saveSite", {
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
          onClose();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(null);
        }
      };
      const listed = [...(found?.models ?? []).filter((model) => !model.added), ...extra];
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!busy) onClose(); },
        title: editing ? t("dialog.editTitle", { name: site.name }) : t("dialog.addTitle"),
        closeLabel: t("dialog.cancel"),
        className: editing ? "cx-modal" : "cx-modal cx-modal-wide",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          editing ? null : h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-site-id", title: t("dialog.idHint") }, t("dialog.id")),
            h("input", { id: "cx-site-id", className: "cx-text", value: siteId, placeholder: "acme-gateway", maxLength: 40, spellCheck: false, autoComplete: "off", "aria-invalid": idBad ? "true" : "false", title: t("dialog.idHint"), onChange: (event) => { setIdTouched(true); setId(event.target.value.toLowerCase()); } })),
          h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-site-name" }, t("dialog.name")),
            h("input", { id: "cx-site-name", className: "cx-text", value: name, maxLength: 60, placeholder: t("dialog.name"), "data-modal-autofocus": true, onChange: (event) => setName(event.target.value) })),
          h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-site-url" }, t("dialog.baseUrl")),
            h("input", { id: "cx-site-url", className: "cx-text", value: baseUrl, placeholder: "https://gateway.example/v1", maxLength: 500, spellCheck: false, autoComplete: "off", onChange: (event) => setBaseUrl(event.target.value) })),
          publicHttp ? h("div", { className: "cx-http-note", role: "note" },
            h("span", null, t("http.warn")),
            found?.httpsAlternative ? h("div", { className: "cx-inline" },
              h("span", null, t("http.httpsWorks")),
              h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", onClick: () => useHttps(found.httpsAlternative) }, t("http.useHttps"))) : null,
            h("label", { className: "cx-check" },
              h("input", { type: "checkbox", checked: allowHttp, onChange: (event) => setAllowHttp(event.target.checked) }),
              t("http.confirm"))) : null,
          h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-site-protocol" }, t("dialog.protocol")),
            h("select", { id: "cx-site-protocol", className: "cx-select", value: protocol, onChange: (event) => setProtocol(event.target.value) },
              PROTOCOLS.map((item) => h("option", { key: item, value: item }, PROTOCOL_NAMES[item])))),
          editing ? null : h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-site-keys" }, t("dialog.keys")),
            h("textarea", { id: "cx-site-keys", className: "cx-textarea", value: keys, placeholder: t("dialog.keysPlaceholder"), spellCheck: false, autoComplete: "off", disabled: keyless, onChange: (event) => setKeys(event.target.value) })),
          h("div", { className: "cx-inline" },
            h("label", { className: "cx-check", title: t("site.keylessTitle") }, h("input", { type: "checkbox", checked: keyless, onChange: (event) => setKeyless(event.target.checked) }), t("dialog.keyless")),
            h("span", { className: "cx-spacer" }),
            h("button", { type: "button", className: "cx-link", "aria-expanded": advanced ? "true" : "false", onClick: () => setAdvanced(!advanced) }, `${advanced ? "▾" : "▸"} ${t("dialog.advanced")}`)),
          advanced ? h("div", { className: "cx-field" },
            h("label", { htmlFor: "cx-site-headers" }, t("dialog.headers")),
            h("textarea", { id: "cx-site-headers", className: "cx-textarea", value: headers, placeholder: t("dialog.headersPlaceholder"), spellCheck: false, onChange: (event) => setHeaders(event.target.value) })) : null,
          advanced ? h("div", { className: "cx-row3" },
            h("div", { className: "cx-field" },
              h("label", { htmlFor: "cx-site-context", title: t("dialog.defaultContextTitle", { value: Math.round(defaults.defaultContext / 1024) }) }, t("dialog.defaultContext")),
              h("input", { id: "cx-site-context", className: "cx-text", value: contextK, inputMode: "numeric", placeholder: String(Math.round(defaults.defaultContext / 1024)), title: t("dialog.defaultContextTitle", { value: Math.round(defaults.defaultContext / 1024) }), onChange: (event) => setContextK(event.target.value) })),
            h("div", { className: "cx-field" },
              h("label", { htmlFor: "cx-site-image-budget", title: t("dialog.imageBudgetTitle", { value: Math.round(defaults.imageBudget / 1048576) }) }, t("dialog.imageBudget")),
              h("input", { id: "cx-site-image-budget", className: "cx-text", value: budgetMb, inputMode: "decimal", placeholder: String(Math.round(defaults.imageBudget / 1048576)), title: t("dialog.imageBudgetTitle", { value: Math.round(defaults.imageBudget / 1048576) }), onChange: (event) => setBudgetMb(event.target.value) })),
            h("div", { className: "cx-field" },
              h("label", { htmlFor: "cx-site-image-max", title: t("dialog.imageMaxBytesTitle", { value: Math.round(defaults.imageMaxBytes / 1024) }) }, t("dialog.imageMaxBytes")),
              h("input", { id: "cx-site-image-max", className: "cx-text", value: imageKb, inputMode: "numeric", placeholder: String(Math.round(defaults.imageMaxBytes / 1024)), title: t("dialog.imageMaxBytesTitle", { value: Math.round(defaults.imageMaxBytes / 1024) }), onChange: (event) => setImageKb(event.target.value) }))) : null,
          advanced && limits.imageBudgetLearned && !resetLearned ? h("div", { className: "cx-inline cx-muted" },
            h("span", null, t("dialog.learned", { size: `${(limits.imageBudgetLearned / 1048576).toFixed(1)} MB` })),
            h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", onClick: () => setResetLearned(true) }, t("dialog.learnedReset"))) : null,
          editing ? null : h("div", { className: "cx-catalog" },
            h("div", { className: "cx-inline" },
              h("span", { className: "cx-subtitle" }, t("dialog.catalog")),
              found?.ok ? h("span", { className: "cx-muted" }, t("dialog.found", { platform: found.platformInfo?.name ?? platformName(found.platform), count: found.models.length })) : null,
              found?.ok && found.keyAccepted === false ? h("span", { className: "cx-error" }, t("dialog.keyRejected")) : null,
              h("span", { className: "cx-spacer" }),
              h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), disabled: busy !== null || !baseUrl.trim(), onClick: () => void fetchModels() }, busy === "fetch" ? t("dialog.fetching") : t("dialog.fetch"))),
            listed.length ? h(ModelChooser, { t, models: listed, money: siteCurrency(found?.platformInfo), chosen, onChange: setChosen }) : h("div", { className: "cx-placeholder" }, t("dialog.fetchFirst")),
            h("div", { className: "cx-inline" },
              h("input", { className: "cx-text", style: { flex: 1 }, value: manual, placeholder: t("dialog.manual"), "aria-label": t("dialog.manual"), maxLength: 200, spellCheck: false, onChange: (event) => setManual(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") addManual(); } }),
              h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: !manual.trim(), onClick: addManual }, t("dialog.manualAdd")))),
          errorLine(t, error)),
        footer: h(React.Fragment, null,
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy !== null, onClick: onClose }, t("dialog.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy !== null || !baseUrl.trim() || idBad || httpBlocked, title: httpBlocked ? t("http.confirmFirst") : undefined, onClick: () => void save() }, busy === "save" ? t("dialog.saving") : t("dialog.save"))),
      });
    }

    const PLATFORM_NAMES = { generic: "OpenAI 兼容", newapi: "new-api", hyper: "Charm Hyper", vercel: "Vercel AI Gateway", openrouter: "OpenRouter" };
    const platformName = (platform) => PLATFORM_NAMES[platform] ?? platform;

    /** A saved site's models: the added ones (edit, remove), and the site's others to add. */
    function SiteModelsDialog({ t, site, onClose, onEditModel }) {
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
      const more = (found?.models ?? []).filter((model) => !site.models.some((added) => added.id === model.id));
      const addChosen = () => act("add", "addModels", { siteId: site.id, models: more.filter((model) => chosen.has(model.id)).map(modelPayload) }, () => setChosen(new Set()));
      const addManual = () => {
        const id = manual.trim();
        if (!id) return;
        void act("manual", "addModels", { siteId: site.id, models: [{ id, source: "manual" }] }, () => setManual(""));
      };
      return h(P.Modal, {
        open: true,
        onClose: () => { if (!busy) onClose(); },
        title: t("models.title", { name: site.name }),
        closeLabel: t("models.close"),
        className: "cx-modal cx-modal-xl",
        contentClassName: "cx-modal-content",
        children: h("div", { className: "cx-dialog" },
          h("div", { className: "cx-inline" }, h("span", { className: "cx-subtitle" }, t("models.added", { count: site.models.length }))),
          site.models.length ? h("div", { className: "cx-model-grid" }, site.models.map((model) => h(ModelCard, {
            key: model.id,
            t,
            model,
            money: siteCurrency(site.platformInfo),
            onEdit: () => onEditModel(model),
            onRemove: () => void act("remove", "removeModels", { siteId: site.id, modelIds: [model.id] }),
          }))) : h("div", { className: "cx-placeholder" }, t("dialog.fetchFirst")),
          h("div", { className: "cx-catalog" },
            h("div", { className: "cx-inline" },
              h("span", { className: "cx-subtitle" }, t("models.more")),
              found?.ok ? h("span", { className: "cx-muted" }, t("dialog.found", { platform: found.platformInfo?.name ?? platformName(found.platform), count: found.models.length })) : null,
              h("span", { className: "cx-spacer" }),
              chosen.size ? h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy !== null, onClick: () => void addChosen() }, t("models.addChosen", { count: chosen.size })) : null,
              h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), disabled: busy !== null, onClick: () => void act("fetch", "discoverModels", { siteId: site.id }, (value) => { setFound(value?.discovered); if (!value?.discovered?.ok) setError(value?.discovered?.error ?? "—"); }) }, busy === "fetch" ? t("dialog.fetching") : t("dialog.fetch"))),
            more.length ? h(ModelChooser, { t, models: more, money: siteCurrency(found?.platformInfo ?? site.platformInfo), chosen, onChange: setChosen }) : null,
            h("div", { className: "cx-inline" },
              h("input", { className: "cx-text", style: { flex: 1 }, value: manual, placeholder: t("dialog.manual"), "aria-label": t("dialog.manual"), maxLength: 200, spellCheck: false, onChange: (event) => setManual(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") addManual(); } }),
              h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: !manual.trim() || busy !== null, onClick: addManual }, t("dialog.manualAdd")))),
          errorLine(t, error)),
        footer: h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy !== null, onClick: onClose }, t("models.close")),
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
        };
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
              PROTOCOLS.map((item) => h("option", { key: item, value: item }, PROTOCOL_NAMES[item])))),
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
          errorLine(t, error)),
        footer: h(React.Fragment, null,
          h("button", { type: "button", className: "cx-link", disabled: busy, onClick: () => void save({ name: null, protocol: null, context: null, output: null, image: null, reasoning: null, flags: null }) }, t("edit.reset")),
          h("span", { className: "cx-spacer" }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", disabled: busy, onClick: onClose }, t("edit.cancel")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", disabled: busy || (thinks && levels.size === 0 && !off), onClick: () => void save(patch()) }, t("edit.save"))),
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
          const view = (value?.added ?? []).map((item) => ({ tone: item.status === "ok" ? "ok" : item.status === "invalid" || item.status === "expired" ? "error" : "warn", text: `${item.masked} · ${t(`status.${item.status}`) === `status.${item.status}` ? item.status : t(`status.${item.status}`)}${item.statusMessage ? ` · ${item.statusMessage}` : ""}${item.probeError ? ` · ${item.probeError}` : ""}` }));
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

    function GroupsSection({ t, status, onEdit, onAdd }) {
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
      return h("section", { className: "cx-section", "aria-label": t("groups.title") },
        h("div", { className: "cx-section-head" },
          h("span", { className: "cx-section-name", title: t("groups.titleHint") }, t("groups.title")),
          h("span", { className: "cx-spacer" }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "ghost", onClick: onAdd }, t("groups.add"))),
        groups.length === 0 ? h("div", { className: "cx-note cx-muted" }, t("groups.empty")) : groups.map((group) => h("div", { key: group.id, className: "cx-group" },
          h("div", { className: "cx-group-head" },
            h("span", { className: "cx-section-name" }, group.name),
            h("span", { className: "cx-spacer" }),
            h("button", { type: "button", className: "cx-icon", title: t("groups.edit"), "aria-label": t("groups.edit"), onClick: () => onEdit(group) }, h(PenIcon)),
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
              h("span", null, `${site?.name ?? member.site} · ${member.model}${missing ? ` ${t("groups.missing")}` : off ? ` ${t("groups.siteOff")}` : ""}`));
          })))),
        errorLine(t, error));
    }

    function SiteSection({ t, site, keys, drag, onEdit, onModels, onAddKey, onRename }) {
      const [confirming, setConfirming] = React.useState(false);
      const [error, setError] = React.useState(null);
      const remove = async () => {
        if (!confirming) {
          setConfirming(true);
          setTimeout(() => setConfirming(false), 4000);
          return;
        }
        try {
          await run("removeSite", { siteId: site.id });
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
      return h("section", { className: "cx-section", "aria-label": site.name, "data-funds": site.showsBalance ? "true" : "false", "data-off": site.enabled === false ? "true" : "false" },
        h("div", { className: "cx-section-head" },
          h("span", { title: t("site.switchTitle"), style: { display: "inline-flex" } }, h(P.Switch, { checked: site.enabled !== false, label: t("site.switch"), title: t("site.switchTitle"), onChange: (next) => void toggle(next) })),
          h("span", { className: "cx-section-name" }, site.name),
          h("span", { className: "cx-muted", title: site.baseUrl }, site.host),
          h("span", { className: "cx-tag", "data-tone": PROTOCOLS.includes(site.protocol) ? undefined : "warn", title: PROTOCOL_NAMES[site.protocol] }, PROTOCOL_SHORT[site.protocol] ?? site.protocol),
          site.platform !== "generic" ? h("span", { className: "cx-tag", title: site.platformInfo?.name ?? undefined }, site.platformName) : null,
          site.keyless ? h("span", { className: "cx-tag", title: t("site.keylessTitle") }, t("site.keyless")) : null,
          site.plainHttp ? h("span", { className: "cx-tag", "data-tone": site.publicHttp ? "warn" : undefined, title: httpTitle(t, site) }, "http") : null,
          site.usageReported === false ? h("span", { className: "cx-tag", "data-tone": "warn", title: t("site.noUsageTitle") }, t("site.noUsage")) : null,
          h("span", { className: "cx-spacer" }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "ghost", title: t("site.modelsTitle"), onClick: onModels }, t("site.models", { count: site.models.length })),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "ghost", onClick: onAddKey }, t("site.addKey")),
          h("button", { type: "button", className: "cx-icon", title: t("site.edit"), "aria-label": t("site.edit"), onClick: onEdit }, h(PenIcon)),
          h("button", { type: "button", className: "cx-icon", "data-confirm": confirming ? "true" : "false", title: confirming ? t("site.removeConfirm") : t("site.remove"), "aria-label": t("site.remove"), onClick: () => void remove() }, confirming ? t("key.removeConfirm") : h(TrashIcon))),
        keys.length ? h(React.Fragment, null,
          h("div", { className: "cx-grid cx-thead", "aria-hidden": true },
            h("span", null, t("col.status")),
            site.showsBalance ? h("span", null, t("col.balance")) : null,
            h("span", null, t("col.usage")),
            h("span", null, "")),
          h("ul", { className: "cx-keys" }, keys.map((key) => h(KeyRow, { key: key.id, t, keyInfo: key, site, drag: drag(site.id, keys, key), onRename }))))
          : h("div", { className: "cx-note cx-muted" }, site.keyless ? t("site.keylessTitle") : t("site.noKeys")),
        errorLine(t, error));
    }

    /** The tab: the sites (each with its keys), the switch groups, and their dialogs. */
    function CustomPanel({ t }) {
      useWatch();
      const state = useStore();
      const status = state.status;
      const [dialog, setDialog] = React.useState(null);
      const [dragging, setDragging] = React.useState(null);
      const [dropAt, setDropAt] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [error, setError] = React.useState(null);
      const sites = status?.sites ?? [];
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
      const keyCount = status?.keys?.length ?? 0;
      const siteOf = (id) => sites.find((site) => site.id === id);
      const close = () => setDialog(null);
      const open = dialog?.kind;
      const dialogSite = dialog?.site ? siteOf(dialog.site) : null;
      return h("div", { className: "cx-root" },
        h("div", { className: "cx-head" },
          h("span", { className: "cx-title" }, t("head.title")),
          h("span", { className: "cx-spacer" }),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(ShieldIcon), title: t("head.validateHint"), disabled: Boolean(state.checking) || keyCount === 0, onClick: () => void checkAll({ mode: "validity", deep: true }) }, state.checking === "validity" ? t("head.validating") : t("head.validate")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "outline", icon: h(P.IconRefreshOutlineRegular, { size: 14 }), title: t("head.fundsHint"), disabled: Boolean(state.checking) || !(status?.keys ?? []).some((key) => key.funds), onClick: () => void checkAll({ mode: "funds" }) }, state.checking === "funds" ? t("head.fundsing") : t("head.funds")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", onClick: () => setDialog({ kind: "site" }) }, t("head.add"))),
        error ? errorLine(t, error) : null,
        state.error ? h("div", { className: "cx-error", role: "alert" }, unavailableError(state.error) ? t("error.unavailable") : t("error.generic", { message: state.error })) : null,
        status !== null && sites.length === 0 ? h("div", { className: "cx-empty" },
          h("span", null, t("empty")),
          h(P.Button, { className: "cx-btn", size: "sm", variant: "primary", onClick: () => setDialog({ kind: "site" }) }, t("head.add"))) : null,
        sites.map((site) => h(SiteSection, {
          key: site.id,
          t,
          site,
          keys: keysOf(site.id),
          drag,
          onEdit: () => setDialog({ kind: "site", site: site.id }),
          onModels: () => setDialog({ kind: "models", site: site.id }),
          onAddKey: () => setDialog({ kind: "keys", site: site.id }),
          onRename: (key) => setDialog({ kind: "rename", key: key.id }),
        })),
        sites.some((site) => site.models.length) ? h(GroupsSection, { t, status, onAdd: () => setDialog({ kind: "group" }), onEdit: (group) => setDialog({ kind: "group", group: group.id }) }) : null,
        open === "site" ? h(SiteDialog, { t, status, site: dialogSite, onClose: close }) : null,
        open === "models" && dialogSite ? h(SiteModelsDialog, { t, site: dialogSite, onClose: close, onEditModel: (model) => setDialog({ kind: "model", site: dialogSite.id, model: model.id, back: "models" }) }) : null,
        open === "model" && dialogSite ? (() => {
          const model = dialogSite.models.find((item) => item.id === dialog.model);
          return model ? h(ModelEditDialog, { t, site: dialogSite, model, onClose: () => setDialog({ kind: "models", site: dialogSite.id }) }) : null;
        })() : null,
        open === "keys" && dialogSite ? h(AddKeysDialog, { t, site: dialogSite, onClose: close }) : null,
        open === "rename" ? (() => {
          const key = status?.keys?.find((item) => item.id === dialog.key);
          return key ? h(RenameKeyDialog, { t, keyInfo: key, onClose: close }) : null;
        })() : null,
        open === "group" ? h(GroupDialog, { t, status, group: dialog.group ? status?.groups?.find((group) => group.id === dialog.group) : null, onClose: close }) : null);
    }

    const View = (props) => h("div", { className: "cx-view" }, h(CustomPanel, props));
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

    // ------------------------------------------------------------------ apply

    const METHODS = ["status", "discoverModels", "saveSite", "removeSite", "reorderSites", "setSiteEnabled", "addModels", "removeModels", "updateModel", "addKeys", "updateKey", "removeKey", "switchKey", "reorderKeys", "checkKeys", "saveGroup", "removeGroup", "switchGroup"];
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

    async function apply(ctx) {
      installLocale(ctx);
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
        order: 49,
        locale: NS,
        label: (t) => (typeof t === "function" ? t("tab.label") : "自定义"),
      }, View)), "dsh-custom-models: tab");
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
      duration, clock, amountText, compact, statusInfo, balanceView, modelTags, siteCurrency, modelPayload, headersOf, headersText, suggestId, reordered, moved, DICTS, METHODS,
      seed: (patch) => update(patch),
    });
    return module.exports;
  },
});
