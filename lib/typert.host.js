/**
 * Typert manifest for the `customModels` Remote namespace.
 *
 * Hand-written in the shape `dsh-typert-generator` emits, so `typert-loader`
 * registers it when this package's loader row mounts. Every request codec is
 * strict: unknown fields and wrong types are rejected at the wire boundary
 * (a throw becomes `gateway/input-invalid`). The loader validates this file
 * during its activation pass and a defect would fail it for every plugin, so
 * `test/verify.mjs` runs a port of that validation.
 *
 * @module dsh-custom-models/typert
 */

const PACKAGE = "dsh-custom-models";
/** The protocols a request may set: the ones DSH's own custom gateway serves (Gemini went to dsh-intl-models in 0.2.0). */
const PROTOCOLS = ["chat", "responses", "messages"];
const PLATFORMS = ["generic", "newapi", "hyper", "vercel", "openrouter"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_FORMATS = ["effort", "openrouter", "deepseek", "qwen", "none"];

function object(value, subject) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${subject} must be an object`);
  return value;
}

function only(value, allowed, subject) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${subject} has an unexpected field ${JSON.stringify(key)}`);
}

function text(value, key, subject, { required = false, max = 4096, nullable = false } = {}) {
  if (value[key] === undefined && !required) return undefined;
  if (value[key] === null && nullable) return null;
  if (typeof value[key] !== "string" || (required && value[key].length === 0) || value[key].length > max) {
    throw new TypeError(`${subject}.${key} must be a ${required ? "non-empty " : ""}string of at most ${max} characters${nullable ? " or null" : ""}`);
  }
  return value[key];
}

function oneOf(value, key, subject, options, { required = false, nullable = false } = {}) {
  if (value[key] === undefined && !required) return undefined;
  if (value[key] === null && nullable) return null;
  if (!options.includes(value[key])) throw new TypeError(`${subject}.${key} must be one of ${options.join(", ")}${nullable ? " or null" : ""}`);
  return value[key];
}

function flag(value, key, subject, { nullable = false } = {}) {
  if (value[key] === undefined) return undefined;
  if (value[key] === null && nullable) return null;
  if (typeof value[key] !== "boolean") throw new TypeError(`${subject}.${key} must be a boolean`);
  return value[key];
}

function number(value, key, subject, { min = 0, max = 1e12, integer = false, nullable = false, required = false } = {}) {
  if (value[key] === undefined && !required) return undefined;
  if (value[key] === null && nullable) return null;
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item) || item < min || item > max || (integer && !Number.isInteger(item))) throw new TypeError(`${subject}.${key} must be a ${integer ? "whole " : ""}number from ${min} to ${max}`);
  return item;
}

function ids(value, key, subject, { required = false, max = 500 } = {}) {
  if (value[key] === undefined && !required) return undefined;
  if (!Array.isArray(value[key]) || value[key].length > max || value[key].some((item) => typeof item !== "string" || item.length === 0 || item.length > 200)) {
    throw new TypeError(`${subject}.${key} must be an array of ids`);
  }
  return value[key];
}

/** A small map of strings (request headers, a level map). */
function strings(value, key, subject, { maxEntries = 20, maxLength = 512, nullable = false } = {}) {
  if (value[key] === undefined) return undefined;
  if (value[key] === null && nullable) return null;
  const map = object(value[key], `${subject}.${key}`);
  const entries = Object.entries(map);
  if (entries.length > maxEntries) throw new TypeError(`${subject}.${key} has more than ${maxEntries} entries`);
  for (const [name, item] of entries) {
    if (name.length === 0 || name.length > 64 || typeof item !== "string" || item.length > maxLength) throw new TypeError(`${subject}.${key}.${name} must be a string of at most ${maxLength} characters`);
  }
  return map;
}

