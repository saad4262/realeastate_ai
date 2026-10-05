'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_REPLY_LENGTH, replyInputSchema } from '@repo/core/mail/schema';
import { useToast } from '@/components/toast';
import { sendReplyAction } from '@/lib/mail-actions';
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
}: {
  threadId: string;
  to: string;
  replyNote: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

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
      <textarea
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
        <span className={styles.note}>{replyNote}</span>
      </div>
    </form>
  );
}
