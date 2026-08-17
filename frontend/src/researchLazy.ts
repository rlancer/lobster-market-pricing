/**
 * Fire `onArm` once when `#elementId` nears the viewport.
 * Falls back to immediate arm when IntersectionObserver is unavailable.
 */
export function observeOnce(
  elementId: string,
  onArm: () => void,
  opts?: { rootMargin?: string },
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onArm();
    return () => {};
  }
  const node = document.getElementById(elementId);
  if (!(node instanceof Element)) {
    onArm();
    return () => {};
  }
  let armed = false;
  const observer = new IntersectionObserver(
    (entries) => {
      if (armed) return;
      if (entries.some((e) => e.isIntersecting)) {
        armed = true;
        onArm();
        observer.disconnect();
      }
    },
    { rootMargin: opts?.rootMargin ?? '120px 0px' },
  );
  observer.observe(node);
  return () => observer.disconnect();
}

/** Schedule work after the browser is idle (or a short timeout fallback). */
export function whenIdle(task: () => void, timeoutMs = 1200): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof ric === 'function') {
    const id = ric(() => task(), { timeout: timeoutMs });
    return () => { if (typeof cic === 'function') cic(id); };
  }
  const id = globalThis.setTimeout(task, Math.min(timeoutMs, 200));
  return () => globalThis.clearTimeout(id);
}
