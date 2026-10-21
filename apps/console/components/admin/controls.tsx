'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  blockMemberAction,
  makeOwnerAction,
  reactivateAgencyAction,
  setAgencyPlanAction,
  suspendAgencyAction,
  unblockMemberAction,
  type PlatformActionResult,
} from '@/lib/platform-actions';
import styles from './admin.module.css';

/**
 * The admin console's controls (ADR 0050). Small forms; each asks before it
 * acts and refreshes the page after. Whether the change is allowed is decided
 * on the server (can('platform:manage') in core) — these only collect input.
 */

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const go = (label: string, fn: () => Promise<PlatformActionResult>) =>
    start(async () => {
      setMessage(null);
      const r = await fn();
      if (r.ok) {
        setMessage({ ok: true, text: label });
        router.refresh();
      } else {
        setMessage({ ok: false, text: r.error });
      }
    });
  return { pending, message, go };
}

function Message({ message }: { message: { ok: boolean; text: string } | null }) {
  if (!message) return null;
  return (
    <p role={message.ok ? 'status' : 'alert'} className={message.ok ? styles.ok : styles.alertInline}>
      {message.text}
    </p>
  );
}

export type ControlMember = { userId: string; name: string; role: string; status: string };

export function AgencyControls({
  agencyId,
  agencyName,
  status,
  plan,
  trialEndsAt,
  members,
}: {
  agencyId: string;
  agencyName: string;
  status: 'active' | 'trial' | 'suspended';
  plan: string | null;
  /** yyyy-mm-dd or null. */
  trialEndsAt: string | null;
  /** Active members who are not owners — who could be made owner. */
  members: ControlMember[];
}) {
  const suspended = status === 'suspended';
  const a = useAction();
  const [reason, setReason] = useState('');
  const [planName, setPlanName] = useState(plan ?? '');
  const [planStatus, setPlanStatus] = useState<'active' | 'trial'>(status === 'trial' ? 'trial' : 'active');
  const [trialEnd, setTrialEnd] = useState(trialEndsAt ?? '');
  const [newOwner, setNewOwner] = useState('');
  const [demote, setDemote] = useState(true);

  return (
    <section className={styles.card} aria-label="Controls">
      <div className={styles.cardBody}>
        <h2 className={styles.h2}>Controls</h2>
        <p className={styles.sub}>Changes here take effect at once and are recorded under “Changes by the platform”.</p>

        <div className={styles.controlRow}>
          <h3 className={styles.h3}>Account status</h3>
          {suspended ? (
            <div className={styles.filters}>
              <button
                type="button"
                className={styles.btn}
                disabled={a.pending}
                onClick={() => {
                  if (confirm(`Reactivate ${agencyName}? Its members can sign in again and its live listings return to the public site.`)) {
                    a.go('Reactivated.', () => reactivateAgencyAction(agencyId, 'active'));
                  }
                }}
              >
                Reactivate as active
              </button>
              <button
                type="button"
                className={styles.btn}
                disabled={a.pending}
                onClick={() => {
                  if (confirm(`Reactivate ${agencyName} on a trial?`)) a.go('Reactivated on a trial.', () => reactivateAgencyAction(agencyId, 'trial'));
                }}
              >
                Reactivate as trial
              </button>
            </div>
          ) : (
            <form
              className={styles.filters}
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  confirm(
                    `Suspend ${agencyName}?\n\nNobody in it can use the console, its listings leave the public site, and its workflows, skills, scheduled steps, imports and bulk email wait. Nothing is deleted; you can reactivate it.`,
                  )
                ) {
                  a.go('Suspended.', () => suspendAgencyAction(agencyId, reason));
                }
              }}
            >
              <input
                className={styles.input}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why (kept with the change)"
                aria-label="Reason for suspending"
                required
                minLength={3}
                maxLength={500}
              />
              <button type="submit" className={styles.btnDanger} disabled={a.pending}>
                Suspend agency
              </button>
            </form>
          )}
        </div>

        <form
          className={styles.controlRow}
          onSubmit={(e) => {
            e.preventDefault();
            a.go('Plan saved.', () => setAgencyPlanAction(agencyId, { plan: planName, status: planStatus, trialEndsAt: planStatus === 'trial' && trialEnd ? trialEnd : null }));
          }}
        >
          <h3 className={styles.h3}>Plan</h3>
          <div className={styles.filters}>
            <input
              className={styles.input}
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              list="platform-plans"
              placeholder="Plan name"
              aria-label="Plan"
              required
              maxLength={64}
            />
            <datalist id="platform-plans">
              <option value="trial" />
              <option value="starter" />
              <option value="pro" />
              <option value="enterprise" />
            </datalist>
            <select className={styles.select} value={planStatus} onChange={(e) => setPlanStatus(e.target.value as 'active' | 'trial')} aria-label="Active or trial" disabled={suspended}>
              <option value="active">Active (paying)</option>
              <option value="trial">Trial</option>
            </select>
            {planStatus === 'trial' ? (
              <label className={styles.inline}>
                Trial ends
                <input className={styles.select} type="date" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />
              </label>
            ) : null}
            <button type="submit" className={styles.btn} disabled={a.pending}>
              Save plan
            </button>
          </div>
          {suspended ? <p className={styles.muted}>Suspended: the plan can change, but reactivating is a separate step.</p> : null}
        </form>

        <form
          className={styles.controlRow}
          onSubmit={(e) => {
            e.preventDefault();
            const who = members.find((m) => m.userId === newOwner);
            if (!who) return;
            if (confirm(`Make ${who.name} an owner of ${agencyName}?${demote ? ' The current owner(s) become admins.' : ' The current owner(s) stay owners.'}`)) {
              a.go(`${who.name} is now an owner.`, () => makeOwnerAction(agencyId, who.userId, demote));
            }
          }}
        >
          <h3 className={styles.h3}>Owner</h3>
          {members.length === 0 ? (
            <p className={styles.muted}>No other active member to make owner.</p>
          ) : (
            <div className={styles.filters}>
              <select className={styles.select} value={newOwner} onChange={(e) => setNewOwner(e.target.value)} aria-label="New owner" required>
                <option value="">Choose a member…</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
              <label className={styles.inline}>
                <input type="checkbox" checked={demote} onChange={(e) => setDemote(e.target.checked)} /> current owner(s) become admins
              </label>
              <button type="submit" className={styles.btn} disabled={a.pending || !newOwner}>
                Make owner
              </button>
            </div>
          )}
        </form>

        <Message message={a.message} />
      </div>
    </section>
  );
}

