/**
 * Live chat turn chrome — Thinking panel vs spinner.
 *
 * Stream replay (`resetMatchingHydratedAssistantForReplay`), chatRecovery's extra
 * empty assistant rows, and `cf_agent_chat_messages` snapshots that omit in-flight
 * reasoning all briefly clear parts while the turn is still busy. The UI used to
 * unmount the Thinking panel and leave only the spinner, then mount it again —
 * a blink between thinking and the loading indicator.
 */

export function reasoningTextFromParts(
  parts: ReadonlyArray<{ type: string; text?: string }> | undefined,
): string {
  if (!parts?.length) return '';
  return parts
    .filter((part) => part.type === 'reasoning' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Replay rebuilds reasoning from the first token. Keep the longer trace until
 * the new stream catches up so the Thinking box does not collapse and jump.
 */
export function pickLiveReasoning(current: string, latched: string): string {
  if (!current.trim()) return latched;
  if (!latched) return current;
  if (latched.startsWith(current) && current.length < latched.length) return latched;
  return current;
}

/** Keep the last non-empty live value until this user turn settles. */
export function nextLatchedLiveText(
  current: string,
  previousLatch: string,
  live: boolean,
  turnKey = '',
  previousTurnKey = '',
): { shown: string; latch: string; turnKey: string } {
  if (!live) return { shown: current, latch: '', turnKey: '' };
  if (turnKey !== previousTurnKey) {
    if (current.trim()) return { shown: current, latch: current, turnKey };
    return { shown: current, latch: '', turnKey };
  }
  const shown = pickLiveReasoning(current, previousLatch);
  return { shown, latch: shown, turnKey };
}

export const STICK_SCROLL_THRESHOLD_PX = 32;

export function isNearScrollBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx = STICK_SCROLL_THRESHOLD_PX,
): boolean {
  const max = Math.max(0, scrollHeight - clientHeight);
  return max - scrollTop <= thresholdPx;
}

/** Stick an overflow box to the bottom unless the user has scrolled up. */
export function nextStickScrollTop(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  pinned: boolean;
  thresholdPx?: number;
}): { scrollTop: number; pinned: boolean } {
  const max = Math.max(0, args.scrollHeight - args.clientHeight);
  const nearBottom = isNearScrollBottom(
    args.scrollTop,
    args.scrollHeight,
    args.clientHeight,
    args.thresholdPx,
  );
  const pinned = args.pinned || nearBottom;
  if (!pinned) return { scrollTop: args.scrollTop, pinned: false };
  return { scrollTop: max, pinned: true };
}

export function nextLatchedLiveList<T>(
  current: readonly T[],
  previousLatch: readonly T[],
  live: boolean,
  turnKey = '',
  previousTurnKey = '',
): { shown: T[]; latch: T[]; turnKey: string } {
  if (!live) return { shown: [...current], latch: [], turnKey: '' };
  if (turnKey !== previousTurnKey) {
    if (current.length > 0) return { shown: [...current], latch: [...current], turnKey };
    return { shown: [...current], latch: [], turnKey };
  }
  if (current.length > 0) return { shown: [...current], latch: [...current], turnKey };
  return { shown: [...previousLatch], latch: [...previousLatch], turnKey };
}

/** Projected assistant bubble for the in-progress user turn. */
export function liveProjectedAssistant<T extends { role: string }>(
  messages: readonly T[],
  live: boolean,
): T | undefined {
  if (!live) return undefined;
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex < 0) return undefined;
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

export function isLiveProjectedMessage(
  messageId: string,
  liveMessageIds: readonly (string | undefined)[],
): boolean {
  return liveMessageIds.some((id) => id != null && id === messageId);
}
