'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { DEAL_STAGES, DEAL_STAGE_LABELS, stageIndex, type DealStage, type DealStatus } from '@repo/core/deals/stages';
import { useToast } from '@/components/toast';
import {
  addDealConditionAction,
  moveDealStageAction,
  removeDealConditionAction,
  settleDealAction,
  updateDealAction,
  updateDealConditionAction,
  type DealActionResult,
} from '@/lib/deal-actions';
import styles from './deals.module.css';

export type EditorDeal = {
  id: string;
  stage: DealStage;
  status: DealStatus;
  agentName: string | null;
  salePrice: number | null;
  buyer: { id: string; name: string } | null;
  vendor: { id: string; name: string } | null;
  contractDate: string | null;
  depositAmount: number | null;
  depositPaidOn: string | null;
  settlementDate: string | null;
  buyerSolicitor: string | null;
  settledAt: string | null;
  conditions: { id: string; kind: string; label: string; dueOn: string | null; doneAt: string | null }[];
  events: { kind: string; from: DealStage | null; to: DealStage | null; auto: boolean; actorName: string | null; note: string | null; at: string }[];
  mayEdit: boolean;
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const DAY = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const day = (iso: string | null) => (iso ? DAY.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : '—');
const money = (n: number | null) => (n === null ? '—' : AUD.format(n));
const EVENT_GLYPH: Record<string, string> = { opened: 'flag', stage: 'arrow_forward', settled: 'task_alt', withdrawn: 'block', condition: 'checklist', edited: 'edit' };

/**
 * The Deal tab's island (ADR 0063). Every button is drawn from `mayEdit`, decided by core; every action asks
 * core again. Nothing here works out a figure — it shows what the server sent.
 */
export function DealEditor({ deal, buyerOptions, contactBase }: { deal: EditorDeal; buyerOptions: { id: string; name: string }[]; contactBase: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCond, setNewCond] = useState({ label: '', dueOn: '' });
  const open = deal.status === 'open';
  const i = stageIndex(deal.stage);
  const prev = i > 0 ? DEAL_STAGES[i - 1] : null;
  const next = i < DEAL_STAGES.length - 1 ? DEAL_STAGES[i + 1] : null;

  const run = (fn: () => Promise<DealActionResult>, ok?: string, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        toast({ title: 'Not saved', description: r.error, variant: 'error' });
        return;
      }
      if (ok) toast({ title: ok, variant: 'success' });
      after?.();
      router.refresh();
    });

  const saveDetails = (form: FormData) => {
    const v = (k: string) => {
      const s = String(form.get(k) ?? '').trim();
      return s === '' ? null : s;
    };
    const n = (k: string) => (v(k) === null ? null : Number(String(v(k)).replace(/[$,\s]/g, '')));
    run(
      () =>
        updateDealAction(deal.id, {
          salePrice: n('salePrice'),
          buyerContactId: v('buyerContactId'),
          contractDate: v('contractDate'),
          depositAmount: n('depositAmount'),
          depositPaidOn: v('depositPaidOn'),
          settlementDate: v('settlementDate'),
          buyerSolicitor: v('buyerSolicitor'),
        }),
      'Sale details saved',
      () => setEditing(false),
    );
  };

  const settle = (form: FormData) => {
    const price = String(form.get('finalPrice') ?? '').replace(/[$,\s]/g, '');
    run(
      () => settleDealAction(deal.id, { settledOn: String(form.get('settledOn') ?? ''), finalPrice: price ? Number(price) : null, tagPastClients: form.get('tag') === 'on' }),
      'Deal settled',
      () => setSettling(false),
    );
  };

  return (
    <>
      {deal.mayEdit && open ? (
        <div className={styles.actions}>
          {prev ? (
            <button type="button" className={styles.btn} disabled={pending} onClick={() => run(() => moveDealStageAction(deal.id, prev), `Moved back to ${DEAL_STAGE_LABELS[prev]}`)}>
              <span className={styles.glyph} aria-hidden>arrow_back</span>Back to {DEAL_STAGE_LABELS[prev]}
            </button>
          ) : null}
          {next ? (
            <button type="button" className={styles.btn} disabled={pending} onClick={() => run(() => moveDealStageAction(deal.id, next), `Moved to ${DEAL_STAGE_LABELS[next]}`)}>
              Move to {DEAL_STAGE_LABELS[next]}<span className={styles.glyph} aria-hidden>arrow_forward</span>
            </button>
          ) : null}
          {i >= stageIndex('contract') ? (
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={pending} onClick={() => setSettling(true)}>
              <span className={styles.glyph} aria-hidden>task_alt</span>Mark settled
            </button>
          ) : null}
        </div>
      ) : null}
      {!open ? (
        <p className={styles.note}>
          <span className={styles.glyph} aria-hidden>{deal.status === 'settled' ? 'task_alt' : 'block'}</span>
          <span>{deal.status === 'settled' ? `Settled ${day(deal.settlementDate)}${deal.salePrice !== null ? ` at ${money(deal.salePrice)}` : ''}.` : 'This deal was withdrawn with its listing.'}</span>
        </p>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <div className={styles.grid2}>
        <section className={styles.panel} aria-labelledby="deal-sale">
          <div className={styles.panelHead}>
            <h3 id="deal-sale">The sale</h3>
            {deal.mayEdit && open && !editing ? (
              <button type="button" className={styles.btn} onClick={() => setEditing(true)}>
                <span className={styles.glyph} aria-hidden>edit</span>Edit
              </button>
            ) : null}
          </div>
          {editing ? (
            <form action={saveDetails} className={styles.form}>
              <label className={styles.field}>Sale price<input className={styles.input} name="salePrice" inputMode="numeric" defaultValue={deal.salePrice ?? ''} /></label>
              <label className={styles.field}>
                Buyer
                <select className={styles.input} name="buyerContactId" defaultValue={deal.buyer?.id ?? ''}>
                  <option value="">—</option>
                  {deal.buyer && !buyerOptions.some((b) => b.id === deal.buyer!.id) ? <option value={deal.buyer.id}>{deal.buyer.name}</option> : null}
                  {buyerOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className={styles.field}>Contract signed<input className={styles.input} type="date" name="contractDate" defaultValue={deal.contractDate ?? ''} /></label>
              <label className={styles.field}>Deposit<input className={styles.input} name="depositAmount" inputMode="numeric" defaultValue={deal.depositAmount ?? ''} /></label>
              <label className={styles.field}>Deposit paid on<input className={styles.input} type="date" name="depositPaidOn" defaultValue={deal.depositPaidOn ?? ''} /></label>
              <label className={styles.field}>Settlement date<input className={styles.input} type="date" name="settlementDate" defaultValue={deal.settlementDate ?? ''} /></label>
              <label className={styles.field}>Buyer’s solicitor<input className={styles.input} name="buyerSolicitor" maxLength={160} defaultValue={deal.buyerSolicitor ?? ''} /></label>
              <div className={styles.actions} style={{ alignItems: 'end' }}>
                <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
                <button type="button" className={styles.btn} disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <dl className={styles.dl}>
              <dt>Sale price</dt><dd><b>{money(deal.salePrice)}</b></dd>
              <dt>Buyer</dt><dd>{deal.buyer ? <Link href={`${contactBase}/${deal.buyer.id}`}>{deal.buyer.name}</Link> : '—'}</dd>
              <dt>Vendor</dt><dd>{deal.vendor ? <Link href={`${contactBase}/${deal.vendor.id}`}>{deal.vendor.name}</Link> : '—'}</dd>
              <dt>Contract signed</dt><dd>{day(deal.contractDate)}</dd>
              <dt>Deposit</dt><dd>{money(deal.depositAmount)}{deal.depositPaidOn ? ` · paid ${day(deal.depositPaidOn)}` : ''}</dd>
              <dt>Settlement</dt><dd>{day(deal.settlementDate)}</dd>
              <dt>Buyer’s solicitor</dt><dd>{deal.buyerSolicitor || '—'}</dd>
              <dt>Agent</dt><dd>{deal.agentName ?? '—'}</dd>
            </dl>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="deal-conditions">
          <div className={styles.panelHead}><h3 id="deal-conditions">Conditions</h3></div>
          {deal.conditions.length === 0 ? <p className={styles.muted}>The standard conditions appear when the deal reaches Contract.</p> : null}
          {deal.conditions.map((c) => (
            <div key={c.id} className={styles.cond}>
              <input
                type="checkbox"
                className={styles.check}
                aria-label={`${c.label} met`}
                checked={Boolean(c.doneAt)}
                disabled={!deal.mayEdit || !open || pending}
                onChange={(e) => run(() => updateDealConditionAction(c.id, { done: e.target.checked }))}
              />
              <span className={c.doneAt ? styles.condDone : undefined}>{c.label}</span>
              <span className={styles.actions} style={{ gap: '0.375rem', alignItems: 'center' }}>
                <input
                  type="date"
                  className={styles.dateIn}
                  aria-label={`${c.label} due`}
                  defaultValue={c.dueOn ?? ''}
                  disabled={!deal.mayEdit || !open || pending}
                  onChange={(e) => run(() => updateDealConditionAction(c.id, { dueOn: e.target.value || null }))}
                />
                {c.kind === 'custom' && deal.mayEdit && open ? (
                  <button type="button" className={styles.btnLink} aria-label={`Remove ${c.label}`} disabled={pending} onClick={() => run(() => removeDealConditionAction(c.id), 'Condition removed')}>
                    Remove
                  </button>
                ) : null}
              </span>
            </div>
          ))}
          {deal.mayEdit && open ? (
            <form
              className={styles.actions}
              style={{ marginTop: '0.625rem' }}
              onSubmit={(e) => {
                e.preventDefault();
                run(() => addDealConditionAction(deal.id, newCond.label, newCond.dueOn || null), 'Condition added', () => setNewCond({ label: '', dueOn: '' }));
              }}
            >
              <input className={styles.input} style={{ flex: 1, minWidth: '9rem' }} placeholder="Add a condition, e.g. Sale of their home" maxLength={80} value={newCond.label} onChange={(e) => setNewCond((s) => ({ ...s, label: e.target.value }))} aria-label="New condition" />
              <input className={styles.dateIn} type="date" value={newCond.dueOn} onChange={(e) => setNewCond((s) => ({ ...s, dueOn: e.target.value }))} aria-label="New condition due" />
              <button type="submit" className={styles.btn} disabled={pending || newCond.label.trim().length < 2}>Add</button>
            </form>
          ) : null}
          <p className={styles.muted} style={{ marginTop: '0.625rem' }}>The deal’s agent is reminded two days before each date and before settlement.</p>
        </section>
      </div>

      <section className={styles.panel} aria-labelledby="deal-history">
        <div className={styles.panelHead}><h3 id="deal-history">What happened</h3></div>
        <ul className={styles.log}>
          {deal.events.map((e, k) => (
            <li key={k}>
              <span className={styles.glyph} aria-hidden>{EVENT_GLYPH[e.kind] ?? 'circle'}</span>
              <span>
                {e.to ? <b>{DEAL_STAGE_LABELS[e.to]}</b> : null}
                {e.to && e.note ? ' — ' : ''}
                {e.note}
                {' · '}
                {new Date(e.at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                {e.auto ? <> <span className={`${styles.pill} ${styles.pillAuto}`}>automatic</span></> : e.actorName ? ` · ${e.actorName}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {settling ? (
        <div className={styles.scrim} onClick={(e) => { if (e.target === e.currentTarget && !pending) setSettling(false); }}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="settle-title">
            <form action={settle}>
              <div className={styles.dHead}>
                <h2 id="settle-title">Mark this sale settled</h2>
                <button type="button" className={styles.btn} aria-label="Close" disabled={pending} onClick={() => setSettling(false)}>
                  <span className={styles.glyph} aria-hidden>close</span>
                </button>
              </div>
              <div className={styles.dBody}>
                <div className={styles.form}>
                  <label className={styles.field}>Settled on<input className={styles.input} type="date" name="settledOn" required defaultValue={deal.settlementDate ?? new Date().toISOString().slice(0, 10)} /></label>
                  <label className={styles.field}>Final price<input className={styles.input} name="finalPrice" inputMode="numeric" defaultValue={deal.salePrice ?? ''} /></label>
                </div>
                <label className={styles.field} style={{ fontWeight: 400 }}>
                  <span><input type="checkbox" name="tag" defaultChecked /> Tag {[deal.buyer?.name, deal.vendor?.name].filter(Boolean).join(' and ') || 'the buyer and vendor'} as Past clients</span>
                </label>
                <p className={styles.muted}>The deal closes and leaves the board. A past client is still emailed only with their consent.</p>
              </div>
              <div className={styles.dFoot}>
                <button type="button" className={styles.btn} disabled={pending} onClick={() => setSettling(false)}>Cancel</button>
                <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={pending}>{pending ? 'Settling…' : 'Mark settled'}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
