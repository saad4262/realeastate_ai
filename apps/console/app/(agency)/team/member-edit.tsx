'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useToast } from '@/components/toast';
import { editTeamMemberAction, withdrawInviteAction } from './actions';
import styles from './team.module.css';

type Details = {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phone: string;
  licenceNumber: string;
  /** YYYY-MM-DD or "". */
  licenceExpiry: string;
  territory: string;
  operationalRole: string;
};

type Target = { kind: 'member'; userId: string } | { kind: 'invite'; inviteId: string };

const ROLES = [
  ['senior', 'Senior agent'],
  ['principal', 'Principal (admin)'],
  ['pm', 'Property manager'],
  ['cadet', 'Cadet / assistant'],
  ['custom', 'Custom'],
] as const;

function suburbsOf(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Edit details / withdraw invite, in the dossier (ADR 0033). Sends only the
 * fields that changed; core decides everything else — an active member's
 * email, your own role and an owner's role are refused there with a sentence
 * shown here as it comes.
 */
export function MemberEdit({ target, initial, isOwner }: { target: Target; initial: Details; isOwner: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Details>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const isInvite = target.kind === 'invite';

  const set = (k: keyof Details) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function patch(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const text = ['firstName', 'lastName', 'displayName', 'phone', 'licenceNumber', 'operationalRole'] as const;
    for (const k of text) if (form[k].trim() !== initial[k].trim()) out[k] = form[k].trim();
    if (isInvite && form.email.trim().toLowerCase() !== initial.email.toLowerCase()) out.email = form.email.trim();
    if (form.licenceExpiry !== initial.licenceExpiry) out.licenceExpiry = form.licenceExpiry || null;
    if (suburbsOf(form.territory).join('|') !== suburbsOf(initial.territory).join('|')) out.territorySuburbs = suburbsOf(form.territory);
    return out;
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const p = patch();
    if (!Object.keys(p).length) {
      setOpen(false);
      return;
    }
    setError(null);
    start(async () => {
      const r = await editTeamMemberAction(target, p);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({
        variant: 'success',
        title: 'Details saved',
        description: r.claimPath
          ? r.emailed
            ? 'The new invite link was emailed to the new address. The old link no longer works.'
            : 'The old link no longer works. Copy the new one from Pending invites.'
          : undefined,
      });
      setOpen(false);
      router.refresh();
    });
  }

  function withdraw() {
    if (target.kind !== 'invite') return;
    if (!window.confirm(`Withdraw ${initial.displayName}’s invite? Their link will stop working.`)) return;
    start(async () => {
      const r = await withdrawInviteAction(target.inviteId);
      if (!r.ok) {
        toast({ variant: 'error', title: 'Not withdrawn', description: r.error });
        return;
      }
      toast({ variant: 'info', title: 'Invite withdrawn', duration: 3000 });
      router.push('/team');
      router.refresh();
    });
  }

  if (!open) {
    return (
      <p className={styles.editActions}>
        <button type="button" className={styles.ghostBtn} onClick={() => setOpen(true)}>
          Edit details
        </button>
        {isInvite ? (
          <button type="button" className={styles.ghostBtn} onClick={withdraw} disabled={pending}>
            Withdraw invite
          </button>
        ) : null}
      </p>
    );
  }

  return (
    <form className={styles.editForm} onSubmit={save}>
      <div className={styles.sectionLabel}>Edit details</div>
      <label className={styles.field}>
        <span>First name</span>
        <input className={styles.input} value={form.firstName} onChange={set('firstName')} />
      </label>
      <label className={styles.field}>
        <span>Last name</span>
        <input className={styles.input} value={form.lastName} onChange={set('lastName')} />
      </label>
      <label className={styles.field}>
        <span>Display name</span>
        <input className={styles.input} value={form.displayName} onChange={set('displayName')} />
      </label>
      <label className={styles.field}>
        <span>Email</span>
        <input className={styles.input} type="email" value={form.email} onChange={set('email')} disabled={!isInvite} />
        {!isInvite ? <small className={styles.smallMuted}>Their sign-in address — only they can change it.</small> : null}
      </label>
      <label className={styles.field}>
        <span>Phone</span>
        <input className={styles.input} value={form.phone} onChange={set('phone')} />
      </label>
      <label className={styles.field}>
        <span>Licence number</span>
        <input className={styles.input} value={form.licenceNumber} onChange={set('licenceNumber')} />
      </label>
      <label className={styles.field}>
        <span>Licence expiry</span>
        <input className={styles.input} type="date" value={form.licenceExpiry} onChange={set('licenceExpiry')} />
      </label>
      <label className={styles.field}>
        <span>Territory (suburbs, comma separated)</span>
        <input className={styles.input} value={form.territory} onChange={set('territory')} />
      </label>
      <label className={styles.field}>
        <span>Role</span>
        <select className={styles.input} value={form.operationalRole} onChange={set('operationalRole')} disabled={isOwner}>
          {!form.operationalRole ? <option value="">—</option> : null}
          {ROLES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {isOwner ? <small className={styles.smallMuted}>An owner’s role is not changed here.</small> : null}
      </label>
      {error ? (
        <p role="alert" className={styles.editError}>
          {error}
        </p>
      ) : null}
      <p className={styles.editActions}>
        <button type="submit" className={styles.btnPrimary} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className={styles.ghostBtn}
          onClick={() => {
            setForm(initial);
            setError(null);
            setOpen(false);
          }}
          disabled={pending}
        >
          Cancel
        </button>
      </p>
    </form>
  );
}
