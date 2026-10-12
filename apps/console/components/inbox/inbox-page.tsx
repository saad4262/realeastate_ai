import { listLeadAssignees, type LeadAssignee } from '@repo/core/leads';
import {
  agencyMailAddress,
  getMailThread,
  listMailThreads,
  MailError,
  mailConfigFromEnv,
  parseMailFolder,
  type MailThreadPage,
} from '@repo/core/mail';
import { can } from '@repo/core/permissions';
import { getConsoleDb } from '../../lib/db';
import { loadActorContext, loadListingActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { InboxView, type InboxViewProps } from './inbox-view';
import styles from './inbox.module.css';

/**
 * The inbox page body, shared by `/inbox` (agency console) and `/my-inbox`
 * (agent desk). Both route groups are one app, so this is shared as a
 * component rather than copied (surface-boundaries rule 5); the decisions it
 * relies on are all in packages/core.
 *
 * What differs between the two is only which actor arrives: an owner on the
 * agency host sees the whole agency's mail, an agent sees their own leads' —
 * narrowed in SQL by `listMailThreads`, never by this file.
 */
export async function InboxPage({
  surface,
  searchParams,
}: {
  surface: 'agency' | 'agent';
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess(surface);
  const params = await searchParams;
  const folder = parseMailFolder(params.folder);
  const rawThread = Array.isArray(params.thread) ? params.thread[0] : params.thread;
  const threadId = rawThread?.trim() || null;
  const basePath = surface === 'agency' ? '/inbox' : '/my-inbox';

  const db = getConsoleDb();
  // With listing links: an agent's own leads include those on listings they
  // are named on, which can() can only see if it knows them.
  const [actor, context] = await Promise.all([
    loadListingActor(session.actor.userId),
    loadActorContext(session.actor.userId),
  ]);
  const who = actor ?? session.actor;

  // The list, the open thread and the assign picker do not depend on each
  // other — started together (ARCHITECTURE § 5).
  const [listed, opened, assignees] = await Promise.all([
    listMailThreads(db, who, { folder, limit: 50 }).then(
      (page): { ok: true; page: MailThreadPage } => ({ ok: true, page }),
      (err: unknown) => ({
        ok: false as const,
        error: err instanceof MailError ? err.message : 'Could not load the inbox',
      }),
    ),
    threadId
      ? getMailThread(db, who, threadId).then(
          (view) => ({ ok: true as const, view }),
          (err: unknown) => ({
            ok: false as const,
            error: err instanceof MailError ? err.message : 'Could not open that conversation',
          }),
        )
      : Promise.resolve(null),
    listLeadAssignees(db, who).catch((): LeadAssignee[] => []),
  ]);

  if (!listed.ok) {
    return (
      <p role="alert" className={styles.alert}>
        {listed.error}
      </p>
    );
  }

  const config = mailConfigFromEnv();
  const slug = context?.agencySlug ?? null;

  let thread: InboxViewProps['thread'] = null;
  if (opened?.ok) {
    // Not on this page of the list (another folder, or older): treat as unread
    // so opening it refreshes the badge. A wasted refresh is the whole cost.
    const listedRow = listed.page.rows.find((r) => r.id === opened.view.id);
    thread = { ok: true, view: opened.view, unread: listedRow ? listedRow.unread : true };
  } else if (opened) {
    thread = { ok: false, error: opened.error };
  }

  return (
    <InboxView
      basePath={basePath}
      folder={folder}
      page={listed.page}
      thread={thread}
      assignees={assignees}
      // Only the agency console shows the agency's address: it is the
      // owners' and admins' mailbox (ADR 0016).
      agencyAddress={surface === 'agency' && config && slug ? agencyMailAddress(slug, config) : null}
      inboundOn={config !== null}
      webUrl={process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000'}
      // A contact of their own would pass: the question is whether they may write at all.
      mayCompose={can(who, 'mail:compose', { type: 'contact', agencyId: who.agencyId ?? undefined, ownerId: who.userId })}
    />
  );
}
