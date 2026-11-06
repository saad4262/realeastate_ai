import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { formatContactAddress } from '../contacts/contact-schema';
import { contactAccountIdsSql } from '../contacts/site-history';
import { PlatformError } from './admin';

/**
 * Everyone on the platform in one list (ADR 0083 §9): the agencies' customers, their members, and website accounts.
 * One statement: the page is cut first, then each of its rows counts its leads, so the count never runs on the whole table.
 */

export const PEOPLE_TYPES = ['customer', 'member', 'account'] as const;
export type PersonType = (typeof PEOPLE_TYPES)[number];
export const PERSON_TYPE_LABELS: Record<PersonType, string> = { customer: 'Customer', member: 'Agency staff', account: 'Website account' };

export function parsePersonType(raw: unknown): PersonType | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (PEOPLE_TYPES as readonly unknown[]).includes(v) ? (v as PersonType) : null;
}

export type EveryoneRow = {
  type: PersonType;
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  agencyId: string | null;
  agencyName: string | null;
  address: string | null;
  leads: number;
};
export type EveryonePage = { rows: EveryoneRow[]; total: number; byType: Record<PersonType, number> };

export async function listEveryone(
  db: Db,
  admin: Actor,
  opts: { q?: string; type?: PersonType | null; limit?: number; offset?: number } = {},
): Promise<EveryonePage> {
  if (!can(admin, 'platform:read', { type: 'platform' })) throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  const q = opts.q?.trim();
  const like = q ? `%${q}%` : null;
  const search = (name: string, email: string, phone: string, agencyName: string) =>
    like ? sql`and (${sql.raw(name)} ilike ${like} or ${sql.raw(email)} ilike ${like} or ${sql.raw(phone)} ilike ${like} or ${sql.raw(agencyName)} ilike ${like})` : sql``;
  const rows = await db.execute<{
    type: PersonType; id: string; name: string | null; email: string | null; phone: string | null; agency_id: string | null; agency_name: string | null;
    address_line: string | null; address_suburb: string | null; address_state: string | null; address_postcode: string | null; leads: string; total: string; customers: string; members: string; accounts: string;
  }>(sql`
    with everyone as (
      select 'customer' as type, c.id, c.name, c.email, c.phone, c.agency_id, ag.name as agency_name, c.address_line, c.address_suburb, c.address_state, c.address_postcode
      from contact c join agency ag on ag.id = c.agency_id
      where c.merged_into_id is null ${search('c.name', 'c.email', 'c.phone', 'ag.name')}
      union all
      select 'member', u.id, coalesce(nullif(u.name, ''), u.email), u.email, u.phone, m.agency_id, ag.name, null, null, null, null
      from membership m join "user" u on u.id = m.user_id join agency ag on ag.id = m.agency_id
      where true ${search('u.name', 'u.email', 'u.phone', 'ag.name')}
      union all
      select 'account', u.id, coalesce(nullif(u.name, ''), u.email), u.email, u.phone, null, null, null, null, null, null
      from "user" u
      where not exists (select 1 from membership m where m.user_id = u.id) and not exists (select 1 from platform_admin pa where pa.user_id = u.id)
        ${like ? sql`and (u.name ilike ${like} or u.email ilike ${like} or u.phone ilike ${like})` : sql``}
    ), totals as (
      select count(*) as total,
        count(*) filter (where type = 'customer') as customers,
        count(*) filter (where type = 'member') as members,
        count(*) filter (where type = 'account') as accounts
      from everyone
    ), page as (
      select * from everyone
      ${opts.type ? sql`where type = ${opts.type}` : sql``}
      order by lower(name), id
      limit ${Math.min(opts.limit ?? 50, 200)} offset ${Math.max(opts.offset ?? 0, 0)}
    )
    select page.*, totals.*,
      case page.type
        when 'customer' then (select count(*) from lead l where l.contact_id = page.id)
        when 'member' then (select count(*) from lead l where l.assigned_to = page.id and l.agency_id = page.agency_id)
        else (select count(*) from lead l where l.user_id = page.id)
      end as leads
    from page cross join totals
    order by lower(page.name), page.id`);
  const first = rows[0];
  return {
    rows: rows.map((r) => ({
      type: r.type,
      id: r.id,
      name: r.name ?? r.email ?? 'Unknown',
      email: r.email,
      phone: r.phone,
      agencyId: r.agency_id,
      agencyName: r.agency_name,
      address: formatContactAddress({ addressLine: r.address_line, addressSuburb: r.address_suburb, addressState: r.address_state, addressPostcode: r.address_postcode }),
      leads: Number(r.leads),
    })),
    total: Number(opts.type ? (opts.type === 'customer' ? first?.customers : opts.type === 'member' ? first?.members : first?.accounts) ?? 0 : first?.total ?? 0),
    byType: { customer: Number(first?.customers ?? 0), member: Number(first?.members ?? 0), account: Number(first?.accounts ?? 0) },
  };
}

export type AccountCustomerRecord = {
  contactId: string;
  agencyId: string;
  agencyName: string;
  name: string;
  phone: string | null;
  address: string | null;
  leads: number;
};

/** The agencies that hold a website account as a customer, for `/users/[id]`. One statement. */
export async function listAccountCustomerRecords(db: Db, admin: Actor, userId: string): Promise<AccountCustomerRecord[]> {
  if (!can(admin, 'platform:read', { type: 'platform' })) throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  const rows = await db.execute<{ id: string; agency_id: string; agency_name: string; name: string; phone: string | null; address_line: string | null; address_suburb: string | null; address_state: string | null; address_postcode: string | null; leads: string }>(sql`
    select c.id, c.agency_id, ag.name as agency_name, c.name, c.phone, c.address_line, c.address_suburb, c.address_state, c.address_postcode,
      (select count(*) from lead l where l.contact_id = c.id) as leads
    from contact c
    join agency ag on ag.id = c.agency_id
    join "user" u on u.id = ${userId}
    where c.merged_into_id is null
      and (c.user_id = u.id or lower(c.email) = lower(u.email) or exists (select 1 from lead l where l.contact_id = c.id and l.user_id = u.id))
    order by ag.name
    limit 50`);
  return rows.map((r) => ({
    contactId: r.id,
    agencyId: r.agency_id,
    agencyName: r.agency_name,
    name: r.name,
    phone: r.phone,
    address: formatContactAddress({ addressLine: r.address_line, addressSuburb: r.address_suburb, addressState: r.address_state, addressPostcode: r.address_postcode }),
    leads: Number(r.leads),
  }));
}

export type ContactAccount = { userId: string; name: string; email: string };

/** The website accounts tied to a customer (ADR 0083 §7), for the admin's link to their whole history. One statement. */
export async function listContactAccounts(db: Db, admin: Actor, contactId: string): Promise<ContactAccount[]> {
  if (!can(admin, 'platform:read', { type: 'platform' })) throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  const rows = await db.execute<{ id: string; name: string | null; email: string }>(sql`
    select u.id, u.name, u.email from "user" u
    where u.id in (${contactAccountIdsSql(contactId)}) and not exists (select 1 from membership m where m.user_id = u.id)
    limit 5`);
  return rows.map((r) => ({ userId: r.id, name: r.name?.trim() || r.email, email: r.email }));
}
