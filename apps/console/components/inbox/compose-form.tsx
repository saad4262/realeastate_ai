'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { composeInputSchema, MAX_REPLY_LENGTH, MAX_SUBJECT_LENGTH } from '@repo/core/mail/schema';
import { useToast } from '@/components/toast';
import { sendNewEmailAction } from '@/lib/mail-actions';
import styles from './inbox.module.css';

/**
 * A new email to one contact (ADR 0035 §1). The same zod contract the server
 * enforces refuses an empty subject or body before a round trip; the server
 * checks everything again. On Send the conversation opens — sent, or marked
 * with a Retry when the provider refused it.
 */
export function ComposeForm({ contactId, to, inboxPath }: { contactId: string; to: string; inboxPath: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const parsed = composeInputSchema.safeParse({ subject, body });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Write a subject and a message');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await sendNewEmailAction(contactId, parsed.data.subject, parsed.data.body);
      if (!result.ok) {
        setError(result.error);
        toast({ variant: 'error', title: 'Not sent', description: result.error });
        return;
      }
      if (result.status === 'sent') {
        toast({ variant: 'success', title: 'Sent', description: `Your email is on its way to ${to}.` });
      } else {
        toast({ variant: 'warning', title: 'Saved, but not sent', description: result.error ?? 'It is marked in the conversation with a retry.' });
      }
      router.push(`${inboxPath}?thread=${result.threadId}`);
    });
  }

  return (
    <form
      className={styles.composeBox}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className={styles.label} htmlFor="compose-subject">
        Subject
      </label>
      <input
        id="compose-subject"
        className={styles.input}
        value={subject}
        maxLength={MAX_SUBJECT_LENGTH}
        disabled={pending}
        autoComplete="off"
        onChange={(event) => {
          setSubject(event.target.value);
          if (error) setError(null);
        }}
      />
      <div className={styles.composer} style={{ margin: '0.9rem 0 0' }}>
        <label className={styles.label} htmlFor="compose-body">
          Message
        </label>
        <textarea
          id="compose-body"
          className={styles.textarea}
          value={body}
          maxLength={MAX_REPLY_LENGTH}
          disabled={pending}
          placeholder="Write your email…  (⌘/Ctrl + Enter to send)"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'compose-error' : undefined}
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
          <p id="compose-error" className={styles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.composerFoot}>
          <button type="submit" className={styles.send} disabled={pending}>
            {pending ? 'Sending…' : 'Send'}
          </button>
          <span className={styles.note}>Signed with your name and the agency’s. Their reply comes back to this inbox.</span>
        </div>
      </div>
    </form>
  );
}