function reasoning(value, key, subject, { nullable = false } = {}) {
  if (value[key] === undefined) return undefined;
  if (value[key] === null && nullable) return null;
  if (value[key] === false) return false;
  const item = object(value[key], `${subject}.${key}`);
  only(item, ["levels", "off", "map"], `${subject}.${key}`);
  if (!Array.isArray(item.levels) || item.levels.some((level) => !EFFORTS.includes(level))) throw new TypeError(`${subject}.${key}.levels must list effort levels`);
  flag(item, "off", `${subject}.${key}`);
  strings(item, "map", `${subject}.${key}`, { maxEntries: 8, maxLength: 40 });
  return item;
}

function cost(value, key, subject, { nullable = false } = {}) {
  if (value[key] === undefined) return undefined;
  if (value[key] === null && nullable) return null;
  const item = object(value[key], `${subject}.${key}`);
  only(item, ["input", "output", "cacheRead", "cacheWrite", "unit"], `${subject}.${key}`);
  number(item, "input", `${subject}.${key}`, { required: true });
  number(item, "output", `${subject}.${key}`, { required: true });
  number(item, "cacheRead", `${subject}.${key}`);
  number(item, "cacheWrite", `${subject}.${key}`);
  text(item, "unit", `${subject}.${key}`, { max: 20 });
  return item;
}

function flags(value, key, subject, { nullable = false } = {}) {
  if (value[key] === undefined) return undefined;
  if (value[key] === null && nullable) return null;
  const item = object(value[key], `${subject}.${key}`);
  only(item, ["thinkingFormat", "reasoningOnAssistant", "noTemperature", "adaptive", "maxTokensField"], `${subject}.${key}`);
  oneOf(item, "thinkingFormat", `${subject}.${key}`, THINKING_FORMATS);
  for (const name of ["reasoningOnAssistant", "noTemperature", "adaptive"]) flag(item, name, `${subject}.${key}`);
  oneOf(item, "maxTokensField", `${subject}.${key}`, ["max_tokens", "max_completion_tokens"]);
  return item;
}

const MODEL_FIELDS = ["name", "protocol", "context", "output", "image", "reasoning", "cost", "flags"];

/** One model as discovered and chosen (or typed in). */
function model(value, subject) {
  const item = object(value, subject);
  only(item, ["id", ...MODEL_FIELDS, "source"], subject);
  text(item, "id", subject, { required: true, max: 200 });
  text(item, "name", subject, { max: 120 });
  oneOf(item, "protocol", subject, PROTOCOLS);
  number(item, "context", subject, { min: 1, integer: true });
  number(item, "output", subject, { min: 1, integer: true });
  flag(item, "image", subject);
  reasoning(item, "reasoning", subject);
  cost(item, "cost", subject);
  flags(item, "flags", subject);
  oneOf(item, "source", subject, ["site", "reference", "manual"]);
  return item;
}

function models(value, key, subject, { required = false } = {}) {
  if (value[key] === undefined && !required) return undefined;
  if (!Array.isArray(value[key]) || value[key].length > 300) throw new TypeError(`${subject}.${key} must be an array of at most 300 models`);
  return value[key].map((item, index) => model(item, `${subject}.${key}[${index}]`));
}

/** A model's edit: any model field, `null` to clear it. */
function modelPatch(value, key, subject) {
  const item = object(value[key], `${subject}.${key}`);
  only(item, MODEL_FIELDS, `${subject}.${key}`);
  const where = `${subject}.${key}`;
  text(item, "name", where, { max: 120, nullable: true });
  oneOf(item, "protocol", where, PROTOCOLS, { nullable: true });
  number(item, "context", where, { min: 1, integer: true, nullable: true });
  number(item, "output", where, { min: 1, integer: true, nullable: true });
  flag(item, "image", where, { nullable: true });
  reasoning(item, "reasoning", where, { nullable: true });
  cost(item, "cost", where, { nullable: true });
  flags(item, "flags", where, { nullable: true });
  return item;
}

