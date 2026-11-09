/**
 * Active checks ("协议检测"): a handful of small requests on one site's
 * model, each testing something a relay serving another model (or making
 * answers up) tends to get wrong — two answers to the same question must have
 * different ids; `max_tokens` must cut the answer; a stop sequence must stop
 * it; a forced tool call must come as a call of the tool with valid
 * arguments; a model sold as seeing images must name a red image's colour.
 * The wording comes from the rule pack and changes on every run.
 *
 * Requests go straight to the site (as the key checks do), on the site's
 * active key, never through the conversation.
 *
 * @module dsh-custom-models/authn/probes
 */
import { randomInt } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { messagesBaseOf } from "../endpoints.js";
import { requestHeaders } from "../gateway.js";
import { redact } from "../errors.js";
import { familyOf, joinNames, matchSignals, tokenizerExpected, tokenizerMatches, versionOf } from "./rules.js";
import { uniqueIdForm } from "./judge.js";
import { newWire, prefixOf, shapeOf } from "./observe.js";

const REQUEST_TIMEOUT_MS = 90_000;
const pick = (list) => list[randomInt(list.length)];

/** One phrasing of a probe from the pack, slots filled at random; `lang` en / zh (falls back to the other). */
export function phrase(pack, name, lang = randomInt(2) ? "zh" : "en") {
  const entry = pack.probes[name];
  if (!entry) return null;
  const list = entry.phrasings[lang]?.length ? entry.phrasings[lang] : entry.phrasings[lang === "zh" ? "en" : "zh"];
  const template = pick(list);
  return { lang: entry.phrasings[lang]?.length ? lang : lang === "zh" ? "en" : "zh", text: template.replace(/\{([a-z]+)\}/g, (_, slot) => (entry.slots[slot]?.length ? pick(entry.slots[slot]) : "")), expect: entry.expect };
}

