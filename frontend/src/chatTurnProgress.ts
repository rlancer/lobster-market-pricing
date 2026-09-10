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
  if (current.trim()) return { shown: current, latch: current, turnKey };
  return { shown: previousLatch, latch: previousLatch, turnKey };
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
