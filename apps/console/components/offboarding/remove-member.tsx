'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { OffboardPreview, RemovalReport } from '@repo/core/team';
import { removeMemberAction } from '@/lib/offboarding-actions';

const box: React.CSSProperties = { border: '1px solid var(--border-default)', borderRadius: '0.5rem', background: 'var(--surface-card)', padding: '1rem', marginTop: '1rem' };

/**
 * Remove a member (ADR 0030 §5). The admin MUST pick who receives the work or
 * "leave it for review" — Remove stays disabled until they do (decided Q1).
 */
export function RemoveMember({ preview }: { preview: OffboardPreview }) {
  const [choice, setChoice] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RemovalReport | null>(null);
  const [pending, start] = useTransition();
  const c = preview.counts;
  const name = preview.member.name || preview.member.email;

  if (report) return <Report name={name} report={report} />;

  const rows: [string, number][] = [
    ['Upcoming appointments', c.upcomingAppointments],
    ['Contacts assigned to them', c.contacts],
    ['Leads assigned to them', c.leads],
    [`Listings they are an agent on (${c.onlyAgentListings} with no other agent)`, c.listings],
    ['Assistant cards waiting or scheduled (will be cancelled)', c.waitingCards],
    ['Prepared bulk emails (will be cancelled)', c.preparedBatches],
    ['Listing imports in progress (will be cancelled)', c.runningImports],
    ['Dashboards they made (kept; admins manage them)', c.dashboards],
    ['Their own connected accounts (access revoked and deleted)', c.ownAccounts],
    ['Agency accounts they connected (keep working, flagged for you to reconnect)', c.agencyAccountsTheyConnected],
  ];

  return (
    <div style={{ padding: '1.5rem', maxWidth: '48rem' }}>
      <h1 style={{ margin: 0, font: '700 1.375rem/1.2 var(--font-display)' }}>Remove {name} from the agency</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        {preview.member.email} · {preview.member.role}. They lose access straight away. You can undo this for 30 days; their
        connected accounts do not come back (they reconnect), and work you move stays moved.
      </p>
      <section style={box}>
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>What this touches</h2>
        <table style={{ width: '100%', fontSize: '0.875rem' }}>
          <tbody>
            {rows.map(([label, n]) => (
              <tr key={label}>
                <td style={{ padding: '0.25rem 0' }}>{label}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
          Their notes, sent emails and history stay, with their name — they belong to the agency. Their assistant
          conversations are deleted.
        </p>
      </section>
      <section style={box}>
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Who receives their work?</h2>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} style={{ width: '100%', padding: '0.4rem' }}>
          <option value="">— Choose —</option>
          {preview.receivers.map((r) => (
            <option key={r.userId} value={r.userId}>
              {r.name}
            </option>
          ))}
          <option value="review">Nobody yet — leave it unassigned for review (the “Needs an owner” list)</option>
        </select>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          Their upcoming appointments move to that person’s calendar (removed from {name}’s first, while their access still
          works). A Zoom meeting on {name}’s own Zoom gets a new link — resend those invitations.
        </p>
        <label style={{ display: 'block', fontSize: '0.875rem' }}>
          Type <strong>REMOVE</strong> to confirm{' '}
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ marginLeft: '0.5rem' }} />
        </label>
        {error ? <p role="alert" style={{ color: 'var(--rose)' }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
          <button
            type="button"
            disabled={!choice || confirmText !== 'REMOVE' || pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await removeMemberAction(preview.member.userId, choice === 'review' ? { review: true } : { receiver: choice });
                if (r.ok) setReport(r.report);
                else setError(r.error);
              })
            }
            style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 0, background: 'var(--rose, #c0392b)', color: '#fff', fontWeight: 600 }}
          >
            {pending ? 'Removing…' : `Remove ${name}`}
          </button>
          <Link href="/team">Cancel</Link>
        </div>
      </section>
    </div>
  );
}

export function Report({ name, report: r }: { name: string; report: RemovalReport }) {
  const key = r.choice === 'receiver' ? r.moved : r.flagged;
  return (
    <div style={{ padding: '1.5rem', maxWidth: '48rem' }}>
      <h1 style={{ margin: 0, font: '700 1.375rem/1.2 var(--font-display)' }}>{name} was removed</h1>
      <ul>
        <li>
          {r.choice === 'receiver' ? 'Moved' : 'Left for review'}: {key.contacts} contacts, {key.leads} leads, {key.appointments} upcoming
          appointments, {key.listings} listings that had no other agent.
        </li>
        <li>
          Calendar events removed from their calendar: {r.calendar.removed}
          {r.calendar.notRemoved ? ` — ${r.calendar.notRemoved} could not be removed (their Google access had already ended); they may still see them` : ''}.
          {r.synced ? ` ${r.synced} added to the new agent’s calendar/Zoom.` : ''}
        </li>
        {r.zoom.linkChanged ? <li>{r.zoom.linkChanged} Zoom appointment(s) will get a new link — resend those invitations (marked on each contact).</li> : null}
        <li>
          Cancelled: {r.cancelled.cards} assistant cards, {r.cancelled.batches} prepared bulk emails, {r.cancelled.imports} imports. Skills
          switched off: {r.skillsDisabled}. Assistant conversations deleted: {r.conversationsDeleted}.
        </li>
        <li>
          Their connected accounts deleted: {r.tokens.deleted}
          {r.tokens.revokeUnconfirmed.length
            ? ` — ${r.tokens.revokeUnconfirmed.join(', ')} did not confirm the revoke; ${name} can remove the app from their Google/Zoom account settings`
            : ''}
          .
        </li>
        {r.agencyAccountsFlagged ? <li>{r.agencyAccountsFlagged} agency account(s) they connected keep working — reconnect them with an account the agency controls (Settings → Connectors).</li> : null}
      </ul>
      <p>
        <Link href="/team">Back to the team</Link>
        {r.choice === 'review' ? <> · <Link href="/overview">Open “Needs an owner”</Link></> : null}
      </p>
    </div>
  );
}
