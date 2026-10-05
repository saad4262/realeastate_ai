import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import {
  BATCH_STATUS_LABELS,
  ensureTemplateEmailSkill,
  listBatches,
  listMyFilters,
  listTemplates,
  TEMPLATE_STATUS_LABELS,
  TemplateEmailError,
} from '@repo/core/template-email';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { PrepareForm } from './islands';

/**
 * Bulk email (docs/adr/0022): prepare a batch from an approved template and a
 * saved filter, the batches (an agent's own; an admin sees the agency's),
 * and the templates. Shared by `/bulk-email` and `/my-bulk-email`.
 */
export async function BulkEmailPage({ surface }: { surface: 'agency' | 'agent' }) {
  const session = await requireConsoleAccess(surface);
  const basePath = surface === 'agency' ? '/bulk-email' : '/my-bulk-email';
  const db = getConsoleDb();
  let data: [Awaited<ReturnType<typeof listBatches>>, Awaited<ReturnType<typeof listTemplates>>, Awaited<ReturnType<typeof listMyFilters>>];
  try {
    await ensureTemplateEmailSkill(db);
    data = await Promise.all([listBatches(db, session.actor), listTemplates(db, session.actor), listMyFilters(db, session.actor)]);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof TemplateEmailError ? err.message : 'Failed to load bulk email'}</p>;
  }
  const [batches, { templates, mayDraft }, filters] = data;
  const approved = templates.filter((t) => t.status === 'approved');
  const dev = process.env.NODE_ENV !== 'production';

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>Bulk email</h1>
        <p className={contactStyles.sub}>
          An approved template to the contacts in one of your saved filters — only people who agreed to marketing
          email. Prepare, check every name, then Approve &amp; Send. Nothing is ever sent on a schedule.
        </p>
      </div>
      {dev ? (
        <p className={contactStyles.archivedBanner} role="note">
          Development: emails go only to addresses on <code>EMAIL_DEV_ALLOWLIST</code>; everyone else is marked
          skipped (&ldquo;dev allowlist&rdquo;).
        </p>
      ) : null}

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Prepare a send</h2>
          <PrepareForm
            basePath={basePath}
            templates={approved.map((t) => ({ id: t.id, name: t.name }))}
            filters={filters.map((f) => ({ id: f.id, name: f.name }))}
          />
        </div>
      </section>

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Batches</h2>
          {batches.length === 0 ? (
            <p className={contactStyles.note}>None yet.</p>
          ) : (
            <ul className={contactStyles.plainList}>
              {batches.map((b) => (
                <li key={b.id} className={contactStyles.plainItem}>
                  <span style={{ display: 'grid', gap: '0.15rem' }}>
                    <Link href={`${basePath}/${b.id}`} className={contactStyles.name}>{b.templateName}</Link>
                    <span className={contactStyles.muted}>
                      {b.filterName} · {BATCH_STATUS_LABELS[b.status]}
                      {b.agentName && surface === 'agency' ? ` · ${b.agentName}` : ''} · prepared <LocalTime iso={b.preparedAt.toISOString()} style="short" />
                    </span>
                  </span>
                  <span className={contactStyles.muted}>
                    {b.counts.sent ? `${b.counts.sent} sent · ` : ''}
                    {b.counts.toSend ? `${b.counts.toSend} to send · ` : ''}
                    {b.counts.skipped} skipped
                    {b.counts.failed ? ` · ${b.counts.failed} failed` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <div className={contactStyles.inlineForm} style={{ justifyContent: 'space-between' }}>
            <h2 className={contactStyles.sectionTitle}>Templates</h2>
            {mayDraft ? <Link href={`${basePath}/templates/new`} className={contactStyles.btnGhost}>+ New template</Link> : null}
          </div>
          {templates.length === 0 ? (
            <p className={contactStyles.note}>No templates yet.</p>
          ) : (
            <ul className={contactStyles.plainList}>
              {templates.map((t) => (
                <li key={t.id} className={contactStyles.plainItem}>
                  <span style={{ display: 'grid', gap: '0.15rem' }}>
                    <Link href={`${basePath}/templates/${t.id}`} className={contactStyles.name}>{t.name}</Link>
                    <span className={contactStyles.muted}>{t.subject}</span>
                  </span>
                  <span className={t.status === 'approved' ? contactStyles.chip : contactStyles.chipInferred}>
                    {TEMPLATE_STATUS_LABELS[t.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
