'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_REPLY_LENGTH, replyInputSchema } from '@repo/core/mail/schema';
import { useToast } from '@/components/toast';
import { sendReplyAction } from '@/lib/mail-actions';
import { ReplyAssistant } from './reply-assistant';
import styles from './inbox.module.css';

/**
 * The reply box — the only part of the reader that needs the browser.
 *
 * It imports the same zod schema the server enforces (ARCHITECTURE § 7), so an
 * empty message is refused before a round trip; the server checks again
 * regardless. The text is cleared only once the server has RECORDED the
 * message: a refusal leaves what was typed in place.
 *
 * ⌘/Ctrl + Enter sends, as in every mail client.
 */
export function Composer({
  threadId,
  to,
  /** Shown under the box: where a reply to this email will land. */
  replyNote,
  /** "Sent from your Gmail (…)" / "Sent from LocalAgentHub — connect your Gmail…" (ADR 0026 §2). */
  sendFrom = null,
  /** ADR 0062: the assistant over the box — absent when this server or page does not offer it. */
  assist,
}: {
  threadId: string;
  to: string;
  replyNote: string;
  sendFrom?: string | null;
  assist?: { on: boolean; offMessage: string | null };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The box holds the assistant's draft: the banner says so until it is sent or discarded. */
  const [drafted, setDrafted] = useState<{ bracketed: number } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  function takeDraft(text: string, bracketed: number) {
    // Never over the agent's own words without asking.
    if (body.trim() && !drafted && !window.confirm('Replace what you have written with the assistant’s draft?')) return;
    setBody(text.slice(0, MAX_REPLY_LENGTH));
    setDrafted({ bracketed });
    setError(null);
    boxRef.current?.focus();
  }

  function submit() {
    const parsed = replyInputSchema.safeParse({ body });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Write a message first');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await sendReplyAction(threadId, parsed.data.body);
      if (!result.ok) {
        setError(result.error);
        toast({ variant: 'error', title: 'Not sent', description: result.error });
        return;
      }
      // Recorded either way; a failed send is now a marked message with a retry.
      setBody('');
      setDrafted(null);
      if (result.status === 'sent') {
        toast({ variant: 'success', title: 'Sent', description: `Your reply is on its way to ${to}.` });
      } else {
        toast({
          variant: 'warning',
          title: 'Saved, but not sent',
          description: 'The email provider refused it. It is marked in the conversation with a retry.',
        });
      }
      router.refresh();
    });
  }

  return (
    <>
    {assist ? <ReplyAssistant threadId={threadId} on={assist.on} offMessage={assist.offMessage} busy={pending} onDraft={takeDraft} /> : null}
    <form
      ref={formRef}
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className={styles.label} htmlFor={`reply-${threadId}`}>
        To: {to}
      </label>
      {drafted ? (
        <p className={styles.draftBanner} role="note">
          <strong>Drafted by the assistant — read it before you send.</strong> Anything the conversation doesn’t say is left in [brackets]
          for you to fill
          {drafted.bracketed ? `, including ${drafted.bracketed} figure${drafted.bracketed === 1 ? '' : 's'} it could not find in the conversation` : ''}.
          Edit freely; nothing is sent until you press Send.
        </p>
      ) : null}
      <textarea
        ref={boxRef}
        id={`reply-${threadId}`}
        className={styles.textarea}
        value={body}
        maxLength={MAX_REPLY_LENGTH}
        disabled={pending}
        placeholder="Write your reply…  (⌘/Ctrl + Enter to send)"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `reply-error-${threadId}` : undefined}
        onChange={(event) => {
          setBody(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {error ? (
        <p id={`reply-error-${threadId}`} className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.composerFoot}>
        <button type="submit" className={styles.send} disabled={pending}>
          {pending ? 'Sending…' : 'Send'}
        </button>
        {drafted ? (
          <button
            type="button"
            className={styles.discard}
            disabled={pending}
            onClick={() => {
              setBody('');
              setDrafted(null);
            }}
          >
            Discard draft
          </button>
        ) : null}
        <span className={styles.note}>
          {sendFrom ? <>{sendFrom}. </> : null}
          {replyNote}
        </span>
      </div>
    </form>
    </>
  );
}
