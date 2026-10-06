import Link from 'next/link';
import { listImports } from '@repo/core/imports';
import { can } from '@repo/core/permissions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { UploadForm } from './upload-form';

const STATUS: Record<string, string> = {
  mapped: 'Waiting for columns to be matched',
  validating: 'Checking…',
  validated: 'Checked — ready to import',
  importing: 'Importing…',
  done: 'Done',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

/**
 * Import listings from a CSV (docs/adr/0029). Shared by the agency's
 * /live-listings/import and the agent's /listings/import; what each person may
 * do is can()'s, in packages/core.
 */
export async function ImportStart({ surface }: { surface: 'agency' | 'agent' }) {
  const session = await requireConsoleAccess(surface);
  const base = surface === 'agency' ? '/live-listings/import' : '/listings/import';
  const imports = await listImports(getConsoleDb(), session.actor);
  const mayPublish = can(session.actor, 'listing:publish', { type: 'listing', agencyId: session.actor.agencyId as string });
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>Import listings from a CSV</h1>
          <p className={contactStyles.sub}>
            Up to 5,000 rows. You match the columns, we check every row and show you each problem, and only then does anything get imported.
            {mayPublish ? ' Your import goes live (or as drafts, if you choose).' : ' Your listings arrive waiting for an owner or admin to approve them.'}{' '}
            <a href="/import-template.csv" download>Download the template</a> — it shows every column and three example rows.
          </p>
        </div>
      </div>
      <section className={contactStyles.card} style={{ padding: '1rem' }}>
        <UploadForm base={base} mayPublish={mayPublish} />
      </section>
      {imports.length ? (
        <section className={contactStyles.card} style={{ padding: '1rem', marginTop: '1rem' }}>
          <h2 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Earlier imports</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.375rem' }}>
            {imports.map((i) => (
              <li key={i.id}>
                <Link href={`${base}/${i.id}`}>{i.fileName}</Link> — {i.totalRows.toLocaleString('en-AU')} rows · {STATUS[i.status] ?? i.status} ·{' '}
                {i.createdAt.toLocaleDateString('en-AU')}
                {i.mine ? '' : ' (someone else’s)'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
