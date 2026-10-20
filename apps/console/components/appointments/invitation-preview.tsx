'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { InvitationPreview } from '@repo/core/appointments';
import { useToast } from '@/components/toast';
import { previewInvitationAction, sendInvitationAction } from '@/lib/appointment-actions';
import contactStyles from '@/components/contacts/contacts.module.css';
import styles from './appointments.module.css';

/** The words for each email the server decided this appointment needs (`contactNoticeFor`). */
const WORDS: Record<InvitationPreview['notice'], { preparing: string; send: string; sent: string; failed: string }> = {
  invitation: { preparing: 'Preparing the invitation…', send: 'Send invitation', sent: 'Invitation sent', failed: 'Invitation not delivered' },
  update: { preparing: 'Preparing the new details…', send: 'Send the new details', sent: 'New details sent', failed: 'New details not delivered' },
  cancellation: { preparing: 'Preparing the cancellation…', send: 'Send cancellation', sent: 'Cancellation sent', failed: 'Cancellation not delivered' },
};

/**
 * Exactly what will be emailed, and an explicit Send (ADR 0019): the
 * invitation, the new details of a moved appointment, or its cancellation.
 * Nothing is sent until the button is pressed; the server repeats every check,
 * the daily limits included, when it is.
 */
export function InvitationPreviewBox({ appointmentId, onDone }: { appointmentId: string; onDone: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    previewInvitationAction(appointmentId).then((r) => {
      if (!live) return;
      if (r.ok) setPreview(r.preview);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [appointmentId]);

  if (error) return <p className={contactStyles.error} role="alert">{error}</p>;
  if (!preview) return <p className={contactStyles.note}>Preparing the email…</p>;
  const words = WORDS[preview.notice];

  return (
    <div className={styles.preview}>
      <div className={styles.previewMeta}>
        To: {preview.to ? `${preview.to.name} <${preview.to.email}>` : '—'}
        <br />
        Subject: {preview.subject}
        <br />
        {preview.sendFrom}
      </div>
      <pre className={styles.previewBody}>{preview.body}</pre>
      <div className={styles.previewMeta}>
        Sent today: you {preview.limits.agentUsed} of {preview.limits.limits.perAgentDay}, the agency{' '}
        {preview.limits.agencyUsed} of {preview.limits.limits.perAgencyDay}.
      </div>
      {preview.problem ? <p className={contactStyles.error} role="alert">{preview.problem}</p> : null}
      <div className={contactStyles.actions}>
        <button
          type="button"
          className={contactStyles.btn}
          disabled={pending || Boolean(preview.problem)}
          onClick={() =>
            startTransition(async () => {
              const r = await sendInvitationAction(appointmentId);
              if (!r.ok) {
                setError(r.error);
                return;
              }
              if (r.status === 'sent') toast({ title: words.sent, variant: 'success' });
              else
                toast({
                  title: words.failed,
                  description: `${r.error ?? 'The email provider refused it.'} It is in the contact's Emails with a Retry.`,
                  variant: 'error',
                });
              onDone();
              router.refresh();
            })
          }
        >
          {pending ? 'Sending…' : words.send}
        </button>
        <button type="button" className={contactStyles.btnGhost} onClick={onDone} disabled={pending}>
          Don&apos;t send
        </button>
      </div>
    </div>
  );
}
