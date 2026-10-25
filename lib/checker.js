/**
 * Keeps every key's validity and balance current.
 *
 * `check` runs one key's check (`auto`, `validity`, `funds` or `probe`, see
 * probe.js) with its site's settings and stores the result; `afterUse`
 * re-reads a key's balance shortly after it served (or refused) a request, so
 * the tab follows real use. After-use checks never send a request of their
 * own (a served request already proved the key).
 *
 * @module dsh-custom-models/checker
 */
import { redact } from "./errors.js";
import { checkKey } from "./probe.js";

/** A request is followed by its key's check after this long (the site books it first). */
const AFTER_USE_DELAY_MS = 3_000;
/** …and at most this often per key (an agent turn makes many requests). */
const AFTER_USE_GAP_MS = 30_000;

/**
 * @param {object} deps - `{ keys, settings, fetchImpl, log, now, delayMs, gapMs, retryDelayMs }`.
 * @returns `{ check(id, { mode, deep, signal }), afterUse(id) }`.
 */
export function createChecker({ keys, settings, fetchImpl = fetch, log = () => {}, now = () => Date.now(), delayMs = AFTER_USE_DELAY_MS, gapMs = AFTER_USE_GAP_MS, retryDelayMs }) {
  const running = new Map();

  /** Check one key and store what was learned. Concurrent callers share one check. */
  function check(id, { mode = "auto", deep = false, signal } = {}) {
    const key = `${id}:${mode}:${deep}`;
    if (running.has(key)) return running.get(key);
    const run = (async () => {
      const record = await keys.get(id);
      if (!record) return { id, ok: false, error: "unknown key" };
      try {
        const site = await settings.site(record.endpoint);
        const result = await checkKey(record, { mode, deep, site, fetchImpl, signal, now, ...(retryDelayMs !== undefined ? { retryDelayMs } : {}) });
        const { authenticated, unproven, ...patch } = result;
        await keys.patch(id, patch);
        return { id, ok: true, status: patch.status ?? record.status ?? "unknown" };
      } catch (error) {
        log("warn", `check of ${id} failed: ${redact(error?.message ?? error)}`);
        return { id, ok: false, error: redact(error?.message ?? error) };
      }
    })().finally(() => running.delete(key));
    running.set(key, run);
    return run;
  }

  const pending = new Set();
  const lastRun = new Map();
  /** Re-read one key's balance shortly after it was used (validity where the site shows no balance). */
  function afterUse(id) {
    if (!id || pending.has(id)) return;
    const wait = Math.max(delayMs, (lastRun.get(id) ?? 0) + gapMs - now());
    pending.add(id);
    const timer = setTimeout(() => {
      pending.delete(id);
      lastRun.set(id, now());
      check(id, { mode: "funds" }).catch(() => undefined);
    }, wait);
    timer.unref?.();
  }

  return { check, afterUse };
}
