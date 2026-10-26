'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CONTACT_PROPERTY_RELATION_LABELS,
  CONTACT_PROPERTY_RELATIONS,
  MAX_NOTE_LENGTH,
  noteBodySchema,
  type ContactPropertyRelation,
} from '@repo/core/contacts/schema';
import { useToast } from '@/components/toast';
import {
  createNoteAction,
  deleteNoteAction,
  linkPropertyAction,
  mergeContactsAction,
  searchPropertiesAction,
  setArchivedAction,
  setNextActionAction,
  unlinkPropertyAction,
  updateNoteAction,
  type SimpleResult,
} from '@/lib/contact-actions';
import styles from './contacts.module.css';

/**
 * The contact profile's small client islands (ADR 0018). Each is drawn only
 * when a `may…` flag from can() says so; each action re-checks on the server.
 * None of them looks at a role (#2).
 */

/**
 * An instant as a `datetime-local` value, in the BROWSER's zone. Done after
 * mount, never on the server: a server in UTC (Vercel) would otherwise fill the
 * box ten hours off for an agent in Melbourne, and saving would shift it.
 */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Run an action, toast a refusal, refresh the server-rendered page on success. */
export function useRun() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<SimpleResult>, success?: string, after?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast({ title: 'Not saved', description: result.error, variant: 'error' });
        return;
      }
      if (success) toast({ title: success, variant: 'success' });
      after?.();
      router.refresh();
    });
  return { pending, run };
}

export function NextActionForm({
  contactId,
  nextAction,
  nextActionAtIso,
}: {
  contactId: string;
  nextAction: string;
  /** The due instant, or null. Shown in the browser's own zone. */
  nextActionAtIso: string | null;
}) {
  const { pending, run } = useRun();
  const [text, setText] = useState(nextAction);
  const [savedWhen, setSavedWhen] = useState('');
  const [when, setWhen] = useState('');
  useEffect(() => {
    const local = toLocalInput(nextActionAtIso);
    setSavedWhen(local);
    setWhen(local);
  }, [nextActionAtIso]);
  const dirty = text !== nextAction || when !== savedWhen;

  return (
    <form
      className={styles.inlineForm}
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            setNextActionAction(contactId, {
              nextAction: text,
              nextActionAt: when ? new Date(when).toISOString() : '',
            }),
          'Next action saved',
        );
      }}
    >
      <input
        className={styles.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={300}
        placeholder="What should happen next?"
        aria-label="Next action"
      />
      <input
        className={styles.input}
        style={{ minWidth: 0, flex: '0 1 14rem' }}
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        aria-label="Due"
      />
      <button type="submit" className={styles.btn} disabled={pending || !dirty}>
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

export function ArchiveButton({ contactId, archived }: { contactId: string; archived: boolean }) {
  const { pending, run } = useRun();
  return (
    <button
      type="button"
      className={styles.btnGhost}
      disabled={pending}
      onClick={() => {
        if (!archived && !window.confirm('Archive this contact? They disappear from the directory until restored. Nothing is deleted.')) return;
        run(() => setArchivedAction(contactId, !archived), archived ? 'Restored' : 'Archived');
      }}
    >
      {archived ? 'Restore' : 'Archive'}
    </button>
  );
}

/** Merge `duplicateId` into the contact being viewed. */
export function MergeButton({
  survivorId,
  duplicateId,
  duplicateName,
}: {
  survivorId: string;
  duplicateId: string;
  duplicateName: string;
}) {
  const { pending, run } = useRun();
  return (
    <button
      type="button"
      className={styles.btnSmall}
      disabled={pending}
      onClick={() => {
        if (
          !window.confirm(
            `Merge ${duplicateName} into this contact?\n\nTheir enquiries, emails, notes and history move here. Their record is kept but hidden. This cannot be undone from the screen.`,
          )
        )
          return;
        run(() => mergeContactsAction(survivorId, duplicateId), 'Merged');
      }}
    >
      {pending ? 'Merging…' : 'Merge into this contact'}
    </button>
  );
}

/** The private tick, worded the same in both places it appears. */
function PrivateTick({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.check} title="Only the agency's admins and you will see it">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Private (admins only)
    </label>
  );
}

