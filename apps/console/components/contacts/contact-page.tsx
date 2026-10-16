import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  contactCounts,
  ContactError,
  getContact,
  listContactAssignees,
  listContactNotes,
  listContactProperties,
  listContactTimeline,
  parseContactTab,
  type ContactAssignee,
} from '@repo/core/contacts';
import { listAgencyLeads, listLeadAssignees, type LeadAssignee } from '@repo/core/leads';
import { getMailThread, listMailThreads, mailConfigFromEnv, MailError } from '@repo/core/mail';
import { appointmentListQuerySchema, listAppointments } from '@repo/core/appointments';
import { requireIntegrations } from '@repo/core/integrations';
import { ConnectFirst } from '@/components/integrations/integration-ui';
import { can } from '@repo/core/permissions';
import { Agenda } from '@/components/appointments/agenda';
import { toItem } from '@/components/appointments/item';
import { SchedulePanel } from '@/components/appointments/schedule-panel';
import { LeadTable } from '@/components/lead-table';
import { ThreadList, ThreadReader } from '@/components/inbox/inbox-view';
import { MailSync } from '@/components/inbox/islands';
import inboxStyles from '@/components/inbox/inbox.module.css';
import { getConsoleDb } from '../../lib/db';
import { loadListingActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import {
  ContactFrame,
  NotConnected,
  NotesTab,
  OverviewTab,
  PropertiesTab,
  TimelineList,
  tabHref,
} from './contact-profile';
import styles from './contacts.module.css';

/**
 * The contact profile page body, shared by `/customers/[id]` and
 * `/my-contacts/[id]` — one app, so shared as a component rather than copied,
 * like InboxPage.
 *
 * Only the open tab's data is read: the contact and its tab counts on every
 * tab (two statements, started together), then the one tab's list. Every read
 * is scoped in packages/core by can() and the inbox's own filters, so an
 * agent's tabs hold exactly what their leads and inbox would show them.
 */
export async function ContactPage({
  surface,
  params,
  searchParams,
}: {
  surface: 'agency' | 'agent';
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess(surface);
  const { id } = await params;
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const tab = parseContactTab(sp.tab);
  const basePath = surface === 'agency' ? '/customers' : '/my-contacts';
  const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000';
  const db = getConsoleDb();

  // With listing links: an agent may work a lead from their own listing, and
  // the Enquiries and Emails tabs draw their controls from can() on that.
  const actor = (await loadListingActor(session.actor.userId)) ?? session.actor;

  let view: Awaited<ReturnType<typeof getContact>>;
  try {
    view = await getContact(db, actor, id);
  } catch (err) {
    return (
      <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>
        {err instanceof ContactError ? err.message : 'Failed to load the contact'}
      </p>
    );
  }
  if ('mergedInto' in view) redirect(`${basePath}/${view.mergedInto}`);
  const c = view;

  const counts = await contactCounts(db, actor, c.ref);
  let body: React.ReactNode = null;

  switch (tab) {
    case 'overview': {
      const [recent, assignees] = await Promise.all([
        listContactTimeline(db, actor, c.ref, { limit: 6 }),
        c.mayAssign ? listContactAssignees(db, actor) : Promise.resolve<ContactAssignee[]>([]),
      ]);
      body = (
        <OverviewTab
          contact={c}
          basePath={basePath}
          editing={first(sp.edit) === '1'}
          assignees={assignees}
          counts={counts}
          recent={recent.items}
        />
      );
      break;
    }
    case 'timeline': {
      const page = await listContactTimeline(db, actor, c.ref, { before: first(sp.before) });
      body = (
        <div className={styles.card}>
          <div className={styles.section} style={{ borderTop: 0 }}>
            <TimelineList items={page.items} basePath={basePath} contactId={c.id} />
            {page.nextBefore ? (
              <a href={tabHref(basePath, c.id, 'timeline', { before: page.nextBefore })} className={styles.back}>
                Older →
              </a>
            ) : null}
          </div>
        </div>
      );
      break;
    }
    case 'properties': {
      const properties = await listContactProperties(db, actor, c.ref);
      body = <PropertiesTab contact={c} properties={properties} webUrl={webUrl} />;
      break;
    }
    case 'emails': {
      const threadId = first(sp.thread)?.trim() || null;
      const [list, opened, assignees] = await Promise.all([
        listMailThreads(db, actor, { contactId: c.id, limit: 50 }),
        threadId
          ? getMailThread(db, actor, threadId).then(
              (v) => ({ ok: true as const, view: v }),
              (err: unknown) => ({
                ok: false as const,
                error: err instanceof MailError ? err.message : 'Could not open that conversation',
              }),
            )
          : Promise.resolve(null),
        listLeadAssignees(db, actor).catch((): LeadAssignee[] => []),
      ]);
      const back = tabHref(basePath, c.id, 'emails');
      // A thread of somebody else's, opened by id here, is refused like any other.
      const belongs = opened?.ok && list.rows.some((r) => r.id === opened.view.id);
      body = (
        <section className={inboxStyles.card} aria-label="Conversations">
          <MailSync />
          {opened === null && c.mayEmail ? (
            <div className={inboxStyles.toolbar} style={{ justifyContent: 'flex-end' }}>
              <Link href={`${surface === 'agency' ? '/inbox' : '/my-inbox'}/new?contact=${c.id}`} className={inboxStyles.newButton}>
                New email to {c.name}
              </Link>
            </div>
          ) : null}
          {opened === null ? (
            <ThreadList
              rows={list.rows}
              threadHref={(t) => tabHref(basePath, c.id, 'emails', { thread: t })}
              emptyTitle="No conversations you can see"
              emptyHint="Every enquiry from this person starts a conversation; email they send the agency lands here too."
            />
          ) : opened.ok && belongs ? (
            <ThreadReader
              view={opened.view}
              unread={list.rows.find((r) => r.id === opened.view.id)?.unread ?? true}
              backHref={back}
              backLabel={`← ${c.name}'s conversations`}
              assignees={assignees}
              inboundOn={mailConfigFromEnv() !== null}
              webUrl={webUrl}
            />
          ) : (
            <p className={inboxStyles.alert} role="alert">
              {opened.ok ? 'That conversation was not found' : opened.error}
            </p>
          )}
        </section>
      );
      break;
    }
    case 'enquiries': {
      const [leads, assignees] = await Promise.all([
        listAgencyLeads(db, actor, { contactId: c.id, limit: 100 }),
        listLeadAssignees(db, actor),
      ]);
      body = (
        <LeadTable
          compact
          basePath={surface === 'agency' ? '/leads' : '/my-leads'}
          inboxPath={surface === 'agency' ? '/inbox' : '/my-inbox'}
          webUrl={webUrl}
          rows={leads.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
          counts={leads.counts}
          maySeeOffers={leads.maySeeOffers}
          assignees={assignees}
        />
      );
      break;
    }
    case 'notes': {
      const notes = await listContactNotes(db, actor, c.ref);
      body = <NotesTab contact={c} notes={notes} />;
      break;
    }
    case 'calendar': {
      const { when } = appointmentListQuerySchema.parse({ when: first(sp.when) });
      const mayBook = can(actor, 'appointment:create', { type: 'appointment', agencyId: c.ref.agencyId });
      const mayAssign = can(actor, 'appointment:assign', { type: 'appointment', agencyId: c.ref.agencyId });
      const [list, properties, assignees, integrations] = await Promise.all([
        listAppointments(db, actor, { contact: c.ref, when }),
        mayBook ? listContactProperties(db, actor, c.ref) : Promise.resolve([]),
        mayAssign ? listContactAssignees(db, actor) : Promise.resolve<ContactAssignee[]>([]),
        requireIntegrations(db, actor, ['google_calendar', 'zoom']),
      ]);
      const [calendarReq, zoomReq] = integrations.results as [
        (typeof integrations.results)[number],
        (typeof integrations.results)[number],
      ];
      body = (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div className={styles.inlineForm} style={{ justifyContent: 'space-between' }}>
            <nav className={styles.inlineForm} aria-label="Which appointments">
              <a href={tabHref(basePath, c.id, 'calendar')} className={`${styles.tab} ${when === 'upcoming' ? styles.tabOn : ''}`}>Upcoming</a>
              <a href={tabHref(basePath, c.id, 'calendar', { when: 'past' })} className={`${styles.tab} ${when === 'past' ? styles.tabOn : ''}`}>Past</a>
            </nav>
            {mayBook ? (
              <SchedulePanel
                contactId={c.id}
                contactHasEmail={Boolean(c.email)}
                properties={properties.map((p) => ({ propertyId: p.propertyId, address: p.address }))}
                assignees={assignees.filter((a) => a.userId !== actor.userId)}
                zoom={{
                  state: zoomReq.state,
                  ownerType: zoomReq.ownerType,
                  accountLabel: zoomReq.accountLabel,
                  integrationsPath: basePath === '/customers' ? '/settings/integrations' : '/my-integrations',
                }}
              />
            ) : null}
          </div>
          <Agenda
            items={list.rows.map(toItem)}
            showContact={false}
            contactBasePath={basePath}
            emptyText={when === 'upcoming' ? 'Nothing booked with them that you can see.' : 'No past appointments you can see.'}
          />
          <ConnectFirst requirement={calendarReq} purpose="Appointments assigned to you are added to your Google Calendar, and moved or removed with them." />
          <ConnectFirst requirement={zoomReq} purpose="A Zoom appointment creates its own meeting, moved and deleted with it." />
        </div>
      );
      break;
    }
    case 'reviews':
      body = <NotConnected which="reviews" />;
      break;
  }

  return (
    <ContactFrame
      contact={c}
      basePath={basePath}
      tab={tab}
      counts={counts}
      askHref={`${surface === 'agency' ? '/overview' : '/assistant'}?contact=${c.id}`}
    >
      {body}
    </ContactFrame>
  );
}
