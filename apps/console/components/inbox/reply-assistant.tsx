'use client';

import { useState, useTransition } from 'react';
import { MAX_REPLY_INSTRUCTION, REPLY_TONE_LABELS, REPLY_TONES, type ReplyTone } from '@repo/core/mail/schema';
import { draftReplyAction, summarizeThreadAction, type SummaryResult } from '@/lib/reply-assist-actions';
import styles from './inbox.module.css';

/**
 * The assistant over the reply box (ADR 0062): "What's going on" and "Draft a reply", each only when its
 * button is pressed (the user's choice: a summary costs a model call, so it is never automatic). The
 * draft is handed to the composer, which the agent edits and sends. Every check is core's; this draws.
 */
export function ReplyAssistant({
  threadId,
  on,
  offMessage,
  busy,
  onDraft,
}: {
  threadId: string;
  on: boolean;
  offMessage: string | null;
  /** The composer is sending: hold still. */
  busy: boolean;
  onDraft: (body: string, bracketed: number) => void;
}) {
  const [summary, setSummary] = useState<Extract<SummaryResult, { ok: true }>['points'] | null>(null);
  const [tone, setTone] = useState<ReplyTone>('friendly');
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [drafted, setDrafted] = useState(false);
  const [summarizing, startSummary] = useTransition();
  const [drafting, startDraft] = useTransition();

  if (!on) {
    return (
      <section className={styles.assist} aria-label="Assistant">
        <div className={styles.assistHead}>
          <span className={styles.assistGlyph} aria-hidden>auto_awesome</span>Assistant
        </div>
        <p className={styles.assistNote}>{offMessage}</p>
      </section>
    );
  }

  const summarize = () =>
    startSummary(async () => {
      setError(null);
      const r = await summarizeThreadAction(threadId);
      if (r.ok) setSummary(r.points);
      else setError(r.error);
    });

  const draft = () =>
    startDraft(async () => {
      setError(null);
      const r = await draftReplyAction(threadId, tone, instruction);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDrafted(true);
      onDraft(r.body, r.bracketed);
    });

  const cites = (ns: number[]) => (ns.length === 1 ? `message ${ns[0]}` : `messages ${ns.join(', ')}`);

  return (
    <section className={styles.assist} aria-label="Assistant">
      <div className={styles.assistHead}>
        <span className={styles.assistGlyph} aria-hidden>auto_awesome</span>Assistant
        <span className={styles.assistTag}>Reads only this conversation · sends nothing</span>
      </div>
      <div className={styles.assistBody}>
        {summary ? (
          <div>
            <div className={styles.assistTitle}>What’s going on</div>
            <ul className={styles.points}>
              {summary.map((p, i) => (
                <li key={i}>
                  {p.text} <span className={styles.cite}>{cites(p.messages)}</span>
                </li>
              ))}
            </ul>
            <p className={styles.assistNote}>Written by the assistant from these messages — counted from the top of the conversation.</p>
          </div>
        ) : (
          <div>
            <button type="button" className={styles.assistGhost} disabled={summarizing || busy} onClick={summarize}>
              <span className={styles.assistGlyph} aria-hidden>notes</span>
              {summarizing ? 'Reading the conversation…' : 'Summarise this conversation'}
            </button>
          </div>
        )}

        <div className={styles.draftBar}>
          <span className={styles.assistTitle}>Draft a reply</span>
          <span role="group" aria-label="Tone" className={styles.tones}>
            {REPLY_TONES.map((t) => (
              <button key={t} type="button" className={`${styles.tone} ${tone === t ? styles.toneOn : ''}`} aria-pressed={tone === t} disabled={drafting} onClick={() => setTone(t)}>
                {REPLY_TONE_LABELS[t]}
              </button>
            ))}
          </span>
          <input
            className={styles.say}
            value={instruction}
            maxLength={MAX_REPLY_INSTRUCTION}
            disabled={drafting}
            placeholder="What should it say? e.g. offer Saturday 11 am (optional)"
            aria-label="What the reply should say"
            onChange={(e) => setInstruction(e.target.value)}
          />
          <button type="button" className={styles.assistButton} disabled={drafting || busy} onClick={draft}>
            <span className={styles.assistGlyph} aria-hidden>edit_note</span>
            {drafting ? 'Drafting…' : drafted ? 'Draft again' : 'Draft reply'}
          </button>
        </div>
        {error ? (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
