'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { ActingDraftEvent } from '@repo/ai/chat-events';
import { acceptAutomationAction, acceptTaskAction, sendGuideMessageAction } from '../../lib/acting-actions';
import { Spinner } from '../../components/spinner';

type Draft = Omit<ActingDraftEvent, 'type' | 'toolUseId'>;

/**
 * The guide's C8 cards (ADR 0080, decision 12): a message the buyer edits and sends, or a task or an automation they
 * accept. Nothing has been sent or saved when this renders — the title and lines are the server's words; the button is
 * the first moment anything happens.
 */
export function ActingCard({ draft, signedIn }: { draft: Draft; signedIn: boolean }) {
  const [text, setText] = useState(draft.text ?? '');
  const [state, setState] = useState<'idle' | 'done' | 'dismissed'>('idle');
  const [href, setHref] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const box = 'my-2 max-w-[85%] rounded-2xl border border-line bg-card px-4 py-3 text-sm';

  if (state === 'dismissed') return <div className={`${box} text-ink-soft`}>{draft.kind === 'message' ? 'Not sent.' : 'Not started.'} Ask the guide again any time.</div>;
  if (state === 'done') {
    return (
      <div className={`${box} text-ink`}>
        {draft.kind === 'message' ? `Sent to ${draft.to}.` : draft.kind === 'task' ? 'Task started.' : 'Automation on.'}{' '}
        {href ? (
          <Link href={href} className="underline">
            {draft.kind === 'message' ? 'Your messages' : 'Open it'}
          </Link>
        ) : null}
      </div>
    );
  }

  const go = () =>
    start(async () => {
      setError(null);
      const r = draft.kind === 'message' ? await sendGuideMessageAction(draft.token, text) : draft.kind === 'task' ? await acceptTaskAction(draft.token) : await acceptAutomationAction(draft.token);
      if (r.ok) {
        setHref(r.href ?? null);
        setState('done');
      } else setError(r.error);
    });

  return (
    <div className={box}>
      <p className="m-0 font-semibold text-ink">{draft.kind === 'message' ? draft.title : draft.title}</p>
      {draft.lines.filter(Boolean).length ? (
        <ul className="m-0 mt-1 list-none p-0 text-ink-soft">
          {draft.lines.filter(Boolean).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      {draft.kind === 'message' ? (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} maxLength={1500} className="mt-2 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink" aria-label="Your message" />
          <p className="m-0 mt-1 text-xs text-ink-faint">From your account&rsquo;s name and email. Nothing goes until you press Send. Messages drafted by the guide today: {draft.sentToday ?? 0} of {draft.perDay ?? 5}.</p>
        </>
      ) : (
        <p className="m-0 mt-1 text-xs text-ink-faint">Nothing starts until you press Accept.</p>
      )}
      {error ? <p className="m-0 mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {signedIn ? (
          <button type="button" disabled={pending || (draft.kind === 'message' && text.trim().length < 10)} onClick={go} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 font-semibold text-brand-ink disabled:opacity-60">
            {pending ? <Spinner /> : null}
            {draft.kind === 'message' ? `Send to ${draft.to}` : 'Accept'}
          </button>
        ) : (
          <Link href="/login?next=/chat" className="rounded-full bg-brand px-4 py-1.5 font-semibold text-brand-ink">
            Sign in to {draft.kind === 'message' ? 'send' : 'accept'}
          </Link>
        )}
        <button type="button" onClick={() => setState('dismissed')} className="rounded-full border border-line bg-white px-4 py-1.5 text-ink">
          {draft.kind === 'message' ? "Don't send" : 'No thanks'}
        </button>
      </div>
    </div>
  );
}