function detected(value, key, subject) {
  if (value[key] === undefined) return undefined;
  const item = object(value[key], `${subject}.${key}`);
  only(item, ["platform", "platformInfo", "modelsPublic"], `${subject}.${key}`);
  oneOf(item, "platform", `${subject}.${key}`, PLATFORMS, { required: true });
  flag(item, "modelsPublic", `${subject}.${key}`);
  if (item.platformInfo !== undefined && item.platformInfo !== null) {
    const info = object(item.platformInfo, `${subject}.${key}.platformInfo`);
    only(info, ["name", "quotaPerUnit", "display", "rate"], `${subject}.${key}.platformInfo`);
    text(info, "name", `${subject}.${key}.platformInfo`, { max: 120, nullable: true });
    number(info, "quotaPerUnit", `${subject}.${key}.platformInfo`, { min: 1, nullable: true });
    oneOf(info, "display", `${subject}.${key}.platformInfo`, ["USD", "CNY", "TOKENS"], { nullable: true });
    number(info, "rate", `${subject}.${key}.platformInfo`, { min: 0, nullable: true });
  }
  return item;
}

function members(value, key, subject) {
  if (!Array.isArray(value[key]) || value[key].length === 0 || value[key].length > 20) throw new TypeError(`${subject}.${key} must list 1 to 20 members`);
  return value[key].map((member, index) => {
    const where = `${subject}.${key}[${index}]`;
    const item = object(member, where);
    only(item, ["site", "model"], where);
    return { site: text(item, "site", where, { required: true, max: 40 }), model: text(item, "model", where, { required: true, max: 200 }) };
  });
}

