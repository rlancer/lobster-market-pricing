import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { authClient } from './auth';
import {
  DEFAULT_REPLY_STYLE,
  loadReplyPref,
  parseReplyPref,
  REPLY_STYLE_EVENT,
  saveReplyPref,
  type ReplyPref,
  type ReplyStyleId,
} from './replyStyle';

/**
 * Shared reply-voice state for Chat + Account.
 * Anonymous: localStorage. Signed-in: /api/me is source of truth, PATCH on change.
 */
export function useReplyStyle(): {
  pref: ReplyPref;
  setStyle: (style: ReplyStyleId) => void;
  setNote: (note: string) => void;
  signedIn: boolean;
} {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? null;
  const [pref, setPref] = useState<ReplyPref>(() => loadReplyPref());
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  useEffect(() => {
    const onLocal = (event: Event) => {
      const detail = (event as CustomEvent<ReplyPref>).detail;
      if (detail) setPref(parseReplyPref(detail));
    };
    window.addEventListener(REPLY_STYLE_EVENT, onLocal);
    return () => window.removeEventListener(REPLY_STYLE_EVENT, onLocal);
  }, []);

  useEffect(() => {
    if (!userId) {
      setPref(loadReplyPref());
      return;
    }
    let active = true;
    api.me().then((me) => {
      if (!active) return;
      const next = saveReplyPref({
        style: me.reply_style ?? DEFAULT_REPLY_STYLE,
        note: me.reply_note ?? '',
      });
      setPref(next);
    }).catch(() => {
      if (active) setPref(loadReplyPref());
    });
    return () => { active = false; };
  }, [userId]);

  const persist = useCallback((next: ReplyPref, delayMs: number) => {
    const stored = saveReplyPref(next);
    setPref(stored);
    if (!userIdRef.current) return;
    if (noteTimer.current) clearTimeout(noteTimer.current);
    const push = () => {
      void api.updateProfile({
        reply_style: stored.style,
        reply_note: stored.note || null,
      }).catch(() => {
        // Local cache still holds the choice; next /api/me load reconciles.
      });
    };
    if (delayMs <= 0) push();
    else noteTimer.current = setTimeout(push, delayMs);
  }, []);

  const prefRef = useRef(pref);
  prefRef.current = pref;

  const setStyle = useCallback((style: ReplyStyleId) => {
    persist({ ...prefRef.current, style }, 0);
  }, [persist]);

  const setNote = useCallback((note: string) => {
    persist({ ...prefRef.current, note }, 400);
  }, [persist]);

  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);

  return { pref, setStyle, setNote, signedIn: Boolean(userId) };
}
