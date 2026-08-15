/** Agent WebSocket reconnect — PartySocket already retries, but tabs freeze,
 *  browsers drop sockets while backgrounded, and offline/online edges need an
 *  explicit kick plus a UI signal so a paused or in-flight turn can resume. */

import { useCallback, useEffect, useRef, useState } from 'react';

export type AgentSocketState = 'open' | 'reconnecting' | 'offline';

export interface ReconnectableAgent {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  reconnect?: (code?: number, reason?: string) => void;
  readyState: number;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(400 * 2 ** Math.max(0, attempt), 10_000);
}

export function socketStateFromReadyState(
  readyState: number,
  online = typeof navigator === 'undefined' ? true : navigator.onLine,
): AgentSocketState {
  if (readyState === 1) return 'open';
  if (!online) return 'offline';
  return 'reconnecting';
}

export function useAgentReconnect(agent: ReconnectableAgent): {
  state: AgentSocketState;
  attempt: number;
  /** Re-open the socket. `quiet` skips the reconnecting banner (used for Stop/pause). */
  reconnect: (opts?: { quiet?: boolean; force?: boolean }) => void;
} {
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const quietRef = useRef(false);
  const attemptRef = useRef(0);
  const [state, setState] = useState<AgentSocketState>(() => socketStateFromReadyState(agent.readyState));
  const [attempt, setAttempt] = useState(0);

  const reconnect = useCallback((opts?: { quiet?: boolean; force?: boolean }) => {
    const socket = agentRef.current;
    const quiet = opts?.quiet === true;
    const force = opts?.force === true;
    if (quiet) quietRef.current = true;
    if (socket.readyState === 1 && !force) {
      quietRef.current = false;
      setState('open');
      return;
    }
    if (!quiet && socket.readyState !== 1) {
      setState(socketStateFromReadyState(socket.readyState));
    }
    socket.reconnect?.();
  }, []);

  useEffect(() => {
    const onOpen = () => {
      quietRef.current = false;
      attemptRef.current = 0;
      setAttempt(0);
      setState('open');
    };
    const onClose = () => {
      if (quietRef.current) {
        quietRef.current = false;
        return;
      }
      attemptRef.current += 1;
      setAttempt(attemptRef.current);
      setState(socketStateFromReadyState(agentRef.current.readyState));
    };
    const onOnline = () => {
      setState(socketStateFromReadyState(agentRef.current.readyState, true));
      reconnect();
    };
    const onOffline = () => {
      setState('offline');
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (agentRef.current.readyState === 1) {
        setState('open');
        return;
      }
      reconnect();
    };

    agent.addEventListener('open', onOpen);
    agent.addEventListener('close', onClose);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    setState(socketStateFromReadyState(agent.readyState));

    return () => {
      agent.removeEventListener('open', onOpen);
      agent.removeEventListener('close', onClose);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [agent, reconnect]);

  useEffect(() => {
    if (state !== 'reconnecting') return;
    const socket = agentRef.current;
    if (socket.readyState === 1) {
      setState('open');
      return;
    }
    const delay = reconnectDelayMs(attempt);
    const timer = window.setTimeout(() => {
      if (agentRef.current.readyState === 1) {
        setState('open');
        return;
      }
      if (agentRef.current.readyState === 3) reconnect();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state, attempt, reconnect]);

  return { state, attempt, reconnect };
}