/** A small solid red PNG (16×16), made here. */
export function redPng(size = 16) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([0xdd, 0x11, 0x11]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

export const WEATHER_TOOL = Object.freeze({ name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string", description: "The city name" } }, required: ["city"] } });

/**
 * One request in the model's protocol, read into one shape.
 * @param {object} input - `endpoint`, `model` (effective), `key`, `prompt` (text), `image` (base64 PNG), `maxTokens`,
 *   `stop` (text), `tool` (force WEATHER_TOOL; "auto" to offer it only), `messages` (Messages protocol turns, replacing the prompt),
 *   `thinking` (Messages thinking config), `effort` (Messages `output_config.effort`), `system` (a system text),
 *   `temperature`, `extra` (fields merged into the body as they are), `headers` (extra), `fetchImpl`, `signal`.
 * @returns `{ status, ok, error, id, echo, text, finish, toolCalls: [{ id, name, arguments }], usage: { input, output }, thinking: [blocks], headers, wire }`.
 */
export async function ask({ endpoint, model, key, prompt, image, maxTokens = 300, stop, tool, messages, thinking, effort, system, temperature, extra: extraBody, headers: extra = {}, fetchImpl = fetch, signal }) {
  const protocol = model.protocol ?? endpoint.protocol;
  const headers = { "content-type": "application/json", ...requestHeaders(endpoint.headers), ...extra };
  if (key) {
    headers.authorization = `Bearer ${key}`;
    if (protocol === "messages") headers["x-api-key"] = key;
  }
  let url;
  let body;
  const outputField = model.flags?.maxTokensField ?? "max_tokens";
  if (protocol === "messages") {
    headers["anthropic-version"] ??= "2023-06-01";
    url = `${messagesBaseOf(endpoint, model)}/v1/messages`;
    const content = image ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: image } }, { type: "text", text: prompt }] : prompt;
    body = { model: model.id, max_tokens: maxTokens, messages: messages ?? [{ role: "user", content }] };
    if (stop) body.stop_sequences = [stop];
    if (tool) Object.assign(body, { tools: [{ name: WEATHER_TOOL.name, description: WEATHER_TOOL.description, input_schema: WEATHER_TOOL.parameters }], tool_choice: tool === "auto" ? { type: "auto" } : { type: "any" } });
    if (thinking) body.thinking = thinking;
    if (effort) body.output_config = { effort };
  } else if (protocol === "responses") {
    url = `${endpoint.baseUrl}/responses`;
    const content = image ? [{ type: "input_text", text: prompt }, { type: "input_image", image_url: `data:image/png;base64,${image}` }] : prompt;
    body = { model: model.id, input: image ? [{ role: "user", content }] : content, max_output_tokens: Math.max(16, maxTokens), store: false };
    if (tool) Object.assign(body, { tools: [{ type: "function", name: WEATHER_TOOL.name, description: WEATHER_TOOL.description, parameters: WEATHER_TOOL.parameters, strict: false }], tool_choice: tool === "auto" ? "auto" : "required" });
  } else {
    url = `${endpoint.baseUrl}/chat/completions`;
    const content = image ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }] : prompt;
    body = { model: model.id, messages: [{ role: "user", content }], [outputField]: maxTokens };
    if (stop) body.stop = [stop];
    if (tool) Object.assign(body, { tools: [{ type: "function", function: WEATHER_TOOL }], tool_choice: tool === "auto" ? "auto" : "required" });
  }
  if (system) {
    if (protocol === "messages") body.system = system;
    else if (protocol === "responses") body.instructions = system;
    else body.messages = [{ role: "system", content: system }, ...body.messages];
  }
  if (typeof temperature === "number") body.temperature = temperature;
  if (extraBody && typeof extraBody === "object") Object.assign(body, extraBody);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 0, ok: false, error: timeout.aborted ? "timeout" : redact(String(error?.cause?.code ?? error?.message ?? error)).slice(0, 160) };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const out = { status: response.status, ok: response.ok && json !== undefined, headers: response.headers, raw: json };
  if (!out.ok) return { ...out, error: redact(String(json?.error?.message ?? json?.message ?? text ?? "").replace(/\s+/g, " ")).slice(0, 300) };
  const wire = newWire();
  if (protocol === "messages") {
    const blocks = Array.isArray(json.content) ? json.content : [];
    Object.assign(out, {
      id: json.id ?? null,
      echo: json.model ?? null,
      text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
      finish: json.stop_reason ?? null,
      toolCalls: blocks.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, name: block.name, arguments: block.input })),
      thinking: blocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking"),
      blocks,
      usage: { input: (json.usage?.input_tokens ?? 0) + (json.usage?.cache_read_input_tokens ?? 0) + (json.usage?.cache_creation_input_tokens ?? 0), output: json.usage?.output_tokens ?? 0 },
    });
  } else if (protocol === "responses") {
    const items = Array.isArray(json.output) ? json.output : [];
    Object.assign(out, {
      id: json.id ?? null,
      echo: json.model ?? null,
      text: items.filter((item) => item.type === "message").flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join(""),
      finish: json.status === "incomplete" ? json.incomplete_details?.reason ?? "incomplete" : json.status ?? null,
      toolCalls: items.filter((item) => item.type === "function_call").map((item) => ({ id: item.call_id ?? item.id, name: item.name, arguments: item.arguments })),
      thinking: [],
      usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0, reasoning: json.usage?.output_tokens_details?.reasoning_tokens ?? 0 },
    });
  } else {
    const message = json.choices?.[0]?.message ?? {};
    Object.assign(out, {
      id: json.id ?? null,
      echo: json.model ?? null,
      text: typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text ?? "").join("") : "",
      finish: json.choices?.[0]?.finish_reason ?? null,
      toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments })),
      thinking: [],
      usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0, reasoning: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
      fingerprint: json.system_fingerprint ?? null,
    });
  }
  Object.assign(wire, { id: out.id, echo: out.echo, toolId: out.toolCalls?.[0]?.id ?? null, fingerprint: out.fingerprint ?? null });
  out.wire = wire;
  return out;
}

const parsedArguments = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const CUT = new Set(["length", "max_tokens", "max_output_tokens", "incomplete"]);

/**
 * The model name a site's answer carries, against the one asked for: another family or tier, or the same tier in
 * another version ("claude-opus-4-6-thinking" answering claude-opus-4-7), is another model. A Bedrock profile ARN
 * names none. Null when the answer carries no name.
 */
