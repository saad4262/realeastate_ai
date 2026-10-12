'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_REPLY_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TEAM_RECIPIENTS,
  replyInputSchema,
  teamMessageStartSchema,
} from '@repo/core/mail/schema';
import { useToast } from '@/components/toast';
import { markTeamThreadReadAction, replyTeamMessageAction, startTeamMessageAction } from '@/lib/team-message-actions';
import inbox from '../inbox/inbox.module.css';
import styles from './team-messages.module.css';

/** Marks the open conversation read once it is on screen (never on a prefetch). */
export function TeamMarkRead({ threadId, unread }: { threadId: string; unread: boolean }) {
  const router = useRouter();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (done.current === threadId) return;
    done.current = threadId;
    void markTeamThreadReadAction(threadId).then((r) => {
      if (r.ok && unread) router.refresh();
    });
  }, [threadId, unread, router]);
  return null;
}

/** The reply box on a team conversation. Cleared only once the server recorded it. */
export function TeamReply({ threadId, to }: { threadId: string; to: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const parsed = replyInputSchema.safeParse({ body });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Write a message first');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await replyTeamMessageAction(threadId, parsed.data.body);
      if (!result.ok) {
        setError(result.error);
        toast({ variant: 'error', title: 'Not sent', description: result.error });
        return;
      }
      setBody('');
      toast({ variant: 'success', title: 'Sent', description: `${to} will see it here and by email.` });
      router.refresh();
    });
  }

  return (
    <form
      className={inbox.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className={inbox.label} htmlFor={`team-reply-${threadId}`}>
        To: {to}
      </label>
      <textarea
        id={`team-reply-${threadId}`}
        className={inbox.textarea}
        value={body}
        maxLength={MAX_REPLY_LENGTH}
        disabled={pending}
        placeholder="Write your reply…  (⌘/Ctrl + Enter to send)"
        aria-invalid={error ? true : undefined}
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
        <p className={inbox.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={inbox.composerFoot}>
        <button type="submit" className={inbox.send} disabled={pending}>
          {pending ? 'Sending…' : 'Send'}
        </button>
        <span className={inbox.note}>Only the people on this conversation can read it.</span>
      </div>
    </form>
  );
}

/** A new team conversation: tick the colleagues, a subject, the message. */
export function NewTeamMessage({
  colleagues,
  basePath,
  preselected = [],
}: {
  colleagues: { userId: string; name: string; email: string; roleLabel: string }[];
  basePath: string;
  preselected?: string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [to, setTo] = useState<string[]>(preselected.filter((id) => colleagues.some((c) => c.userId === id)));
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setTo((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    if (error) setError(null);
  }

  function submit() {
    const parsed = teamMessageStartSchema.safeParse({ to, subject, body });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Choose who to write to, a subject and a message');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await startTeamMessageAction(parsed.data.to, parsed.data.subject, parsed.data.body);
      if (!result.ok) {
        setError(result.error);
        toast({ variant: 'error', title: 'Not sent', description: result.error });
        return;
      }
      toast({ variant: 'success', title: 'Sent', description: 'They will see it in Team messages and by email.' });
      router.push(`${basePath}?thread=${result.threadId}`);
    });
  }

  return (
    <form
      className={inbox.composeCard}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className={styles.people} disabled={pending}>
        <legend className={inbox.label}>
          To <span className={styles.hint}>(up to {MAX_TEAM_RECIPIENTS})</span>
        </legend>
        {colleagues.length === 0 ? (
          <p className={styles.hint}>Nobody else is in the agency yet.</p>
        ) : (
          <ul className={styles.peopleList}>
            {colleagues.map((c) => (
              <li key={c.userId}>
                <label className={`${styles.person} ${to.includes(c.userId) ? styles.personOn : ''}`}>
                  <input type="checkbox" checked={to.includes(c.userId)} onChange={() => toggle(c.userId)} />
                  <span>
                    {c.name}
                    <span className={styles.personSub}>
                      {c.roleLabel} · {c.email}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div>
        <label className={inbox.label} htmlFor="team-subject">
          Subject
        </label>
        <input
          id="team-subject"
          className={inbox.input}
          value={subject}
          maxLength={MAX_SUBJECT_LENGTH}
          disabled={pending}
          autoComplete="off"
          onChange={(event) => {
            setSubject(event.target.value);
            if (error) setError(null);
          }}
        />
      </div>
      <div className={inbox.composer} style={{ margin: 0 }}>
        <label className={inbox.label} htmlFor="team-body">
          Message
        </label>
        <textarea
          id="team-body"
          className={inbox.textarea}
          value={body}
          maxLength={MAX_REPLY_LENGTH}
          disabled={pending}
          placeholder="Write your message…  (⌘/Ctrl + Enter to send)"
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
          <p className={inbox.fieldError} role="alert">
            {error}
          </p>
        ) : null}
        <div className={inbox.composerFoot}>
          <button type="submit" className={inbox.send} disabled={pending}>
            {pending ? 'Sending…' : 'Send'}
          </button>
          <span className={inbox.note}>They see it here and get it by email. Only the people on it can read it.</span>
        </div>
      </div>
    </form>
  );
}
