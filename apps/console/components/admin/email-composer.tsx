'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { previewPlatformEmailAction, sendPlatformEmailAction } from '@/lib/platform-actions';
import styles from './admin.module.css';

export type ComposerAudience = { kind: string; agencyId?: string | null; userId?: string | null };

const BROADCASTS: { kind: string; label: string }[] = [
  { kind: 'all_agencies', label: 'Every agency (owners and admins)' },
  { kind: 'all_agents', label: 'Every agent (all active members)' },
  { kind: 'all_users', label: 'Every public-site user' },
];

/**
 * Write an email from the platform team (ADR 0052). Two steps: "Check
 * recipients" counts who it reaches (the server decides who that is), then
 * Send asks once more. The first batch goes at once; the rest within a minute
 * or two. A promotion is not a service message — the note says so.
 */
export function EmailComposer({ target, targetLabel }: { target: ComposerAudience | null; targetLabel: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState(target?.kind ?? 'all_agencies');
  const audience: ComposerAudience = target ?? { kind };
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<{ count: number; sample: string[] } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const check = () =>
    start(async () => {
      setMessage(null);
      const r = await previewPlatformEmailAction(audience);
      if (r.ok) setPreview({ count: r.count, sample: r.sample });
      else setMessage({ ok: false, text: r.error });
    });

  const send = () => {
    if (!preview) return;
    if (!confirm(`Send “${subject}” to ${preview.count} ${preview.count === 1 ? 'person' : 'people'}? This cannot be undone.`)) return;
    start(async () => {
      setMessage(null);
      const r = await sendPlatformEmailAction(audience, { subject, body });
      if (r.ok) {
        const rest = r.recipients - r.sent - r.failed;
        setMessage({
          ok: r.failed === 0,
          text: `Sent to ${r.sent} of ${r.recipients}${r.failed ? `, ${r.failed} failed` : ''}${rest > 0 ? `; the other ${rest} go within a minute or two` : ''}.`,
        });
        setSubject('');
        setBody('');
        setPreview(null);
        router.refresh();
      } else {
        setMessage({ ok: false, text: r.error });
      }
    });
  };

  return (
    <section className={styles.card} aria-label="Write an email">
      <form
        className={styles.cardBody}
        onSubmit={(e) => {
          e.preventDefault();
          if (preview) send();
          else check();
        }}
      >
        <h2 className={styles.h2}>Write an email</h2>
        {target ? (
          <p className={styles.sub}>To: <strong>{targetLabel ?? 'the selected recipient'}</strong></p>
        ) : (
          <label className={styles.inline}>
            To
            <select
              className={styles.select}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPreview(null);
              }}
            >
              {BROADCASTS.map((b) => (
                <option key={b.kind} value={b.kind}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <input
          className={styles.input}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          aria-label="Subject"
          required
          minLength={3}
          maxLength={200}
        />
        <textarea
          className={styles.input}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message. Each person's name is added as a greeting; the platform's name and postal address are added as a footer."
          aria-label="Message"
          required
          minLength={10}
          maxLength={20000}
          rows={8}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
        />
        <p className={styles.muted} style={{ margin: 0, fontSize: '0.75rem' }}>
          For service messages about the platform. A promotion or offer is a commercial message under the Spam Act and
          needs the recipient’s consent and an unsubscribe link — do not send one from here.
        </p>
        {preview ? (
          <p className={styles.sub} role="status">
            Reaches <strong>{preview.count}</strong> {preview.count === 1 ? 'person' : 'people'}
            {preview.sample.length ? ` — ${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''}` : ''}.
          </p>
        ) : null}
        <div className={styles.filters}>
          {preview ? (
            <>
              <button type="submit" className={styles.btnDanger} disabled={pending || preview.count === 0}>
                Send to {preview.count}
              </button>
              <button type="button" className={styles.btn} disabled={pending} onClick={() => setPreview(null)}>
                Change
              </button>
            </>
          ) : (
            <button type="submit" className={styles.btn} disabled={pending}>
              Check recipients
            </button>
          )}
        </div>
        {message ? (
          <p role={message.ok ? 'status' : 'alert'} className={message.ok ? styles.ok : styles.alertInline}>
            {message.text}
          </p>
        ) : null}
      </form>
    </section>
  );
}