export function MemberControls({
  agencyId,
  userId,
  name,
  status,
  removed,
}: {
  agencyId: string;
  userId: string;
  name: string;
  status: string;
  /** Removed by the agency (ADR 0030): not the platform's to block or unblock. */
  removed: boolean;
}) {
  const a = useAction();
  const [reason, setReason] = useState('');
  const blocked = status === 'suspended' && !removed;

  return (
    <section className={styles.card} aria-label="Member controls">
      <div className={styles.cardBody}>
        <h3 className={styles.h3}>Access</h3>
        {removed ? (
          <p className={styles.muted}>The agency removed {name}. Restoring them is the agency’s, from its Team page.</p>
        ) : blocked ? (
          <div className={styles.filters}>
            <span className={styles.badgeBad}>Blocked by the platform</span>
            <button
              type="button"
              className={styles.btn}
              disabled={a.pending}
              onClick={() => {
                if (confirm(`Unblock ${name}? They can sign in again.`)) a.go('Unblocked.', () => unblockMemberAction(agencyId, userId));
              }}
            >
              Unblock
            </button>
          </div>
        ) : status === 'active' ? (
          <form
            className={styles.filters}
            onSubmit={(e) => {
              e.preventDefault();
              if (confirm(`Block ${name}?\n\nThey can no longer sign in to the console or register an agency, and their bulk email waits. Their leads, contacts and listings stay where they are.`)) {
                a.go('Blocked.', () => blockMemberAction(agencyId, userId, reason));
              }
            }}
          >
            <input
              className={styles.input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why (kept with the change)"
              aria-label="Reason for blocking"
              required
              minLength={3}
              maxLength={500}
            />
            <button type="submit" className={styles.btnDanger} disabled={a.pending}>
              Block {name}
            </button>
          </form>
        ) : (
          <p className={styles.muted}>Not active ({status}).</p>
        )}
        <Message message={a.message} />
      </div>
    </section>
  );
}