export function NoteComposer({ contactId }: { contactId: string }) {
  const { pending, run } = useRun();
  const [body, setBody] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={styles.noteForm}
      onSubmit={(e) => {
        e.preventDefault();
        const check = noteBodySchema.safeParse(body);
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Write something first');
          return;
        }
        setError(null);
        run(() => createNoteAction(contactId, body, isPrivate), 'Note added', () => {
          setBody('');
          setPrivate(false);
        });
      }}
    >
      <textarea
        className={styles.textarea}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={MAX_NOTE_LENGTH}
        rows={3}
        placeholder="Write a note — what you talked about, what they want, what to remember."
        aria-label="New note"
      />
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions} style={{ alignItems: 'center' }}>
        <button type="submit" className={styles.btn} disabled={pending || !body.trim()}>
          {pending ? 'Saving…' : 'Add note'}
        </button>
        <PrivateTick checked={isPrivate} onChange={setPrivate} />
      </div>
    </form>
  );
}

export function NoteControls({ noteId, body, isPrivate }: { noteId: string; body: string; isPrivate: boolean }) {
  const { pending, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  const [priv, setPriv] = useState(isPrivate);
  if (editing) {
    return (
      <form
        className={styles.noteForm}
        onSubmit={(e) => {
          e.preventDefault();
          run(() => updateNoteAction(noteId, text, priv), 'Note saved', () => setEditing(false));
        }}
      >
        <textarea
          className={styles.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_NOTE_LENGTH}
          rows={3}
          aria-label="Edit note"
        />
        <div className={styles.actions}>
          <button type="submit" className={styles.btn} disabled={pending || !text.trim()}>Save</button>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => {
              setText(body);
              setPriv(isPrivate);
              setEditing(false);
            }}
          >
            Cancel
          </button>
          <PrivateTick checked={priv} onChange={setPriv} />
        </div>
      </form>
    );
  }
  return (
    <span className={styles.noteActions}>
      <button type="button" className={styles.linkBtn} onClick={() => setEditing(true)}>Edit</button>
      <button
        type="button"
        className={styles.linkBtn}
        disabled={pending}
        onClick={() => {
          if (window.confirm('Delete this note?')) run(() => deleteNoteAction(noteId), 'Note deleted');
        }}
      >
        Delete
      </button>
    </span>
  );
}

export function PropertyLinker({ contactId }: { contactId: string }) {
  const { pending, run } = useRun();
  const [q, setQ] = useState('');
  const [searching, startSearch] = useTransition();
  const [matches, setMatches] = useState<{ propertyId: string; address: string }[] | null>(null);
  const [relation, setRelation] = useState<ContactPropertyRelation>('owner');

  return (
    <div className={styles.linker}>
      <form
        className={styles.inlineForm}
        onSubmit={(e) => {
          e.preventDefault();
          startSearch(async () => setMatches(await searchPropertiesAction(q)));
        }}
      >
        <input
          className={styles.input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find an address your agency has listed or been asked about"
          aria-label="Search addresses"
        />
        <select
          className={styles.select}
          value={relation}
          onChange={(e) => setRelation(e.target.value as ContactPropertyRelation)}
          aria-label="They are the…"
        >
          {CONTACT_PROPERTY_RELATIONS.map((r) => (
            <option key={r} value={r}>{CONTACT_PROPERTY_RELATION_LABELS[r]}</option>
          ))}
        </select>
        <button type="submit" className={styles.btnGhost} disabled={searching || q.trim().length < 2}>
          {searching ? 'Searching…' : 'Find'}
        </button>
      </form>
      {matches !== null ? (
        matches.length === 0 ? (
          <p className={styles.note}>No address your agency knows matches that.</p>
        ) : (
          <ul className={styles.plainList}>
            {matches.map((m) => (
              <li key={m.propertyId} className={styles.plainItem}>
                <span>{m.address}</span>
                <button
                  type="button"
                  className={styles.btnSmall}
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => linkPropertyAction(contactId, { propertyId: m.propertyId, relation }),
                      'Property linked',
                      () => setMatches(null),
                    )
                  }
                >
                  Link as {CONTACT_PROPERTY_RELATION_LABELS[relation]}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

export function UnlinkButton({ contactId, linkId }: { contactId: string; linkId: string }) {
  const { pending, run } = useRun();
  return (
    <button
      type="button"
      className={styles.linkBtn}
      disabled={pending}
      aria-label="Remove this link"
      onClick={() => run(() => unlinkPropertyAction(contactId, linkId), 'Link removed')}
    >
      ✕
    </button>
  );
}
