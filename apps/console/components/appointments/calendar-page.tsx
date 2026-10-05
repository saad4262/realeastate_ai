import Link from 'next/link';
import {
  AppointmentError,
  appointmentListQuerySchema,
  listAppointments,
  type AppointmentPage,
} from '@repo/core/appointments';
import { listContactAssignees, type ContactAssignee } from '@repo/core/contacts';
import { requireIntegrations, type IntegrationCheck } from '@repo/core/integrations';
import { ConnectFirst } from '@/components/integrations/integration-ui';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { Agenda } from './agenda';
import { toItem } from './item';

/**
 * The calendar page, shared by the agency's `/calendar` and the agent's
 * `/my-calendar` (ADR 0019). Which appointments are in it is
 * `listAppointments`' business: the whole agency's for an admin, only their
 * own (assigned or booked by them) for anybody else. A list grouped by day in
 * the viewer's own timezone — no calendar library.
 *
 * Booking starts from a contact (their Calendar tab), because every
 * appointment is with somebody.
 */
export async function CalendarPage({
  surface,
  searchParams,
}: {
  surface: 'agency' | 'agent';
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess(surface);
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const query = appointmentListQuerySchema.parse({ when: first(sp.when), agent: first(sp.agent) || undefined });
  const basePath = surface === 'agency' ? '/calendar' : '/my-calendar';
  const contactBase = surface === 'agency' ? '/customers' : '/my-contacts';

  let page: AppointmentPage | null = null;
  let agents: ContactAssignee[] = [];
  let integrations: IntegrationCheck | null = null;
  let loadError: string | null = null;
  try {
    [page, agents, integrations] = await Promise.all([
      listAppointments(getConsoleDb(), session.actor, query),
      listContactAssignees(getConsoleDb(), session.actor),
      requireIntegrations(getConsoleDb(), session.actor, ['google_calendar']),
    ]);
  } catch (err) {
    loadError = err instanceof AppointmentError ? err.message : 'Failed to load the calendar';
  }
  if (loadError || !page) {
    return (
      <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>
        {loadError}
      </p>
    );
  }

  const href = (when: string, agent?: string) => {
    const p = new URLSearchParams();
    if (when !== 'upcoming') p.set('when', when);
    if (agent) p.set('agent', agent);
    const s = p.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{surface === 'agency' ? 'Calendar' : 'My calendar'}</h1>
          <p className={contactStyles.sub}>
            {page.seesAll
              ? "Every appointment in the agency. Book one from a contact's Calendar tab."
              : "Your appointments. Book one from a contact's Calendar tab."}
          </p>
        </div>
      </div>
      <div className={contactStyles.inlineForm} style={{ justifyContent: 'space-between' }}>
        <nav className={contactStyles.inlineForm} aria-label="Which appointments">
          <Link href={href('upcoming', query.agent)} className={`${contactStyles.tab} ${query.when === 'upcoming' ? contactStyles.tabOn : ''}`}>Upcoming</Link>
          <Link href={href('past', query.agent)} className={`${contactStyles.tab} ${query.when === 'past' ? contactStyles.tabOn : ''}`}>Past</Link>
        </nav>
        {page.seesAll && agents.length ? (
          <form method="get" action={basePath} className={contactStyles.inlineForm}>
            {query.when !== 'upcoming' ? <input type="hidden" name="when" value={query.when} /> : null}
            <select className={contactStyles.select} name="agent" defaultValue={query.agent ?? ''} aria-label="Agent">
              <option value="">Every agent</option>
              {agents.map((a) => (
                <option key={a.userId} value={a.userId}>{a.name}</option>
              ))}
            </select>
            <button type="submit" className={contactStyles.btnGhost}>Show</button>
          </form>
        ) : null}
      </div>
      <Agenda
        items={page.rows.map(toItem)}
        showContact
        contactBasePath={contactBase}
        emptyText={query.when === 'upcoming' ? 'Nothing booked yet.' : 'No past appointments.'}
      />
      {integrations?.results[0] ? (
        <ConnectFirst requirement={integrations.results[0]} purpose="Appointments will be added to your Google Calendar (Phase 3b)." />
      ) : null}
    </div>
  );
}
