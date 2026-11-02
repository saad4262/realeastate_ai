'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BASE_MERGE_FIELDS, LISTING_MERGE_FIELDS, smsTemplateInputSchema } from '@repo/core/template-email/schema';
import { SMS_STOP_FOOTER, SMS_TEMPLATE_MAX, smsParts, withStopFooter } from '@repo/core/template-email/sms';
import { useToast } from '@/components/toast';
import {
  approveSmsBatchAction,
  cancelSmsBatchAction,
  createSmsTemplateAction,
  prepareSmsBatchAction,
  retireSmsTemplateAction,
  retrySmsFailedAction,
  updateSmsTemplateAction,
  type SmsBatchResult,
} from '@/lib/sms-batch-actions';
import contactStyles from '@/components/contacts/contacts.module.css';

/**
 * The Bulk SMS screens' client islands (ADR 0074 part 2). Every button is drawn from a decision can() made on
 * the server; every action checks again, with the five SMS rules.
 */

function useRun() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<SmsBatchResult>, ok?: string, after?: (r: SmsBatchResult & { ok: true }) => void) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        toast({ title: 'Not done', description: r.error, variant: 'error' });
        return;
      }
      if (ok || r.note) toast({ title: r.note ?? ok ?? 'Done', variant: 'success' });
      after?.(r);
      router.refresh();
    });
  return { pending, run, router };
}

/** "1 text · 96 characters" — what the carrier bills, with the STOP line the app adds. */
function partsWords(body: string): string {
  const p = smsParts(withStopFooter(body));
  return `${p.parts} ${p.parts === 1 ? 'text' : 'texts'} · ${p.units} characters${p.encoding === 'ucs2' ? ' (an emoji or special character makes each text shorter)' : ''}`;
}

export function SmsTemplateForm({ basePath, templateId, initial }: { basePath: string; templateId?: string; initial?: { name: string; body: string } }) {
  const { pending, run, router } = useRun();
  const [name, setName] = useState(initial?.name ?? '');
  const [body, setBody] = useState(initial?.body ?? 'Hi {{first_name}}, {{agent_name}} from {{agency_name}} here. ');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={contactStyles.form}
      onSubmit={(e) => {
        e.preventDefault();
        const input = { name, body };
        const check = smsTemplateInputSchema.safeParse(input);
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Check the text');
          return;
        }
        setError(null);
        run(
          () => (templateId ? updateSmsTemplateAction(templateId, input) : createSmsTemplateAction(input)),
          'Saved — ready to use',
          (r) => !templateId && r.id && router.push(`${basePath}/templates/${r.id}`),
        );
      }}
    >
      {error ? <p className={contactStyles.error} role="alert">{error}</p> : null}
      <label className={contactStyles.field}>
        <span className={contactStyles.label}>Name (only your agency sees it)</span>
        <input className={contactStyles.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <label className={contactStyles.field}>
        <span className={contactStyles.label}>Text</span>
        <textarea className={contactStyles.textarea} rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={SMS_TEMPLATE_MAX} />
        <span className={contactStyles.hint}>
          {partsWords(body)} · up to {SMS_TEMPLATE_MAX} characters before the STOP line. Merge fields: {BASE_MERGE_FIELDS.map((f) => `{{${f}}}`).join(' ')}; from a
          listing&apos;s Matching buyers tab also {LISTING_MERGE_FIELDS.map((f) => `{{${f}}}`).join(' ')}.
        </span>
      </label>
      <div className={contactStyles.field}>
        <span className={contactStyles.label}>As it is sent</span>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{withStopFooter(body)}</pre>
        <span className={contactStyles.hint}>“{SMS_STOP_FOOTER}” is added to every text by the app and cannot be removed (Spam Act: a working opt-out).</span>
      </div>
      <div className={contactStyles.actions}>
        <button type="submit" className={contactStyles.btn} disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

export function SmsTemplateSteps({ id, mayRetire }: { id: string; mayRetire: boolean }) {
  const { pending, run } = useRun();
  if (!mayRetire) return null;
  return (
    <button
      type="button"
      className={contactStyles.linkBtn}
      disabled={pending}
      onClick={() => window.confirm('Retire this SMS template? It can no longer be used for new texts.') && run(() => retireSmsTemplateAction(id), 'Retired')}
    >
      Retire
    </button>
  );
}

export function PrepareSmsForm({ basePath, templates, filters }: { basePath: string; templates: { id: string; name: string }[]; filters: { id: string; name: string }[] }) {
  const { pending, run, router } = useRun();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [filterId, setFilterId] = useState(filters[0]?.id ?? '');
  if (!templates.length) return <p className={contactStyles.note}>No SMS template yet — write one under SMS templates; it is ready as soon as it is saved.</p>;
  if (!filters.length) return <p className={contactStyles.note}>No saved filter yet — filter the contact list and press “Save this filter”.</p>;
  return (
    <form
      className={contactStyles.inlineForm}
      onSubmit={(e) => {
        e.preventDefault();
        run(() => prepareSmsBatchAction(templateId, filterId), 'Prepared — check every name before sending', (r) => r.id && router.push(`${basePath}/${r.id}`));
      }}
    >
      <select className={contactStyles.select} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="SMS template">
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <select className={contactStyles.select} value={filterId} onChange={(e) => setFilterId(e.target.value)} aria-label="Saved filter">
        {filters.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
      <button type="submit" className={contactStyles.btn} disabled={pending}>{pending ? 'Preparing…' : 'Prepare'}</button>
    </form>
  );
}

export function ApproveSmsButton({ batchId, count, laterWords }: { batchId: string; count: number; laterWords: string | null }) {
  const { pending, run } = useRun();
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      className={contactStyles.btn}
      disabled={pending || pressed}
      onClick={() => {
        const who = `${count} ${count === 1 ? 'person' : 'people'}`;
        if (!window.confirm(laterWords ? `Approve texts to ${who}? It is outside sending hours, so they go ${laterWords}.` : `Text ${who} now?`)) return;
        setPressed(true);
        run(() => approveSmsBatchAction(batchId));
      }}
    >
      {pending || pressed ? 'Approving…' : `Approve & Send to ${count}`}
    </button>
  );
}

export function CancelSmsButton({ batchId }: { batchId: string }) {
  const { pending, run } = useRun();
  return (
    <button type="button" className={contactStyles.btnGhost} disabled={pending} onClick={() => window.confirm('Cancel these texts? Nothing has been sent.') && run(() => cancelSmsBatchAction(batchId), 'Cancelled')}>
      Cancel
    </button>
  );
}

export function RetrySmsButton({ batchId, count }: { batchId: string; count: number }) {
  const { pending, run } = useRun();
  return (
    <button type="button" className={contactStyles.btnGhost} disabled={pending} onClick={() => run(() => retrySmsFailedAction(batchId))}>
      Retry {count} failed
    </button>
  );
}
