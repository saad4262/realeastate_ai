'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantEvent, AssistantFrame } from '@repo/core/assistant/schema';
import type { ConversationSummary } from '@repo/core/assistant';
import { getAssistantConversationAction, listAssistantConversationsAction } from '@/lib/assistant-actions';
import styles from './assistant-panel.module.css';

/**
 * The console assistant (docs/adr/0025, Phase A): a launcher and a right-hand
 * panel, the same component on both surfaces. It only READS in this phase.
 *
 * Everything listed beside an answer is a frame the server built from SQL —
 * names, dates, counts and links never come from the model's prose. The
 * model's words are labelled as the assistant's (#7 scope: they reach only
 * the person who asked).
 */

type Surface = 'agent' | 'agency';

type Turn = {
  key: string;
  userText: string;
  answer: string;
  frames: AssistantFrame[];
  status: string | null;
  error: string | null;
  pending: boolean;
};

const PATHS: Record<Surface, { contact: string; leads: string; templates: string; integrations: string }> = {
  agency: { contact: '/customers', leads: '/leads', templates: '/bulk-email/templates', integrations: '/settings/integrations' },
  agent: { contact: '/my-contacts', leads: '/my-leads', templates: '/my-bulk-email/templates', integrations: '/my-integrations' },
};

const CONTACT_PAGE = /^\/(?:customers|my-contacts)\/([0-9a-f-]{36})(?:\/|$)/i;

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
  } catch {
    return 'Australia/Sydney';
  }
}

