'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { renderMerge, type MergeValues, type SkipReason } from '@repo/core/template-email/schema';
import { useToast } from '@/components/toast';
import { remindToCallBuyersAction } from '@/lib/buyer-actions';
import { prepareListingBatchAction } from '@/lib/template-email-actions';
import styles from './matching-buyers.module.css';

export type PickerBuyer = {
  contactId: string;
  name: string;
  brief: string;
  assigneeName: string | null;
  enquired: boolean;
  skipReason: SkipReason | null;
  /** The skip reason in words, from core's labels. */
  skipLabel: string | null;
};
export type PickerTemplate = { id: string; name: string; subject: string; body: string; usesLink: boolean };

const SHORT: Partial<Record<SkipReason, string>> = { no_consent: 'No marketing consent', opted_out: 'Unsubscribed', no_email: 'No email address' };

/**
 * The Matching buyers tab's island (ADR 0060): pick buyers who may be emailed, then email them with a
 * template (Prepare & review → the batch page → Approve & Send) or put them on ONE call list. Who may be
 * emailed is core's answer, drawn here; both actions ask core again.
 */
export function BuyerPicker({
  listingId,
  contactBase,
  batchBase,
  templatesHref,
  buyers,
  templates,
  merge,
  listingLive,
  bulkEmailOn,
  bulkEmailOffMessage,
}: {
  listingId: string;
  contactBase: string;
  batchBase: string;
  templatesHref: string;
  buyers: PickerBuyer[];
  templates: PickerTemplate[];
  /** The agent's and agency's names and the listing's values — the preview fills from these. */
  merge: Omit<MergeValues, 'first_name' | 'full_name'>;
  listingLive: boolean;
  bulkEmailOn: boolean;
  bulkEmailOffMessage: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const usable = templates.filter((t) => listingLive || !t.usesLink);
  const [templateId, setTemplateId] = useState(usable[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  const emailable = buyers.filter((b) => !b.skipReason);
  const chosen = buyers.filter((b) => picked.has(b.contactId));
  const allTicked = emailable.length > 0 && emailable.every((b) => picked.has(b.contactId));
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const tpl = templates.find((t) => t.id === templateId) ?? null;
  const preview = useMemo(() => {
    const first = chosen[0];
    if (!tpl || !first) return null;
    const v: MergeValues = { ...merge, first_name: first.name.trim().split(/\s+/)[0] || first.name, full_name: first.name };
    return { subject: renderMerge(tpl.subject, v), body: renderMerge(tpl.body, v) };
  }, [tpl, chosen, merge]);

  const remind = () =>
    startTransition(async () => {
      const r = await remindToCallBuyersAction(listingId, [...picked]);
      if (!r.ok) {
        toast({ title: 'Not done', description: r.error, variant: 'error' });
        return;
      }
      const when = r.at ? new Date(r.at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'tomorrow';
      toast({
        title: r.already ? 'Already on your list' : 'Call list made',
        description: r.already ? `A reminder for these buyers is already set for ${when}.` : `One reminder at ${when} lists all ${picked.size} buyer${picked.size === 1 ? '' : 's'} with their phones.`,
        variant: 'success',
      });
    });

  const prepare = () =>
    startTransition(async () => {
      setError(null);
      const r = await prepareListingBatchAction(listingId, templateId, [...picked]);
      if (!r.ok || !r.id) {
        setError(r.ok ? 'Could not prepare the email' : r.error);
        return;
      }
      router.push(`${batchBase}/${r.id}`);
    });

  return (
    <>
      <div className={styles.card}>
        <div className={styles.bar}>
          <span className={styles.barCount} aria-live="polite">
            {picked.size
              ? `${picked.size} selected`
              : `${buyers.length} buyer${buyers.length === 1 ? '' : 's'} fit · ${emailable.length} can be emailed`}
          </span>
          <button type="button" className={styles.btn} disabled={!picked.size || pending} onClick={remind}>
            <span className={styles.glyphSm} aria-hidden>call</span>Remind me to call
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!picked.size || pending || !bulkEmailOn}
            title={bulkEmailOn ? undefined : bulkEmailOffMessage}
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            <span className={styles.glyphSm} aria-hidden>forward_to_inbox</span>Email selected{picked.size ? ` (${picked.size})` : ''}
          </button>
        </div>
        {buyers.length === 0 ? (
          <p className={styles.empty}>No active brief fits this listing yet. Buyers’ briefs are added on a contact’s Requirements tab.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: '2.25rem' }}>
                    <input
                      type="checkbox"
                      className={styles.check}
                      aria-label="Select everyone who can be emailed"
                      checked={allTicked}
                      disabled={emailable.length === 0 || pending}
                      onChange={() => setPicked(allTicked ? new Set() : new Set(emailable.map((b) => b.contactId)))}
                    />
                  </th>
                  <th>Buyer</th>
                  <th>Wants</th>
                  <th className={styles.hideSm}>Agent</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {buyers.map((b) => (
                  <tr key={b.contactId}>
                    <td>
                      <input
                        type="checkbox"
                        className={styles.check}
                        aria-label={`Select ${b.name}`}
                        checked={picked.has(b.contactId)}
                        // ADR 0060 §3, the user's decision 4: no box for anyone the bulk-email rule would skip.
                        disabled={Boolean(b.skipReason) || pending}
                        title={b.skipLabel ?? undefined}
                        onChange={() => toggle(b.contactId)}
                      />
                    </td>
                    <td>
                      <Link href={`${contactBase}/${b.contactId}?tab=requirements`} className={styles.name}>
                        {b.name}
                      </Link>{' '}
                      {b.enquired ? <span className={`${styles.pill} ${styles.pillInfo}`}>Enquired on this</span> : null}
                    </td>
                    <td className={styles.brief}>{b.brief}</td>
                    <td className={styles.hideSm}>{b.assigneeName ?? 'Unassigned'}</td>
                    <td>
                      {b.skipReason ? (
                        <span className={`${styles.pill} ${b.skipReason === 'no_consent' ? styles.pillSkip : styles.pillNo}`} title={b.skipLabel ?? undefined}>
                          {SHORT[b.skipReason] ?? b.skipLabel}
                        </span>
                      ) : (
                        <span className={`${styles.pill} ${styles.pillOk}`}>
                          <span className={styles.glyphSm} aria-hidden>check</span>Can be emailed
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open ? (
        <div
          className={styles.scrim}
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !pending) setOpen(false);
          }}
        >
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="buyers-email-title">
            <div className={styles.dHead}>
              <h2 id="buyers-email-title">Email {chosen.length} buyer{chosen.length === 1 ? '' : 's'} about this listing</h2>
              <button type="button" className={styles.btn} aria-label="Close" disabled={pending} onClick={() => setOpen(false)}>
                <span className={styles.glyphSm} aria-hidden>close</span>
              </button>
            </div>
            <div className={styles.dBody}>
              {usable.length === 0 ? (
                <p className={styles.empty} style={{ padding: 0 }}>
                  You have no template you can send{templates.length ? ' while this listing is not live (yours link to its public ad)' : ''}.{' '}
                  <Link href={templatesHref}>Write one</Link> — it may use {'{{listing_address}}'}, {'{{listing_price}}'} and {'{{listing_link}}'}.
                </p>
              ) : (
                <>
                  <label className={styles.field}>
                    Template
                    <select className={styles.select} value={templateId} onChange={(e) => setTemplateId(e.target.value)} autoFocus>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id} disabled={t.usesLink && !listingLive}>
                          {t.name}
                          {t.usesLink && !listingLive ? ' — links to the ad; listing not live' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {preview ? (
                    <div className={styles.preview}>
                      <div className={styles.previewSubject}>{preview.subject}</div>
                      {preview.body}
                      <div className={styles.sub}>Preview for {chosen[0]!.name}. Each person sees their own name.</div>
                    </div>
                  ) : null}
                  <div className={styles.who}>
                    {chosen.map((b) => (
                      <div key={b.contactId} className={styles.whoRow}>
                        <span>{b.name}</span>
                        <span className={`${styles.pill} ${styles.pillOk}`}>Can be emailed</span>
                      </div>
                    ))}
                    <div className={styles.sub}>
                      Checked again when you prepare and at the moment of sending. At most 20 per batch; nothing is sent until you press Approve &amp; Send.
                    </div>
                  </div>
                </>
              )}
              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className={styles.dFoot}>
              <button type="button" className={styles.btn} disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={pending || !usable.length || !templateId} onClick={prepare}>
                <span className={styles.glyphSm} aria-hidden>fact_check</span>
                {pending ? 'Preparing…' : 'Prepare & review'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