export function echoItem(pack, asked, echo) {
  if (!echo) return null;
  const value = String(echo).slice(0, 80);
  if (/^arn:aws:bedrock:/i.test(echo)) return { id: "echo", outcome: "na", level: "info", key: "probe.echoArn", params: {} };
  const want = familyOf(pack, asked);
  const got = familyOf(pack, echo);
  if (want && got && (got.family !== want.family || (got.tier && want.tier && got.tier !== want.tier))) return { id: "echo", outcome: "fail", level: "hard", key: "probe.echoMismatch", params: { echo: value, asked }, likely: value };
  const [wantVersion, gotVersion] = [versionOf(asked), versionOf(echo)];
  if (wantVersion && gotVersion && wantVersion.version !== gotVersion.version) return { id: "echo", outcome: "fail", level: "hard", key: "probe.echoVersion", params: { echo: value, asked }, likely: value };
  return { id: "echo", outcome: "pass", key: "probe.echo", params: { echo: value } };
}

/**
 * The identity check ("身份核验"): two requests with the pack's fixed texts — `base`, then `base` + `probe` — and the
 * difference of the input tokens the site reports. A relay's own additions are the same in both and cancel out; what
 * stays is how the serving model's tokenizer splits `probe`, which the pack lists per tokenizer, measured live.
 * Matching the claimed model's tokenizer: 相符. Another generation of the same family (Claude 4.6's tokenizer behind
 * "Opus 4.7"): another model — no relay can count Claude's tokens itself. Another vendor's, or none known: a doubt
 * (another model, or a site that counts usage itself). The model name the answers carry is compared too.
 * @returns `{ kind: "identity", at, items, usage, channel }`.
 */
export const IDENTITY_REQUESTS = 2;
export async function identityCheck({ pack, endpoint, model, key, fetchImpl = fetch, signal, onStep = () => {}, now = () => Date.now() }) {
  const protocol = model.protocol ?? endpoint.protocol;
  const tokenizer = pack.identity?.tokenizer ?? null;
  const items = [];
  const usage = { requests: 0, input: 0, output: 0 };
  const signals = new Set();
  const done = () => ({ kind: "identity", at: now(), items, usage, channel: [...signals] });
  if (!tokenizer) {
    items.push({ id: "tokenizer", outcome: "na", level: "info", key: "probe.tokenizerNoPack", params: {} });
    return done();
  }
  let step = 0;
  const call = async (prompt) => {
    step += 1;
    onStep(step, IDENTITY_REQUESTS);
    const result = await ask({ endpoint, model, key, fetchImpl, signal, prompt, maxTokens: tokenizer.maxTokens });
    usage.requests += 1;
    if (result.usage) {
      usage.input += result.usage.input;
      usage.output += result.usage.output;
    }
    if (result.wire) {
      const names = [];
      result.headers?.forEach?.((_, name) => names.push(name.toLowerCase()));
      for (const id of matchSignals(pack, { ...result.wire, headers: names }, protocol)) signals.add(id);
    }
    return result;
  };
  const first = await call(tokenizer.base);
  const second = first.ok && !signal?.aborted ? await call(`${tokenizer.base}\n\n${tokenizer.probe}`) : null;
  if (!first.ok || !second?.ok) {
    const failed = first.ok ? second : first;
    if (failed) items.push({ id: "tokenizer", outcome: "error", level: "info", key: "probe.requestFailed", params: { status: failed.status, error: String(failed.error ?? "").slice(0, 160) } });
    return done();
  }
  const [a, b] = [first.usage?.input ?? 0, second.usage?.input ?? 0];
  if (!(a > 0) || !(b > a)) items.push({ id: "tokenizer", outcome: "na", level: "info", key: "probe.tokenizerNoUsage", params: {} });
  else {
    const delta = b - a;
    const expected = tokenizerExpected(pack, model.id);
    const matched = tokenizerMatches(pack, delta);
    const family = familyOf(pack, model.id)?.family ?? expected[0]?.family ?? null;
    const names = (groups) => joinNames(groups.map((group) => group.name));
    const own = matched.filter((group) => expected.includes(group));
    if (own.length) items.push({ id: "tokenizer", outcome: "pass", key: "probe.tokenizerMatch", params: { delta, group: names(own) } });
    else if (expected.length && matched.length) {
      const sameFamily = matched.some((group) => group.family === family);
      items.push({ id: "tokenizer", outcome: "fail", level: sameFamily ? "hard" : "soft", key: sameFamily ? "probe.tokenizerGeneration" : "probe.tokenizerOther", params: { delta, expected: names(expected), likely: names(matched) }, likely: names(matched) });
    } else if (expected.length) items.push({ id: "tokenizer", outcome: "fail", level: "soft", key: "probe.tokenizerUnknown", params: { delta, expected: names(expected), want: expected[0].delta } });
    else if (matched.length && family && !matched.some((group) => group.family === family)) items.push({ id: "tokenizer", outcome: "fail", level: "soft", key: "probe.tokenizerFamily", params: { delta, likely: names(matched) }, likely: names(matched) });
    else items.push({ id: "tokenizer", outcome: "na", level: "info", key: "probe.tokenizerNoRef", params: { delta, likely: matched.length ? names(matched) : "—" } });
  }
  const echo = echoItem(pack, model.id, second.echo ?? first.echo);
  if (echo) items.push(echo);
  onStep(IDENTITY_REQUESTS, IDENTITY_REQUESTS);
  return done();
}

