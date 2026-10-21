import { notFound } from 'next/navigation';
import { LocalTime } from '@repo/ui';
import {
  getAgencyProfile,
  listAgencyPeople,
  listAgencyViewLog,
  listPlatformActions,
  PlatformError,
  type PlatformActionKind,
} from '@repo/core/platform';
import { AgencyControls } from '@/components/admin/controls';
import { PeopleTable, Stat, StatusBadge } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformView } from '@/lib/require-platform-admin';

const CHANGE_LABEL: Record<PlatformActionKind, string> = {
  agency_suspended: 'Suspended',
  agency_reactivated: 'Reactivated',
  plan_changed: 'Plan changed',
  member_blocked: 'Blocked',
  member_unblocked: 'Unblocked',
  owner_changed: 'Made owner',
};

/** The reason, or what it became — from the change's own record. */
function changeDetail(d: Record<string, unknown>): string {
  if (typeof d.reason === 'string') return d.reason;
  if (typeof d.to === 'string') return `as ${d.to}`;
  const to = d.to as { plan?: string; status?: string; trialEndsAt?: string | null } | undefined;
  if (to && typeof to === 'object') return [to.plan, to.status, to.trialEndsAt ? `trial to ${to.trialEndsAt.slice(0, 10)}` : null].filter(Boolean).join(' · ');
  if (Array.isArray(d.demoted) && d.demoted.length) return `${d.demoted.length} previous owner(s) now admin`;
  return '';
}

/** An agency's profile in the admin console: its details, figures, controls, people, and what the platform did and looked at. */
export default async function AgencyProfilePage({ params }: { params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await params;
  const view = await requirePlatformView(agencyId);
  await recordPlatformView(view.actor, 'profile');
  const db = getConsoleDb();
  const [profile, people, log, changes] = await Promise.all([
    getAgencyProfile(db, view.admin, agencyId).catch((err: unknown) => {
      if (err instanceof PlatformError && err.code === 'not_found') notFound();
      throw err;
    }),
    listAgencyPeople(db, view.admin, agencyId),
    listAgencyViewLog(db, view.admin, agencyId, 20),
    listPlatformActions(db, view.admin, agencyId, 20),
  ]);
  // Who could be made owner: active members who are not owners already.
  const candidates = people
    .filter((p) => p.status === 'active' && p.role !== 'owner')
    .map((p) => ({ userId: p.userId, name: p.name, role: p.role, status: p.status }));
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  return (
    <div className={styles.wrap}>
      {profile.status === 'suspended' ? (
        <p className={styles.bannerBad} role="status">
          Suspended{profile.suspendedAt ? <> since <LocalTime iso={profile.suspendedAt.toISOString()} style="date" /></> : null}
          {profile.suspendedReason ? <> — {profile.suspendedReason}</> : null}. Its members cannot sign in and its listings are off the
          public site.
        </p>
      ) : null}
      <div className={styles.stats}>
        <Stat label="Active members" value={profile.members} />
        <Stat label="Live listings" value={profile.liveListings} />
        <Stat label="Leads (30 days)" value={profile.leads30d} />
        <Stat label="Leads (all time)" value={profile.leadsTotal} />
        <Stat label="Customers" value={profile.contacts} />
        <Stat label="Upcoming meetings" value={profile.upcomingMeetings} />
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Details</h2>
            <dl className={styles.facts}>
              <dt>Status</dt><dd><StatusBadge status={profile.status} /></dd>
              <dt>Plan</dt><dd>{profile.plan ?? '—'}</dd>
              {profile.status === 'trial' ? (
                <><dt>Trial ends</dt><dd>{profile.trialEndsAt ? <LocalTime iso={profile.trialEndsAt.toISOString()} style="date" /> : 'Not set'}</dd></>
              ) : null}
              <dt>Slug</dt><dd>{profile.slug}</dd>
              <dt>ABN</dt><dd>{profile.abn ?? '—'}</dd>
              <dt>Time zone</dt><dd>{profile.timeZone}</dd>
              <dt>Joined</dt><dd><LocalTime iso={profile.createdAt.toISOString()} style="date" /></dd>
            </dl>
          </div>
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Who runs it</h2>
            {profile.owners.length === 0 ? (
              <p className={styles.muted}>No owner or admin on record.</p>
            ) : (
              <dl className={styles.facts}>
                {profile.owners.map((o) => (
                  <div key={o.userId} style={{ display: 'contents' }}>
                    <dt>{o.role === 'owner' ? 'Owner' : 'Admin'}</dt>
                    <dd>
                      {o.name} · {o.email}
                      {o.status !== 'active' ? <> <span className={styles.badgeWarn}>{o.status}</span></> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </section>
      </div>

      <AgencyControls
        agencyId={agencyId}
        agencyName={profile.name}
        status={profile.status}
        plan={profile.plan}
        trialEndsAt={day(profile.trialEndsAt)}
        members={candidates}
      />

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h2 className={styles.h2}>People ({people.length})</h2>
          <p className={styles.sub}>Open someone to see what they see, or to block their access.</p>
        </div>
        <PeopleTable rows={people} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h2 className={styles.h2}>Changes by the platform</h2>
        </div>
        {changes.length === 0 ? (
          <p className={styles.empty}>No changes.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr><th>When</th><th>Admin</th><th>Change</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={`${c.at.toISOString()}-${i}`}>
                  <td><LocalTime iso={c.at.toISOString()} /></td>
                  <td data-label="Admin">{c.adminName}</td>
                  <td data-label="Change">{CHANGE_LABEL[c.action] ?? c.action}{c.subjectName ? ` — ${c.subjectName}` : ''}</td>
                  <td data-label="Detail" className={styles.muted}>{changeDetail(c.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h2 className={styles.h2}>Platform access log</h2>
          <p className={styles.sub}>The latest pages of this agency opened from the admin console.</p>
        </div>
        {log.length === 0 ? (
          <p className={styles.empty}>Nothing recorded.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr><th>When</th><th>Admin</th><th>Opened</th><th>As</th></tr>
            </thead>
            <tbody>
              {log.map((r, i) => (
                <tr key={`${r.at.toISOString()}-${i}`}>
                  <td><LocalTime iso={r.at.toISOString()} /></td>
                  <td data-label="Admin">{r.adminName}</td>
                  <td data-label="Opened">{r.area.replace(/_/g, ' ')}</td>
                  <td data-label="As">{r.subjectName ?? <span className={styles.muted}>the agency</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
