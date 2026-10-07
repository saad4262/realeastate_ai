import Link from 'next/link';
import { listNeedsOwner } from '@repo/core/team';
import { listAgencyAgents } from '@repo/core/team';
import { getConsoleDb } from '../../lib/db';
import type { Actor } from '@repo/core/permissions';
import { AssignOwner } from './assign-owner';

const HREF: Record<string, (id: string) => string> = {
  contact: (id) => `/customers/${id}`,
  lead: () => '/leads',
  appointment: () => '/calendar',
  listing: (id) => `/live-listings/${id}/edit`,
};
const KIND: Record<string, string> = { contact: 'Contact', lead: 'Lead', appointment: 'Appointment', listing: 'Listing' };

/**
 * "Needs an owner" (ADR 0030 §7): work left by a removed member that nobody
 * has taken. Owners and admins only; empty → not drawn at all.
 */
export async function NeedsOwner({ actor }: { actor: Actor }) {
  const db = getConsoleDb();
  const items = await listNeedsOwner(db, actor);
  if (!items.length) return null;
  const members = (await listAgencyAgents(db, actor)).filter((a) => a.status === 'active' && a.role !== 'read_only');
  return (
    <section style={{ border: '1px solid var(--amber, #d4a017)', borderRadius: '0.75rem', padding: '1rem', margin: '0 0 1rem', background: 'var(--surface-card)' }}>
      <h2 style={{ margin: '0 0 0.25rem', fontSize: '1rem' }}>Needs an owner ({items.length})</h2>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        Left unassigned when someone was removed from the agency. Give each one to a member.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.375rem' }}>
        {items.map((i) => (
          <li key={`${i.kind}-${i.id}`} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ minWidth: '6rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{KIND[i.kind]}</span>
            <Link href={HREF[i.kind]!(i.id)} style={{ flex: '1 1 12rem' }}>
              {i.label}
            </Link>
            <AssignOwner kind={i.kind} id={i.id} members={members.map((m) => ({ userId: m.userId!, name: m.name }))} />
          </li>
        ))}
      </ul>
    </section>
  );
}
