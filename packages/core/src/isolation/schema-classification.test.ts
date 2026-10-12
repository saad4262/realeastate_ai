import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@repo/db/schema';

/**
 * Tenant isolation, layer 0 (ADR 0030 §1): every table in the schema is in
 * exactly one of four groups, and the group is checked against the table.
 *
 * A new table fails this test until someone puts it in a group — and putting
 * it there is the review: "whose is this row, and how does a query keep it in
 * its agency?" must have an answer before the table ships.
 */

/** Carries `agency_id` itself. Every read of it filters by agency. */
const OWN_AGENCY = [
  'office',
  'team',
  'membership',
  'agent_invite',
  'listing',
  'lead',
  'mail_thread',
  'mail_message',
  'contact',
  'note',
  'activity',
  'appointment',
  'integration_account',
  'ai_run',
  'skill',
  'agent_skill',
  'skill_run',
  'contact_filter',
  'email_template',
  'email_batch',
  'assistant_conversation',
  'proposed_action',
  'dashboard',
  'listing_import',
  'agency_google_place',
  'search_embedding',
  'notification',
  // ADR 0035: members' conversations with each other; read only by the people on them.
  'team_thread',
  'team_message',
  // ADR 0038: the colleagues on a team meeting; carries its own agency_id like notification.
  'appointment_participant',
] as const;

/** Reaches an agency through a parent row: table → [foreign-key column, parent table]. */
const THROUGH_PARENT: Record<string, [string, string]> = {
  team_member: ['team_id', 'team'],
  listing_agent: ['listing_id', 'listing'],
  media: ['listing_id', 'listing'],
  inspection: ['listing_id', 'listing'],
  mail_read: ['thread_id', 'mail_thread'],
  // A buyer's read mark on a conversation of theirs (ADR 0035 §2).
  mail_customer_read: ['thread_id', 'mail_thread'],
  team_thread_member: ['thread_id', 'team_thread'],
  contact_role: ['contact_id', 'contact'],
  contact_property: ['contact_id', 'contact'],
  email_batch_recipient: ['batch_id', 'email_batch'],
  assistant_turn: ['conversation_id', 'assistant_conversation'],
  agent_profile: ['user_id', 'user'],
  listing_import_row: ['import_id', 'listing_import'],
};

/**
 * Shared on purpose, with the reason. These hold no agency's private data.
 * - property / place_cache: one address is one property across agencies
 *   (ADR 0013); agency data lives on the listing, never here.
 * - user: a person; which agency they act for is `membership`.
 * - agency: the tenant itself.
 */
const SHARED = ['property', 'place_cache', 'user', 'agency'] as const;

/** A public-site visitor's own data (ADR 0011): owned by a person, never an agency. */
const PUBLIC_SITE_USER = ['search_schedule', 'schedule_run', 'chat_thread', 'chat_message', 'shortlist', 'event'] as const;

function tables() {
  return (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => {
      const cfg = getTableConfig(t);
      return {
        name: cfg.name,
        columns: cfg.columns.map((c) => c.name),
        fks: cfg.foreignKeys.map((fk) => {
          const ref = fk.reference();
          return { columns: ref.columns.map((c) => c.name), to: getTableConfig(ref.foreignTable).name };
        }),
      };
    });
}

describe('tenant isolation — every table is classified', () => {
  const all = tables();
  const names = all.map((t) => t.name);

  it('every table is in exactly one group', () => {
    const groups = [...OWN_AGENCY, ...Object.keys(THROUGH_PARENT), ...SHARED, ...PUBLIC_SITE_USER];
    const unclassified = names.filter((n) => !groups.includes(n as never));
    expect(unclassified, 'add the new table to a group in this file, with its reason').toEqual([]);
    const twice = groups.filter((g, i) => groups.indexOf(g) !== i);
    expect(twice).toEqual([]);
    const gone = groups.filter((g) => !names.includes(g));
    expect(gone, 'a group names a table that no longer exists').toEqual([]);
  });

  it('every "own agency" table really has a non-null agency_id referencing agency', () => {
    for (const name of OWN_AGENCY) {
      const t = all.find((x) => x.name === name)!;
      expect(t.columns, name).toContain('agency_id');
      // skill's agency_id is nullable on purpose: null = the platform's own library (ADR 0021).
      const fk = t.fks.find((f) => f.columns.includes('agency_id'));
      expect(fk?.to, `${name}.agency_id must reference agency`).toBe('agency');
    }
  });

  it('every "through a parent" table has that foreign key to that parent', () => {
    for (const [name, [column, parent]] of Object.entries(THROUGH_PARENT)) {
      const t = all.find((x) => x.name === name)!;
      const fk = t.fks.find((f) => f.columns.includes(column));
      expect(fk?.to, `${name}.${column} → ${parent}`).toBe(parent);
      expect(t.columns, `${name} would be simpler with its own agency_id — move it`).not.toContain('agency_id');
    }
  });

  it('shared and public-site tables carry no agency_id (if they gain one, they changed group)', () => {
    for (const name of [...SHARED.filter((n) => n !== 'agency'), ...PUBLIC_SITE_USER]) {
      const t = all.find((x) => x.name === name)!;
      expect(t.columns, name).not.toContain('agency_id');
    }
  });
});
