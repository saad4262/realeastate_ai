'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BASE_MERGE_FIELDS, LISTING_MERGE_FIELDS, templateInputSchema } from '@repo/core/template-email/schema';
import { useToast } from '@/components/toast';
import {
  approveAndSendAction,
  cancelBatchAction,
  createTemplateAction,
  prepareBatchAction,
  retryFailedAction,
  saveFilterAction,
  retireTemplateAction,
  updateTemplateAction,
  type TemplateEmailResult,
} from '@/lib/template-email-actions';
import contactStyles from '@/components/contacts/contacts.module.css';

/**
 * The bulk email screens' client islands (docs/adr/0022). Every button is
 * drawn from a decision can() made on the server; every action checks again.
 */

function useRun() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<TemplateEmailResult>, ok?: string, after?: (r: TemplateEmailResult & { ok: true }) => void) =>
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

export function TemplateForm({
  basePath,
  templateId,
  initial,
}: {
  basePath: string;
  templateId?: string;
  initial?: { name: string; subject: string; body: string };
}) {
  const { pending, run, router } = useRun();
  const [name, setName] = useState(initial?.name ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState(initial?.body ?? 'Hi {{first_name}},\n\n\n\n{{agent_name}}\n{{agency_name}}');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={contactStyles.form}
      onSubmit={(e) => {
        e.preventDefault();
        const input = { name, subject, body };
        const check = templateInputSchema.safeParse(input);
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Check the template');
          return;
        }
        setError(null);
        run(
          () => (templateId ? updateTemplateAction(templateId, input) : createTemplateAction(input)),
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
        <span className={contactStyles.label}>Subject</span>
        <input className={contactStyles.input} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} />
      </label>
      <label className={contactStyles.field}>
        <span className={contactStyles.label}>Email</span>
        <textarea className={contactStyles.textarea} rows={12} value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} />
        <span className={contactStyles.hint}>
          Merge fields: {BASE_MERGE_FIELDS.map((f) => `{{${f}}}`).join(' ')}. For a template sent from a listing&apos;s Matching
          buyers tab, also {LISTING_MERGE_FIELDS.map((f) => `{{${f}}}`).join(' ')} — such a template can only be sent from there.
          An unsubscribe link and the agency&apos;s details are added to every email automatically.
        </span>
      </label>
      <div className={contactStyles.actions}>
        <button type="submit" className={contactStyles.btn} disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/** A template's one step (ADR 0043 — no approval): retire it. */
export function TemplateSteps({ id, mayRetire }: { id: string; mayRetire: boolean }) {
  const { pending, run } = useRun();
  return (
    <div className={contactStyles.inlineForm}>
      {mayRetire ? (
        <button
          type="button"
          className={contactStyles.linkBtn}
          disabled={pending}
          onClick={() => window.confirm('Retire this template? It can no longer be used for new batches.') && run(() => retireTemplateAction(id), 'Retired')}
        >
          Retire
        </button>
      ) : null}
    </div>
  );
}

export function PrepareForm({
  basePath,
  templates,
  filters,
}: {
  basePath: string;
  templates: { id: string; name: string }[];
  filters: { id: string; name: string }[];
}) {
  const { pending, run, router } = useRun();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [filterId, setFilterId] = useState(filters[0]?.id ?? '');
  if (!templates.length) return <p className={contactStyles.note}>No template yet — write one under Templates; it is ready to use as soon as it is saved.</p>;
  if (!filters.length) return <p className={contactStyles.note}>No saved filter yet — filter the contact list and press “Save this filter”.</p>;
  return (
    <form
      className={contactStyles.inlineForm}
      onSubmit={(e) => {
        e.preventDefault();
        run(() => prepareBatchAction(templateId, filterId), 'Prepared — check the list before sending', (r) => r.id && router.push(`${basePath}/${r.id}`));
      }}
    >
      <select className={contactStyles.select} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
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

/** One press sends. The button locks at once; the server would refuse a second send anyway. */
export function ApproveSendButton({ batchId, count }: { batchId: string; count: number }) {
  const { pending, run } = useRun();
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      className={contactStyles.btn}
      disabled={pending || pressed}
      onClick={() => {
        if (!window.confirm(`Send this email to ${count} ${count === 1 ? 'person' : 'people'} now?`)) return;
        setPressed(true);
        run(() => approveAndSendAction(batchId));
      }}
    >
      {pending || pressed ? 'Sending…' : `Approve & Send to ${count}`}
    </button>
  );
}

export function CancelBatchButton({ batchId }: { batchId: string }) {
  const { pending, run } = useRun();
  return (
    <button type="button" className={contactStyles.btnGhost} disabled={pending} onClick={() => window.confirm('Cancel this batch? Nothing has been sent.') && run(() => cancelBatchAction(batchId), 'Cancelled')}>
      Cancel
    </button>
  );
}

export function RetryFailedButton({ batchId, count }: { batchId: string; count: number }) {
  const { pending, run } = useRun();
  return (
    <button type="button" className={contactStyles.btnGhost} disabled={pending} onClick={() => run(() => retryFailedAction(batchId))}>
      Retry {count} failed
    </button>
  );
}

/** While a batch is sending, refresh every few seconds so the list fills in. */
export function RefreshWhileSending({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

/** "Save this filter" on the contact directory — the query from the URL. */
export function SaveFilterForm({ query }: { query: Record<string, string | undefined> }) {
  const { pending, run } = useRun();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) {
    return (
      <button type="button" className={contactStyles.linkBtn} onClick={() => setOpen(true)}>
        Save this filter
      </button>
    );
  }
  return (
    <form
      className={contactStyles.inlineForm}
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveFilterAction(name, query), 'Filter saved — use it in Bulk email', () => {
          setOpen(false);
          setName('');
        });
      }}
    >
      <input className={contactStyles.input} style={{ minWidth: 0, flex: '0 1 14rem' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Pakenham buyers" maxLength={80} />
      <button type="submit" className={contactStyles.btnGhost} disabled={pending || name.trim().length < 2}>Save</button>
      <button type="button" className={contactStyles.linkBtn} onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