export function AssistantPanel({ surface }: { surface: Surface }) {
  const pathname = usePathname();
  const onContact = CONTACT_PAGE.exec(pathname ?? '')?.[1] ?? null;

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [useSelection, setUseSelection] = useState(true);
  const [history, setHistory] = useState<ConversationSummary[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setUseSelection(true), [onContact]);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [turns]);

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
          ...(onContact && useSelection ? { selection: { contactIds: [onContact] } } : {}),
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
  }, [busy, conversationId, draft, onContact, useSelection]);

  const startNew = () => {
    abortRef.current?.abort();
    setTurns([]);
    setConversationId(null);
    setFull(false);
    setHistory(null);
  };

  const showHistory = async () => {
    setHistory(await listAssistantConversationsAction().catch(() => []));
  };

  const openConversation = async (id: string) => {
    const r = await getAssistantConversationAction(id);
    setHistory(null);
    if (!r.ok) return;
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
  };

  if (!open) {
    return (
      <button type="button" className={styles.launcher} onClick={() => setOpen(true)} aria-label="Open the assistant">
        <span className={styles.launcherDot} aria-hidden />
        Assistant
      </button>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Assistant">
      <header className={styles.head}>
        <div>
          <div className={styles.title}>Assistant</div>
          <div className={styles.sub}>Looks things up for you. It can’t send or change anything yet.</div>
        </div>
        <div className={styles.headActions}>
          <button type="button" className={styles.ghost} onClick={showHistory} disabled={busy}>
            History
          </button>
          <button type="button" className={styles.ghost} onClick={startNew}>
            New
          </button>
          <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close the assistant">
            ×
          </button>
        </div>
      </header>

      {history ? (
        <div className={styles.history}>
          <div className={styles.historyHead}>
            Your conversations <span className={styles.muted}>(kept 30 days, only you can see them)</span>
          </div>
          {history.length === 0 ? <p className={styles.muted}>None yet.</p> : null}
          {history.map((c) => (
            <button key={c.id} type="button" className={styles.historyRow} onClick={() => openConversation(c.id)}>
              <span>{c.title}</span>
              <span className={styles.muted}>{new Date(c.lastTurnAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</span>
            </button>
          ))}
          <button type="button" className={styles.ghost} onClick={() => setHistory(null)}>
            Back
          </button>
        </div>
      ) : (
        <div className={styles.thread}>
          {turns.length === 0 ? (
            <div className={styles.empty}>
              <p>Ask about your own work, for example:</p>
              <ul>
                <li>“Which leads came in this week?”</li>
                <li>“What’s on my calendar tomorrow?”</li>
                <li>“Is my Google Calendar connected?”</li>
              </ul>
            </div>
          ) : null}
          {turns.map((t) => (
            <div key={t.key} className={styles.turn}>
              <div className={styles.you}>{t.userText}</div>
              {t.answer ? (
                <div className={styles.answer}>
                  <div className={styles.label}>Written by the assistant</div>
                  {t.answer}
                </div>
              ) : null}
              {t.frames.map((f, i) => (
                <FrameView key={i} frame={f} surface={surface} />
              ))}
              {t.pending && !t.error ? <div className={styles.status}>{t.status ?? 'Thinking…'}</div> : null}
              {t.error ? (
                <div className={styles.error} role="alert">
                  {t.error}
                </div>
              ) : null}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      <footer className={styles.foot}>
        {onContact && useSelection ? (
          <div className={styles.chip}>
            Using this contact
            <button type="button" onClick={() => setUseSelection(false)} aria-label="Don’t use this contact">
              ×
            </button>
          </div>
        ) : null}
        {full ? <p className={styles.muted}>This conversation is full — start a new one.</p> : null}
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            className={styles.input}
            value={draft}
            maxLength={2000}
            rows={2}
            placeholder="Ask the assistant…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={full}
          />
          {busy ? (
            <button type="button" className={styles.send} onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className={styles.send} disabled={!draft.trim() || full}>
              Send
            </button>
          )}
        </form>
      </footer>
    </aside>
  );
}

function FrameView({ frame, surface }: { frame: AssistantFrame; surface: Surface }) {
  const p = PATHS[surface];
  switch (frame.kind) {
    case 'contacts':
      return (
        <FrameBox title="Contacts" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              <Link href={`${p.contact}/${r.id}`}>{r.name}</Link>
              <span className={styles.meta}>
                {[r.roles.join(', '), r.assigneeName ? `assigned to ${r.assigneeName}` : 'unassigned', r.archived ? 'archived' : ''].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </FrameBox>
      );
    case 'leads':
      return (
        <FrameBox title="Leads" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              {r.contactId ? <Link href={`${p.contact}/${r.contactId}`}>{r.name}</Link> : <Link href={p.leads}>{r.name}</Link>}
              <span className={styles.meta}>
                {r.address} · {r.status} · {r.received}
              </span>
            </li>
          ))}
        </FrameBox>
      );
    case 'appointments':
      return (
        <FrameBox title="Appointments" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              <Link href={`${p.contact}/${r.contactId}`}>{r.title}</Link>
              <span className={styles.meta}>
                {r.when} · {r.contactName} · {r.status}
              </span>
            </li>
          ))}
        </FrameBox>
      );
    case 'templates':
      return (
        <FrameBox title="Approved templates" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              <Link href={`${p.templates}/${r.id}`}>{r.name}</Link>
              <span className={styles.meta}>{r.subject}</span>
            </li>
          ))}
        </FrameBox>
      );
    case 'connections':
      return (
        <FrameBox title="Connected accounts">
          {frame.rows.map((r) => (
            <li key={r.provider}>
              <span>{r.label}</span>
              <span className={styles.meta}>
                {r.state === 'connected' ? `Connected${r.whose === 'agency' ? ' (agency)' : ''}` : (
                  <>
                    Not usable ({r.state.replace('_', ' ')}) — <Link href={p.integrations}>Connect {r.label} first</Link>
                  </>
                )}
              </span>
            </li>
          ))}
        </FrameBox>
      );
  }
}

function FrameBox({ title, total, shown, children }: { title: string; total?: number; shown?: number; children: React.ReactNode }) {
  return (
    <div className={styles.frame}>
      <div className={styles.frameHead}>
        {title}
        {total !== undefined ? (
          <span className={styles.muted}>
            {' '}
            · {shown !== undefined && shown < total ? `${shown} of ${total}` : total}
          </span>
        ) : null}
      </div>
      {shown === 0 ? <p className={styles.muted}>Nothing found.</p> : <ul className={styles.list}>{children}</ul>}
    </div>
  );
}
