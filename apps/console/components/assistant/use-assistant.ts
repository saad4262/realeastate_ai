'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantEvent, AssistantFrame } from '@repo/core/assistant/schema';
import { getAssistantConversationAction } from '@/lib/assistant-actions';
import { usePicks } from './picks';

/**
 * The assistant's conversation state and its one door to the server — the
 * state behind both consoles' assistant home (assistant-home.tsx).
 *
 * Moved here unchanged from the old floating panel, so the stream reader, the
 * selection rule and the limit handling exist once.
 */

export type Turn = {
  key: string;
  userText: string;
  answer: string;
  frames: AssistantFrame[];
  status: string | null;
  error: string | null;
  pending: boolean;
};

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
  } catch {
    return 'Australia/Sydney';
  }
}

/** `contactId`: the contact page the assistant is being used on, if any. */
export function useAssistant({ contactId }: { contactId: string | null }) {
  // Contacts picked in the directory win over the page the panel was opened on.
  const picks = usePicks();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [useSelection, setUseSelection] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  /** Bumped by every open and every New, so a slow load cannot land over a newer choice. */
  const loadSeq = useRef(0);

  useEffect(() => setUseSelection(true), [contactId]);
  // A block body on purpose: Chrome's scrollIntoView() now returns a Promise, and an effect that
  // returns anything but a function makes production React throw "x is not a function" on cleanup.
  useEffect(() => {
    void endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  const update = (key: string, fn: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.key === key ? fn(t) : t)));

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;
    const key = `${Date.now()}`;
    setDraft('');
    setBusy(true);
    setTurns((all) => [...all, { key, userText: message, answer: '', frames: [], status: null, error: null, pending: true }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
          message,
          timeZone: browserZone(),
          ...(picks.length
            ? { selection: { contactIds: picks.map((p) => p.id) } }
            : contactId && useSelection
              ? { selection: { contactIds: [contactId] } }
              : {}),
        }),
      });
      if (!res.body || !(res.headers.get('content-type') ?? '').includes('ndjson')) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        update(key, (t) => ({ ...t, error: body?.error ?? 'The assistant is unavailable right now.' }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as AssistantEvent;
          if (e.type === 'turn') setConversationId(e.conversationId);
          else if (e.type === 'text') update(key, (t) => ({ ...t, answer: t.answer + e.delta, status: null }));
          else if (e.type === 'status') update(key, (t) => ({ ...t, status: e.label }));
          else if (e.type === 'results') update(key, (t) => ({ ...t, frames: [...t.frames, e.frame] }));
          else if (e.type === 'error') {
            update(key, (t) => ({ ...t, error: e.message }));
            if (e.code === 'limit') setFull(true);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') update(key, (t) => ({ ...t, error: 'The connection dropped. Please try again.' }));
    } finally {
      update(key, (t) => ({ ...t, pending: false, status: null }));
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, conversationId, draft, contactId, useSelection, picks]);

  const stop = () => abortRef.current?.abort();

  const startNew = () => {
    loadSeq.current += 1;
    abortRef.current?.abort();
    setTurns([]);
    setConversationId(null);
    setFull(false);
  };

  /**
   * Resolves `false` when the conversation is gone or not this person's, and
   * `null` when something newer was chosen while it loaded (and nothing changed).
   */
  const openConversation = async (id: string): Promise<boolean | null> => {
    const seq = ++loadSeq.current;
    const r = await getAssistantConversationAction(id);
    if (seq !== loadSeq.current) return null;
    if (!r.ok) return false;
    setConversationId(r.conversation.id);
    setFull(r.conversation.full);
    setTurns(
      r.conversation.turns.map((t) => ({
        key: `${id}-${t.seq}`,
        userText: t.userText,
        answer: t.answer,
        frames: t.frames,
        status: null,
        error: t.status === 'failed' ? (t.error ?? 'This answer did not finish.') : null,
        pending: false,
      })),
    );
    return true;
  };

  return {
    picks,
    turns,
    conversationId,
    full,
    draft,
    setDraft,
    busy,
    useSelection,
    setUseSelection,
    endRef,
    send,
    stop,
    startNew,
    openConversation,
  };
}
