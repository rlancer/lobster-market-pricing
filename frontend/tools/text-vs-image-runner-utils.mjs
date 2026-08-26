export function deterministicShuffle(items, seed) {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = items.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapWith]] = [shuffled[swapWith], shuffled[index]];
  }
  return shuffled;
}

function retryAfterMs(value, nowMs) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : 0;
}

/**
 * Return a retry delay for network/transient HTTP failures, or null for
 * permanent failures. `attempt` is one-based.
 */
export function probeRetryDelayMs(error, attempt, nowMs = Date.now()) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const retryable = status == null
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
  if (!retryable) return null;
  const exponential = 500 * (2 ** Math.max(0, attempt - 1));
  return Math.max(exponential, retryAfterMs(error?.retryAfter, nowMs));
}
