'use client';

import { useState, useTransition } from 'react';
import { CONTACT_TAG_LIMITS } from '@repo/core/contacts/schema';
import { useToast } from '@/components/toast';
import { tagContactAction } from '@/lib/contact-actions';
import styles from './contacts.module.css';

/** ADR 0107: a contact's free tags — shown to everyone who sees them, added and removed by whoever may edit them. */
export function ContactTags({ contactId, tags, mayEdit }: { contactId: string; tags: string[]; mayEdit: boolean }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState('');
  const [pending, start] = useTransition();
  const run = (tag: string, on: boolean) =>
    start(async () => {
      const r = await tagContactAction(contactId, tag, on);
      if (!r.ok) toast({ title: on ? 'Tag not added' : 'Tag not removed', description: r.error, variant: 'error' });
      else if (on) setDraft('');
    });

  return (
    <span className={styles.chips}>
      {tags.length ? null : <span className={styles.muted}>None</span>}
      {tags.map((t) => (
        <span key={t} className={styles.chip}>
          {t}
          {mayEdit ? (
            <button type="button" className={styles.btnGhost} style={{ padding: '0 0.25rem', marginLeft: '0.25rem' }} disabled={pending} aria-label={`Remove the tag ${t}`} onClick={() => run(t, false)}>
              ×
            </button>
          ) : null}
        </span>
      ))}
      {mayEdit && tags.length < CONTACT_TAG_LIMITS.perContact ? (
        <form
          style={{ display: 'inline-flex', gap: '0.25rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) run(draft, true);
          }}
        >
          <input className={styles.input} style={{ width: '8rem' }} value={draft} maxLength={CONTACT_TAG_LIMITS.chars} placeholder="Add a tag" aria-label="Add a tag" onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={pending || !draft.trim()}>
            Add
          </button>
        </form>
      ) : null}
    </span>
  );
}
