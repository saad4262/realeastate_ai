'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { markCommissionPaidAction, setCommissionAction } from '@/lib/deal-actions';
import styles from './deals.module.css';

export type PanelCommission = {
  basis: 'percent' | 'fixed' | null;
  rate: number | null;
  fixed: number | null;
  split: number | null;
  splitFromProfile: boolean;
  commission: number | null;
  gst: number | null;
  invoice: number | null;
  agentShare: number | null;
  agencyShare: number | null;
  paidOn: string | null;
  state: 'none' | 'expected' | 'earned' | 'paid';
  mayEdit: boolean;
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money = (n: number | null) => (n === null ? '—' : AUD.format(n));
const STATE: Record<PanelCommission['state'], { label: string; cls: string }> = {
  none: { label: 'Not set', cls: '' },
  expected: { label: 'Expected', cls: styles.pillWarn ?? '' },
  earned: { label: 'Earned', cls: styles.pillOk ?? '' },
  paid: { label: 'Paid out', cls: styles.pillAuto ?? '' },
};

/**
 * The Deal tab's Commission panel (ADR 0064). The agency (owners and admins) sets it; the deal's agent sees
 * it. Every amount shown was worked out by the server's one SQL expression — this panel adds nothing up.
 */
export function CommissionPanel({ dealId, agentName, salePrice, status, c }: { dealId: string; agentName: string | null; salePrice: number | null; status: string; c: PanelCommission }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [basis, setBasis] = useState<'percent' | 'fixed'>(c.basis ?? 'percent');
  const [error, setError] = useState<string | null>(null);
  const [paidOn, setPaidOn] = useState(c.paidOn ?? new Date().toISOString().slice(0, 10));

  const save = (form: FormData) => {
    const num = (k: string) => {
      const s = String(form.get(k) ?? '').replace(/[$,%\s]/g, '');
      return s === '' ? null : Number(s);
    };
    start(async () => {
      setError(null);
      const r = await setCommissionAction(dealId, { basis, rate: num('rate'), fixed: num('fixed'), agentSplit: num('agentSplit') });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({ title: 'Commission saved', variant: 'success' });
      router.refresh();
    });
  };
  const paid = (on: string | null) =>
    start(async () => {
      setError(null);
      const r = await markCommissionPaidAction(dealId, on);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({ title: on ? 'Marked paid' : 'No longer marked paid', variant: 'success' });
      router.refresh();
    });

  const pct = (x: number | null) => (x === null ? '' : String(x));
  const rateWords = c.basis === 'percent' && c.rate !== null ? `${c.rate}%` : c.basis === 'fixed' ? 'fixed fee' : '';

  return (
    <section className={styles.panel} aria-labelledby="deal-commission">
      <div className={styles.panelHead}>
        <h3 id="deal-commission">Commission</h3>
        <span className={`${styles.pill} ${STATE[c.state].cls}`}>{STATE[c.state].label}{c.state === 'paid' && c.paidOn ? ` ${c.paidOn}` : ''}</span>
      </div>

      {c.mayEdit ? (
        <form action={save} className={styles.form}>
          <label className={styles.field}>
            How it’s charged
            <select className={styles.input} value={basis} onChange={(e) => setBasis(e.target.value as 'percent' | 'fixed')}>
              <option value="percent">% of the sale price</option>
              <option value="fixed">A fixed fee</option>
            </select>
          </label>
          {basis === 'percent' ? (
            <label className={styles.field}>Rate (excl. GST, %)<input className={styles.input} name="rate" inputMode="decimal" defaultValue={pct(c.rate)} placeholder="2.2" /></label>
          ) : (
            <label className={styles.field}>Fee (excl. GST)<input className={styles.input} name="fixed" inputMode="decimal" defaultValue={pct(c.fixed)} placeholder="17000" /></label>
          )}
          <label className={styles.field}>
            Agent’s share (%)
            <input className={styles.input} name="agentSplit" inputMode="decimal" defaultValue={c.splitFromProfile ? '' : pct(c.split)} placeholder={c.splitFromProfile && c.split !== null ? `${c.split} (their profile)` : 'e.g. 60'} />
            <span className={styles.muted}>Empty = {agentName ?? 'the agent'}’s split from Agents &amp; Team.</span>
          </label>
          <div className={styles.actions} style={{ alignItems: 'end' }}>
            <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : c.basis === null ? (
        <p className={styles.muted}>The agency hasn’t set the commission on this deal yet.</p>
      ) : null}

      {c.commission !== null ? (
        <dl className={styles.dl} style={{ marginTop: '0.75rem' }}>
          <dt>Sale price</dt><dd>{money(salePrice)}</dd>
          <dt>Commission{rateWords ? ` (${rateWords})` : ''}</dt><dd>{money(c.commission)} <span className={styles.muted}>excl. GST</span></dd>
          <dt>GST (10%)</dt><dd>{money(c.gst)}</dd>
          <dt>Invoice to the vendor</dt><dd><b>{money(c.invoice)}</b> <span className={styles.muted}>incl. GST</span></dd>
          <dt>Agent’s share{c.split !== null ? ` (${c.split}%)` : ''}</dt><dd>{c.agentShare === null ? 'No split set — add it above or on Agents & Team' : money(c.agentShare)}</dd>
          <dt>Agency’s share</dt><dd>{money(c.agencyShare)}</dd>
        </dl>
      ) : c.basis !== null && salePrice === null ? (
        <p className={styles.muted} style={{ marginTop: '0.5rem' }}>The amounts appear once the deal has a sale price.</p>
      ) : null}

      {c.mayEdit && status === 'settled' && c.commission !== null ? (
        <div className={styles.actions} style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          {c.paidOn ? (
            <button type="button" className={styles.btnLink} disabled={pending} onClick={() => paid(null)}>Undo “paid”</button>
          ) : (
            <>
              <input type="date" className={styles.dateIn} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} aria-label="Paid on" />
              <button type="button" className={styles.btn} disabled={pending || !paidOn} onClick={() => paid(paidOn)}>Mark agent paid</button>
            </>
          )}
        </div>
      ) : null}
      <p className={styles.muted} style={{ marginTop: '0.625rem' }}>
        Worked out by the platform, rounded to the cent; the agent’s and the agency’s shares always add up to the commission. Expected while under contract, earned when it settles.
      </p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>
  );
}