/** The checks a quick run makes on a model (the image one only for a model sold as seeing images). */
export function quickPlan(model, protocol) {
  return ["echo", "maxtokens", ...(protocol === "responses" ? [] : ["stop"]), "tool", ...(model.image === true && model.imageRefused !== true ? ["image"] : [])];
}
/** Requests a quick run sends. */
export const quickRequests = (model, protocol) => quickPlan(model, protocol).length + 1;

/**
 * Run the quick check.
 * @param {object} input - `pack`, `endpoint`, `model` (effective), `key`, `fetchImpl`, `signal`, `onStep(step, steps)`.
 * @returns `{ kind: "quick", at, items, usage: { requests, input, output }, channel: [signal ids] }`.
 */
export async function quickCheck({ pack, endpoint, model, key, fetchImpl = fetch, signal, onStep = () => {}, now = () => Date.now() }) {
  const protocol = model.protocol ?? endpoint.protocol;
  const plan = quickPlan(model, protocol);
  const steps = quickRequests(model, protocol);
  const items = [];
  const usage = { requests: 0, input: 0, output: 0 };
  const signals = new Set();
  let step = 0;
  const call = async (input) => {
    step += 1;
    onStep(step, Math.max(step, steps));
    const result = await ask({ endpoint, model, key, fetchImpl, signal, ...input });
    usage.requests += 1;
    if (result.usage) {
      usage.input += result.usage.input;
      usage.output += result.usage.output;
    }
    if (result.wire) {
      const names = [];
      result.headers?.forEach?.((_, name) => names.push(name.toLowerCase()));
      for (const id of matchSignals(pack, { ...result.wire, headers: names }, protocol)) signals.add(id);
    }
    return result;
  };
  const failed = (id, result) => ({ id, outcome: "error", level: "info", key: "probe.requestFailed", params: { status: result.status, error: String(result.error ?? "").slice(0, 160) } });

  for (const name of plan) {
    if (signal?.aborted) break;
    if (name === "echo") {
      const question = phrase(pack, "echo");
      const first = await call({ prompt: question.text, maxTokens: 400 });
      const second = first.ok ? await call({ prompt: question.text, maxTokens: 400 }) : null;
      if (!first.ok || !second?.ok) {
        items.push(failed("echo", first.ok ? second : first));
        continue;
      }
      if (first.id && second.id && !uniqueIdForm(shapeOf(first.id))) {
        // Ids with a short random part (a local server's counter) may repeat: nothing to judge.
        items.push({ id: "unique-id", outcome: "na", level: "info", key: "probe.shortId", params: { id: prefixOf(first.id) } });
      } else if (first.id && second.id) {
        const sameText = first.text.trim() === second.text.trim() && first.text.trim().length > 0;
        if (first.id === second.id) items.push({ id: "unique-id", outcome: "fail", level: sameText ? "hard" : "soft", key: sameText ? "probe.replay" : "probe.sameId", params: { id: prefixOf(first.id) } });
        else items.push({ id: "unique-id", outcome: "pass", key: "probe.uniqueId", params: {} });
      } else items.push({ id: "unique-id", outcome: "na", level: "info", key: "probe.noId", params: {} });
      const echo = echoItem(pack, model.id, first.echo);
      if (echo) items.push(echo);
    } else if (name === "maxtokens") {
      // 16: the smallest limit sites take (some raise a smaller one to it, live 2026-11-09; Responses refuses less).
      const limit = 16;
      const result = await call({ prompt: phrase(pack, "maxtokens").text, maxTokens: limit });
      if (!result.ok) {
        items.push(failed("maxtokens", result));
        continue;
      }
      const cut = CUT.has(String(result.finish));
      const counted = result.usage?.output ?? 0;
      // Asked for every number up to 60–100 (well over 100 tokens): far over the limit, or uncut and long without usage, is ignored.
      const over = counted > limit * 4 || (!cut && counted === 0 && result.text.length > limit * 12);
      if (over) items.push({ id: "maxtokens", outcome: "fail", level: "soft", key: "probe.maxTokensIgnored", params: { limit, finish: String(result.finish ?? "-"), output: counted } });
      else items.push({ id: "maxtokens", outcome: "pass", key: "probe.maxTokens", params: { limit } });
    } else if (name === "stop") {
      const result = await call({ prompt: phrase(pack, "stop").text, maxTokens: 120, stop: "8" });
      if (!result.ok) {
        // A model that takes no stop sequence (some reasoning models) refuses it: nothing to judge.
        items.push(result.status === 400 ? { id: "stop", outcome: "na", level: "info", key: "probe.stopRefused", params: { error: String(result.error ?? "").slice(0, 120) } } : failed("stop", result));
        continue;
      }
      const went = /\b(9|1[0-5])\b/.test(result.text);
      // The relay's fidelity (many gateways drop parameters a model may not take), no word on the model: shown only.
      if (went) items.push({ id: "stop", outcome: "fail", level: "info", key: "probe.stopIgnored", params: {} });
      else items.push({ id: "stop", outcome: "pass", key: "probe.stop", params: {} });
    } else if (name === "tool") {
      const question = phrase(pack, "tool");
      let result = await call({ prompt: question.text, maxTokens: 400, tool: "force" });
      let forced = true;
      if (!result.ok && result.status === 400) {
        // A relay that refuses a forced tool choice (live 2026-11-08): offered only, once more.
        result = await call({ prompt: question.text, maxTokens: 400, tool: "auto" });
        forced = false;
      }
      if (!result.ok) {
        items.push(failed("tool", result));
        continue;
      }
      const toolCall = result.toolCalls?.find((item) => item.name === WEATHER_TOOL.name);
      const args = toolCall ? parsedArguments(toolCall.arguments) : null;
      if (!toolCall) items.push({ id: "tool", outcome: "fail", level: "soft", key: forced ? "probe.toolMissing" : "probe.toolMissingAuto", params: {} });
      else if (!args || typeof args.city !== "string" || !args.city.trim()) items.push({ id: "tool", outcome: "fail", level: "soft", key: "probe.toolArgs", params: { args: JSON.stringify(toolCall.arguments ?? null).slice(0, 80) } });
      else items.push({ id: "tool", outcome: "pass", key: forced ? "probe.tool" : "probe.toolAuto", params: { prefix: prefixOf(toolCall.id ?? "") } });
    } else if (name === "image") {
      const question = phrase(pack, "image");
      const result = await call({ prompt: question.text, maxTokens: 300, image: redPng() });
      if (!result.ok) {
        items.push(failed("image", result));
        continue;
      }
      const seen = (question.expect ?? []).some((word) => result.text.toLowerCase().includes(word.toLowerCase()));
      items.push(seen ? { id: "image", outcome: "pass", key: "probe.image", params: {} } : { id: "image", outcome: "fail", level: "soft", key: "probe.imageWrong", params: { answer: result.text.trim().slice(0, 40) } });
    }
  }
  onStep(Math.max(step, steps), Math.max(step, steps));
  return { kind: "quick", at: now(), items, usage, channel: [...signals] };
}
