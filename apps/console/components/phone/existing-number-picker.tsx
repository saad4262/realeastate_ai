'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { assignAgencyNumberAction, listAgencyNumbersAction } from '@/lib/phone-actions';
import styles from './phone.module.css';

type Existing = { sid: string; e164: string; display: string; unavailable: string | null };

/**
 * ADR 0090: give an agent a number the agency already has on its own Twilio, instead of buying one.
 * The list is read from Twilio when the dialog opens; the server picks the number again from Twilio's
 * own list before touching it, so nothing here is trusted. A number Twilio routes some other way is
 * shown with what to change, not offered.
 */
export function UseExistingNumberButton({ agentUserId, name }: { agentUserId: string; name: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState<Existing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();

  const show = () => {
    setOpen(true);
    setNumbers(null);
    setError(null);
    startLoading(async () => {
      const r = await listAgencyNumbersAction();
      if (r.ok) setNumbers(r.numbers);
      else setError(r.error);
    });
  };
  const close = () => {
    if (!saving) setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pick = (n: Existing) => {
    if (!window.confirm(`Give ${n.display} to ${name}? Its texts and calls will come here. What it was set to in Twilio is kept, and put back if you release it here.`)) return;
    startSaving(async () => {
      const r = await assignAgencyNumberAction(agentUserId, n.sid);
      if (!r.ok) {
        toast({ title: 'Not given', description: r.error, variant: 'error' });
        return;
      }
      toast({ title: `${name}’s number: ${r.status ?? n.display}`, variant: 'success' });
      setOpen(false);
      router.refresh();
    });
  };

  const usable = numbers?.filter((n) => !n.unavailable) ?? [];
  const refused = numbers?.filter((n) => n.unavailable) ?? [];

  return (
    <>
      <button type="button" className={styles.btn} onClick={show}>
        Use an existing number
      </button>
      {open ? (
        <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={`pick-${agentUserId}`}>
            <h2 id={`pick-${agentUserId}`} className={styles.panelTitle}>
              A number for {name}
            </h2>
            <p className={styles.muted}>Numbers already on your Twilio that are not used here. Twilio keeps billing the agency for them, as now.</p>
            {loading ? <p className={styles.muted}>Asking Twilio…</p> : null}
            {error ? <p className={`${styles.note} ${styles.noteBad}`}>{error}</p> : null}
            {numbers && !numbers.length ? <p className={styles.note}>No free mobile numbers on your Twilio. Use “Get a number” instead.</p> : null}
            {usable.length ? (
              <ul className={styles.pickList}>
                {usable.map((n) => (
                  <li key={n.sid}>
                    <button type="button" className={styles.pickItem} disabled={saving} onClick={() => pick(n)}>
                      <span className={styles.mono}>{n.display}</span>
                      <span className={styles.muted}>{saving ? 'Pointing it here…' : 'Use'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {refused.length ? (
              <ul className={styles.pickList}>
                {refused.map((n) => (
                  <li key={n.sid} className={styles.pickRefused}>
                    <span className={styles.mono}>{n.display}</span>
                    <span className={styles.muted}>{n.unavailable}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className={styles.row}>
              <button type="button" className={styles.btn} onClick={close} disabled={saving}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
