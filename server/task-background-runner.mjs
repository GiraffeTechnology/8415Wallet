/** Internal bounded continuation scheduler. It grants no authority and exposes no
 * HTTP route, cookie, API credential, signer or user-session substitute.
 *
 * The service-owned port lists only durably approved grants. Every resume must
 * revalidate the grant and current credential at the existing atomic send fence.
 * All runners share one single-writer store OBJECT in one process. Independent
 * replicas/stores are unsupported; the encrypted store excludes other processes.
 */
const storeLocks = new WeakSet();
const terminal = new Set(['completed-at-observation-depth', 'failed-at-observation-depth']);
const boundedInteger = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const codeOf = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code ?? error?.message ?? '') ?
  (error.code ?? error.message) : 'TASK_BACKGROUND_STEP_FAILED';

export function createTaskBackgroundRunner({ store, continuation, now = Date.now,
  intervalMs = 5000, idleBackoffMs = 30000, maxBackoffMs = 300000, maxPerTick = 10 } = {}) {
  if (!store || typeof store !== 'object' || typeof store.transactionMany !== 'function' ||
      !continuation || typeof continuation.list !== 'function' || typeof continuation.resume !== 'function' ||
      typeof now !== 'function' || !boundedInteger(intervalMs, 10, 300000) ||
      !boundedInteger(idleBackoffMs, intervalMs, 3600000) || !boundedInteger(maxBackoffMs, idleBackoffMs, 3600000) || !boundedInteger(maxPerTick, 1, 50))
    throw Error('TASK_BACKGROUND_CONFIG_REFUSED');
  // Capture the configured port, just as the task service captures its adapters.
  const list = continuation.list.bind(continuation), resume = continuation.resume.bind(continuation);
  const delays = new Map();
  let cursor = '0', enabled = false, timer = null, inflight = null, generation = 0;
  const clock = () => { const value = now(); if (!boundedInteger(value, 0, Number.MAX_SAFE_INTEGER)) throw Error('TASK_BACKGROUND_CLOCK_REFUSED'); return value; };
  function defer(entry, state, code = null) {
    const prior = delays.get(entry);
    const count = prior?.state === state && prior?.code === code ? Math.min(prior.count + 1, 30) : 1;
    delays.set(entry, { state, code, count, until: terminal.has(state) ? Infinity :
      clock() + Math.min(maxBackoffMs, (['blocked', 'waiting-for-operation'].includes(state) ? idleBackoffMs : intervalMs) * 2 ** (count - 1)) });
  }
  async function run() {
    if (storeLocks.has(store)) return { state: 'busy', visited: 0, results: [] };
    storeLocks.add(store);
    try {
      clock();
      const page = await list({ cursor, limit: maxPerTick });
      if (!page || !Array.isArray(page.entries) || page.entries.length > maxPerTick ||
          page.entries.some(entry => typeof entry !== 'string' || !entry || entry.length > 256) ||
          new Set(page.entries).size !== page.entries.length ||
          !(page.nextCursor === null || typeof page.nextCursor === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(page.nextCursor) &&
            Number.isSafeInteger(Number(page.nextCursor)) && BigInt(page.nextCursor) > BigInt(cursor)))
        throw Error('TASK_BACKGROUND_INDEX_REFUSED');
      const results = [];
      // Advance even if every entry is blocked/backed off. New approvals append
      // to a durable index and cannot reset the cursor or starve later entries.
      cursor = page.nextCursor ?? '0';
      for (const entry of page.entries) {
        if ((delays.get(entry)?.until ?? -1) > clock()) continue;
        try {
          const progress = await resume(entry);
          const state = progress?.continuation?.state;
          if (typeof state !== 'string' || !state) throw Error('TASK_BACKGROUND_RESULT_REFUSED');
          const code = progress.continuation.code ?? null;
          defer(entry, state, code);
          results.push({ entry, state, code });
        } catch (error) {
          const code = codeOf(error); defer(entry, 'blocked', code);
          results.push({ entry, state: 'blocked', code });
        }
      }
      return { state: 'idle', visited: page.entries.length, results };
    } finally { storeLocks.delete(store); }
  }
  function tick() {
    if (inflight) return Promise.resolve({ state: 'busy', visited: 0, results: [] });
    const pending = run(); inflight = pending;
    pending.then(() => { if (inflight === pending) inflight = null; }, () => { if (inflight === pending) inflight = null; });
    return pending;
  }
  async function cycle(current) {
    if (!enabled || current !== generation) return;
    try { await tick(); } catch { /* Store/index faults fail closed; retry later. */ }
    if (enabled && current === generation) { timer = setTimeout(() => cycle(current), intervalMs); timer.unref?.(); }
  }
  function start() {
    if (enabled) return;
    enabled = true; void cycle(++generation);
  }
  async function stop() {
    enabled = false; generation++; if (timer !== null) { clearTimeout(timer); timer = null; }
    // No timeout releases an in-flight signer. A stuck adapter cannot let a
    // second worker replace it and send again. Stop before closing the store.
    if (inflight) await inflight.catch(() => {});
  }
  return Object.freeze({ tick, start, stop });
}