/** Drop undefined fields so the handler sees exactly what was sent. */
const defined = (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

/** One strict codec over a parse function. */
const codec = (type, parse) => ({ mode: "strict", typeSymbol: `${PACKAGE}/types#${type}`, create: () => ({ parse }) });

/** A request with exactly these fields. */
const shape = (type, method, read) => codec(type, (value) => {
  const subject = `customModels.${method} request`;
  const request = object(value, subject);
  return read(request, subject);
});

const CODECS = {
  status: shape("StatusRequest", "status", (request, subject) => {
    only(request, [], subject);
    return {};
  }),
  discoverModels: shape("DiscoverModelsRequest", "discoverModels", (request, subject) => {
    only(request, ["siteId", "baseUrl", "protocol", "key", "headers", "allowHttp"], subject);
    return defined({
      siteId: text(request, "siteId", subject, { max: 40 }),
      baseUrl: text(request, "baseUrl", subject, { max: 500 }),
      protocol: oneOf(request, "protocol", subject, PROTOCOLS),
      key: text(request, "key", subject, { max: 4096 }),
      headers: strings(request, "headers", subject),
      allowHttp: flag(request, "allowHttp", subject),
    });
  }),
  saveSite: shape("SaveSiteRequest", "saveSite", (request, subject) => {
    only(request, ["id", "newId", "name", "baseUrl", "protocol", "headers", "keyless", "allowHttp", "keys", "models", "detected"], subject);
    return defined({
      id: text(request, "id", subject, { max: 40 }),
      newId: text(request, "newId", subject, { max: 40 }),
      name: text(request, "name", subject, { max: 60 }),
      baseUrl: text(request, "baseUrl", subject, { max: 500 }),
      protocol: oneOf(request, "protocol", subject, PROTOCOLS),
      headers: strings(request, "headers", subject),
      keyless: flag(request, "keyless", subject),
      allowHttp: flag(request, "allowHttp", subject),
      keys: text(request, "keys", subject, { max: 64 * 1024 }),
      models: models(request, "models", subject),
      detected: detected(request, "detected", subject),
    });
  }),
  removeSite: shape("RemoveSiteRequest", "removeSite", (request, subject) => {
    only(request, ["siteId"], subject);
    return { siteId: text(request, "siteId", subject, { required: true, max: 40 }) };
  }),
  reorderSites: shape("ReorderSitesRequest", "reorderSites", (request, subject) => {
    only(request, ["siteIds"], subject);
    return { siteIds: ids(request, "siteIds", subject, { required: true }) };
  }),
  setSiteEnabled: shape("SetSiteEnabledRequest", "setSiteEnabled", (request, subject) => {
    only(request, ["siteId", "enabled"], subject);
    const enabled = flag(request, "enabled", subject);
    if (enabled === undefined) throw new TypeError(`${subject}.enabled must be a boolean`);
    return { siteId: text(request, "siteId", subject, { required: true, max: 40 }), enabled };
  }),
  addModels: shape("AddModelsRequest", "addModels", (request, subject) => {
    only(request, ["siteId", "models"], subject);
    return { siteId: text(request, "siteId", subject, { required: true, max: 40 }), models: models(request, "models", subject, { required: true }) };
  }),
  removeModels: shape("RemoveModelsRequest", "removeModels", (request, subject) => {
    only(request, ["siteId", "modelIds"], subject);
    return { siteId: text(request, "siteId", subject, { required: true, max: 40 }), modelIds: ids(request, "modelIds", subject, { required: true }) };
  }),
  updateModel: shape("UpdateModelRequest", "updateModel", (request, subject) => {
    only(request, ["siteId", "modelId", "patch"], subject);
    return { siteId: text(request, "siteId", subject, { required: true, max: 40 }), modelId: text(request, "modelId", subject, { required: true, max: 200 }), patch: modelPatch(request, "patch", subject) };
  }),
  addKeys: shape("AddKeysRequest", "addKeys", (request, subject) => {
    only(request, ["siteId", "text", "label"], subject);
    return defined({ siteId: text(request, "siteId", subject, { required: true, max: 40 }), text: text(request, "text", subject, { required: true, max: 64 * 1024 }), label: text(request, "label", subject, { max: 60 }) });
  }),
  updateKey: shape("UpdateKeyRequest", "updateKey", (request, subject) => {
    only(request, ["keyId", "label"], subject);
    return defined({ keyId: text(request, "keyId", subject, { required: true, max: 200 }), label: text(request, "label", subject, { max: 60, nullable: true }) });
  }),
  removeKey: shape("RemoveKeyRequest", "removeKey", (request, subject) => {
    only(request, ["keyId"], subject);
    return { keyId: text(request, "keyId", subject, { required: true, max: 200 }) };
  }),
  switchKey: shape("SwitchKeyRequest", "switchKey", (request, subject) => {
    only(request, ["keyId"], subject);
    return { keyId: text(request, "keyId", subject, { required: true, max: 200 }) };
  }),
  reorderKeys: shape("ReorderKeysRequest", "reorderKeys", (request, subject) => {
    only(request, ["siteId", "keyIds"], subject);
    return { siteId: text(request, "siteId", subject, { required: true, max: 40 }), keyIds: ids(request, "keyIds", subject, { required: true }) };
  }),
  checkKeys: shape("CheckKeysRequest", "checkKeys", (request, subject) => {
    only(request, ["keyIds", "siteId", "mode", "deep"], subject);
    return defined({ keyIds: ids(request, "keyIds", subject), siteId: text(request, "siteId", subject, { max: 40 }), mode: oneOf(request, "mode", subject, ["auto", "validity", "funds", "probe"]), deep: flag(request, "deep", subject) });
  }),
  saveGroup: shape("SaveGroupRequest", "saveGroup", (request, subject) => {
    only(request, ["id", "name", "members", "active"], subject);
    return defined({ id: text(request, "id", subject, { max: 48 }), name: text(request, "name", subject, { max: 60 }), members: members(request, "members", subject), active: number(request, "active", subject, { integer: true, max: 19 }) });
  }),
  removeGroup: shape("RemoveGroupRequest", "removeGroup", (request, subject) => {
    only(request, ["groupId"], subject);
    return { groupId: text(request, "groupId", subject, { required: true, max: 48 }) };
  }),
  switchGroup: shape("SwitchGroupRequest", "switchGroup", (request, subject) => {
    only(request, ["groupId", "index"], subject);
    return { groupId: text(request, "groupId", subject, { required: true, max: 48 }), index: number(request, "index", subject, { required: true, integer: true, max: 19 }) };
  }),
};

const SUMMARY = {
  status: "The sites, their models and keys, and the switch groups.",
  discoverModels: "List what a saved site (or a draft: address, protocol, key) offers, each model described as far as the site and the reference tell; also what kind of site it is.",
  saveSite: "Add a site (with its first keys and models) or change one.",
  removeSite: "Forget a site and its keys.",
  reorderSites: "Put the sites in a new order.",
  setSiteEnabled: "Switch a site on or off (off: its models leave the model picker; keys and models stay).",
  addModels: "Add models to a site (they appear in the model picker).",
  removeModels: "Remove models from a site.",
  updateModel: "Edit one model of a site (null clears a field).",
  addKeys: "Add pasted keys to a site, one per line, each checked.",
  updateKey: "Change a key's label.",
  removeKey: "Forget one key.",
  switchKey: "Make one key its site's active key (keys never switch by themselves).",
  reorderKeys: "Put one site's keys in a new order.",
  checkKeys: "Re-check keys: validity, balance, or one tiny request (`deep`).",
  saveGroup: "Add or change a switch group: one picker entry served by the member chosen.",
  removeGroup: "Forget a switch group.",
  switchGroup: "Choose which member serves a switch group.",
};

const REQUEST_TYPES = Object.fromEntries(Object.entries(CODECS).map(([method]) => [method, `${method[0].toUpperCase()}${method.slice(1)}Request`]));

const MODEL_DECLARATION = "{\n        readonly id: string;\n        readonly name?: string;\n        readonly protocol?: \"chat\" | \"responses\" | \"messages\";\n        readonly context?: number;\n        readonly output?: number;\n        readonly image?: boolean;\n        readonly reasoning?: false | { readonly levels: readonly string[]; readonly off?: boolean; readonly map?: Readonly<Record<string, string>> };\n        readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number; readonly unit?: string };\n        readonly flags?: Readonly<Record<string, unknown>>;\n        readonly source?: \"site\" | \"reference\" | \"manual\";\n    }";

const DECLARATIONS = {
  StatusRequest: "export interface StatusRequest {}",
  DiscoverModelsRequest: "export interface DiscoverModelsRequest {\n    readonly siteId?: string;\n    readonly baseUrl?: string;\n    readonly protocol?: \"chat\" | \"responses\" | \"messages\";\n    readonly key?: string;\n    readonly headers?: Readonly<Record<string, string>>;\n    readonly allowHttp?: boolean;\n}",
  SaveSiteRequest: `export interface SaveSiteRequest {\n    readonly id?: string;\n    readonly newId?: string;\n    readonly name?: string;\n    readonly baseUrl?: string;\n    readonly protocol?: "chat" | "responses" | "messages";\n    readonly headers?: Readonly<Record<string, string>>;\n    readonly keyless?: boolean;\n    readonly allowHttp?: boolean;\n    readonly keys?: string;\n    readonly models?: readonly ${MODEL_DECLARATION}[];\n    readonly detected?: { readonly platform: string; readonly platformInfo?: unknown; readonly modelsPublic?: boolean };\n}`,
  RemoveSiteRequest: "export interface RemoveSiteRequest {\n    readonly siteId: string;\n}",
  ReorderSitesRequest: "export interface ReorderSitesRequest {\n    readonly siteIds: readonly string[];\n}",
  SetSiteEnabledRequest: "export interface SetSiteEnabledRequest {\n    readonly siteId: string;\n    readonly enabled: boolean;\n}",
  AddModelsRequest: `export interface AddModelsRequest {\n    readonly siteId: string;\n    readonly models: readonly ${MODEL_DECLARATION}[];\n}`,
  RemoveModelsRequest: "export interface RemoveModelsRequest {\n    readonly siteId: string;\n    readonly modelIds: readonly string[];\n}",
  UpdateModelRequest: "export interface UpdateModelRequest {\n    readonly siteId: string;\n    readonly modelId: string;\n    readonly patch: Readonly<Record<string, unknown>>;\n}",
  AddKeysRequest: "export interface AddKeysRequest {\n    readonly siteId: string;\n    readonly text: string;\n    readonly label?: string;\n}",
  UpdateKeyRequest: "export interface UpdateKeyRequest {\n    readonly keyId: string;\n    readonly label?: string | null;\n}",
  RemoveKeyRequest: "export interface RemoveKeyRequest {\n    readonly keyId: string;\n}",
  SwitchKeyRequest: "export interface SwitchKeyRequest {\n    readonly keyId: string;\n}",
  ReorderKeysRequest: "export interface ReorderKeysRequest {\n    readonly siteId: string;\n    readonly keyIds: readonly string[];\n}",
  CheckKeysRequest: "export interface CheckKeysRequest {\n    readonly keyIds?: readonly string[];\n    readonly siteId?: string;\n    readonly mode?: \"auto\" | \"validity\" | \"funds\" | \"probe\";\n    readonly deep?: boolean;\n}",
  SaveGroupRequest: "export interface SaveGroupRequest {\n    readonly id?: string;\n    readonly name?: string;\n    readonly members: readonly { readonly site: string; readonly model: string }[];\n    readonly active?: number;\n}",
  RemoveGroupRequest: "export interface RemoveGroupRequest {\n    readonly groupId: string;\n}",
  SwitchGroupRequest: "export interface SwitchGroupRequest {\n    readonly groupId: string;\n    readonly index: number;\n}",
  CustomModelsStatus: "export interface CustomModelsStatus {\n    readonly sites: readonly unknown[];\n    readonly keys: readonly KeySummary[];\n    readonly groups: readonly unknown[];\n}",
  KeySummary: "export interface KeySummary {\n    readonly id: string;\n    readonly endpoint: string;\n    readonly label: string | null;\n    readonly masked: string;\n    readonly active: boolean;\n    readonly status: string;\n    readonly balance: unknown;\n    readonly limitedUntil: string | null;\n}",
};

export const METHODS = Object.keys(CODECS);

export const TYPERT = {
  package: PACKAGE,
  face: "host",
  schemas: [],
  invocations: METHODS.map((method) => ({
    id: `${PACKAGE}#customModels/${method}`,
    service: "customModelsKeys",
    namespace: "customModels",
    method,
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: CODECS[method] }],
    cancellation: { parameter: "signal" },
    result: { mode: "strict", typeSymbol: `${PACKAGE}#customModels/${method}:result`, create: () => ({ parse: (value) => value }) },
  })),
  model: {
    services: [{
      key: "customModelsKeys",
      exportName: "CustomModelsKeys",
      description: "Site, model, key and switch-group management behind `ctx.remote.customModels`: the user's own API sites (relays, gateways, local servers), the models added to each, many keys per site switched by hand, and switch groups.",
      summary: "Site, model and key management behind `ctx.remote.customModels`.",
      jsDoc: "/** Site, model and key management behind `ctx.remote.customModels`. */",
      tags: [],
      members: METHODS.map((method) => ({
        kind: "method",
        name: method,
        signature: `${method}(request: ${REQUEST_TYPES[method]}, signal: AbortSignal): Promise<CustomModelsStatus>`,
        summary: SUMMARY[method],
        jsDoc: `/** ${SUMMARY[method]} */`,
      })),
      types: Object.entries(DECLARATIONS).map(([name, declaration]) => ({ name, declaration })),
    }],
    events: [],
    objects: [],
  },
};

export default TYPERT;
