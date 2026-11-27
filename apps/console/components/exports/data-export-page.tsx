import type { Actor } from '@repo/core/permissions';
import { EXPORT_KEEP_HOURS, listMyExports, type ExportView } from '@repo/core/exports';
import { agencyTimeZone } from '@repo/core/widgets';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requestExportAction } from '../../lib/export-actions';

const STATUS: Record<string, string> = { queued: 'Waiting to start', building: 'Being prepared', ready: 'Ready', failed: 'Failed', expired: 'Deleted' };
const size = (b: number) => (b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * "Download all my data" (ADR 0104 phase 3), the same page on both consoles. Only the member's own exports are
 * listed, and each part is signed on click by /api/exports/full — never a stored link.
 */
export async function DataExportPage({ actor, page, error }: { actor: Actor; page: '/settings/data' | '/my-data'; error?: string }) {
  const db = getConsoleDb();
  const [exports, timeZone]: [ExportView[], string] = await Promise.all([listMyExports(db, actor), actor.agencyId ? agencyTimeZone(db, actor.agencyId) : Promise.resolve('Australia/Sydney')]);
  const busy = exports.some((e) => e.status === 'queued' || e.status === 'building');
  const when = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone });
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>Download your data</h1>
          <p className={contactStyles.sub}>
            Everything you can see in the console, as spreadsheets (CSV) with the real photos and documents, in zip files. We email you
            when it is ready; the files are kept for {EXPORT_KEEP_HOURS} hours, then deleted. Only you can download them.
          </p>
        </div>
        <form action={requestExportAction.bind(null, page)}>
          <button type="submit" className={contactStyles.btn} disabled={busy}>
            {busy ? 'Being prepared…' : 'Prepare my data'}
          </button>
        </form>
      </div>
      {error ? (
        <p role="alert" style={{ color: 'var(--rose)', margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div className={contactStyles.card}>
        {exports.length === 0 ? (
          <p className={`${contactStyles.empty} ${contactStyles.muted}`}>No exports yet.</p>
        ) : (
          <table className={contactStyles.table}>
            <thead>
              <tr>
                <th scope="col">Asked for</th>
                <th scope="col">Status</th>
                <th scope="col">Files</th>
              </tr>
            </thead>
            <tbody>
              {exports.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <time dateTime={e.createdAt.toISOString()}>{when.format(e.createdAt)}</time>
                  </td>
                  <td>
                    <span>{STATUS[e.status] ?? e.status}</span>
                    {e.status === 'building' || e.status === 'queued' ? ` (${e.progress}%)` : ''}
                    {e.status === 'ready' && e.expiresAt ? <div className={contactStyles.muted}>Kept until {when.format(e.expiresAt)}</div> : null}
                    {e.status === 'failed' && e.error ? <div className={contactStyles.muted}>{e.error}</div> : null}
                  </td>
                  <td>
                    {e.status === 'ready'
                      ? e.parts.map((p) => (
                          <div key={p.name}>
                            <a href={`/api/exports/full/${e.id}/${encodeURIComponent(p.name)}`}>{p.name}</a> <span className={contactStyles.muted}>{size(p.bytes)}</span>
                          </div>
                        ))
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
