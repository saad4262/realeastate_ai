import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { AUDIENCE_LABEL, describeAudience, listPlatformEmails, type EmailAudience } from '@repo/core/platform';
import { EmailComposer } from '@/components/admin/email-composer';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

/**
 * Email from the platform team (ADR 0052): write to one agency, member or user
 * (arriving from their page with ?kind=…), or to a whole audience; and every
 * email sent so far, with how many went out.
 */
function targetOf(sp: Record<string, string | string[] | undefined>): EmailAudience | null {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const kind = one('kind');
  const agencyId = one('agencyId');
  const userId = one('userId');
  if (kind === 'agency' && agencyId) return { kind, agencyId };
  if (kind === 'member' && agencyId && userId) return { kind, agencyId, userId };
  if (kind === 'user' && userId) return { kind, userId };
  return null;
}

export default async function EmailsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'emails');
  const target = targetOf(await searchParams);
  const db = getConsoleDb();
  const [label, sent] = await Promise.all([
    target ? describeAudience(db, admin, target).catch(() => null) : Promise.resolve(null),
    listPlatformEmails(db, admin, { limit: 50 }),
  ]);

  return (
    <div className={styles.wrap}>
      <div className={styles.headText}>
        <h1 className={styles.title}>Emails</h1>
        <p className={styles.sub}>
          Write to an agency, an agent or a user from their page, or to everyone here. Sent from the platform’s address; each
          one is recorded below.
        </p>
      </div>

      {target && !label ? (
        <p role="alert" className={styles.alert}>That recipient was not found.</p>
      ) : (
        <EmailComposer target={target} targetLabel={label} />
      )}
      {target ? (
        <p className={styles.sub} style={{ margin: 0 }}>
          <Link href="/emails">Write to a whole audience instead →</Link>
        </p>
      ) : null}

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h2 className={styles.h2}>Sent</h2>
        </div>
        {sent.length === 0 ? (
          <p className={styles.empty}>Nothing sent yet.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>When</th><th>Subject</th><th>To</th><th>By</th><th className={styles.num}>Sent</th><th className={styles.num}>Failed</th><th className={styles.num}>Waiting</th></tr>
              </thead>
              <tbody>
                {sent.map((e) => (
                  <tr key={e.id}>
                    <td><LocalTime iso={e.at.toISOString()} /></td>
                    <td data-label="Subject"><span className={styles.name}>{e.subject}</span></td>
                    <td data-label="To">{e.targetName ?? AUDIENCE_LABEL[e.audience]}<div className={styles.muted}>{e.recipients} {e.recipients === 1 ? 'person' : 'people'}</div></td>
                    <td data-label="By">{e.adminName}</td>
                    <td data-label="Sent" className={styles.num}>{e.sent}</td>
                    <td data-label="Failed" className={styles.num}>{e.failed}</td>
                    <td data-label="Waiting" className={styles.num}>{e.queued}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
