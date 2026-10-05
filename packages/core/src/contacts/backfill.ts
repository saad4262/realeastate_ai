import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';

/**
 * Give every existing lead and conversation its contact (ADR 0018).
 *
 * New rows get one from the insert triggers in migration 0020; this is for
 * the rows written before it. Every person goes through `public.contact_upsert`
 * — the one matching rule — oldest lead first, so the name a contact keeps is
 * the first one they gave.
 *
 * The dry run is the SAME writes inside a transaction that is then rolled
 * back, so what it reports is exactly what `apply` would do, not an estimate.
 * Safe to repeat: only rows with no contact are touched.
 */

export type BackfillReport = {
  applied: boolean;
  agencies: {
    agencyId: string;
    agencyName: string;
    contactsBefore: number;
    contactsAfter: number;
    leadsLinked: number;
    threadsLinked: number;
    rolesAdded: number;
  }[];
  /** Same phone key, different contacts — never merged automatically. */
  possibleDuplicates: { agencyName: string; phoneKey: string; names: string[] }[];
};

class Rollback extends Error {
  constructor(readonly report: BackfillReport) {
    super('dry run');
  }
}

export async function backfillContacts(db: Db, opts: { apply: boolean }): Promise<BackfillReport> {
  try {
    return await db.transaction(async (tx) => {
      const before = await tx.execute<{ agency_id: string; name: string; n: number }>(sql`
        select a.id as agency_id, a.name, (select count(*)::int from contact c where c.agency_id = a.id) as n
        from agency a order by a.name
      `);

      // Leads, one at a time and oldest first: the order decides whose name
      // a shared address keeps, and one UPDATE has no order.
      const leads = await tx.execute<{ id: string; agency_id: string }>(sql`
        select id, agency_id from lead where contact_id is null order by created_at, id
      `);
      for (const l of leads) {
        await tx.execute(sql`
          update lead set contact_id = public.contact_upsert(
            agency_id, email, name, phone,
            (case when kind = 'offer' then 'offer' else 'enquiry' end)::contact_source)
          where id = ${l.id} and contact_id is null
        `);
      }

      // The roles the insert trigger would have tagged.
      const roles = await tx.execute<{ agency_id: string }>(sql`
        insert into contact_role (contact_id, role, source)
        select distinct l.contact_id,
          (case
            when l.kind = 'appraisal' then 'seller'
            when li.channel in ('rent', 'leased') then 'tenant'
            else 'buyer'
          end)::contact_role_kind,
          'inferred'::contact_tag_source
        from lead l left join listing li on li.id = l.listing_id
        where l.contact_id is not null
        on conflict do nothing
        returning (select agency_id from contact where id = contact_role.contact_id) as agency_id
      `);

      // A lead's conversation is with the lead's person.
      const leadThreads = await tx.execute<{ agency_id: string }>(sql`
        update mail_thread t set contact_id = l.contact_id
        from lead l
        where t.lead_id = l.id and t.contact_id is null and l.contact_id is not null
        returning t.agency_id
      `);

      // Mail to the agency's own address: its sender, unless a colleague.
      const general = await tx.execute<{ id: string; agency_id: string }>(sql`
        select t.id, t.agency_id from mail_thread t
        where t.lead_id is null and t.contact_id is null
          and not exists (
            select 1 from membership m join "user" u on u.id = m.user_id
            where m.agency_id = t.agency_id and m.status = 'active'
              and lower(u.email) = lower(t.contact_email)
          )
        order by t.created_at, t.id
      `);
      for (const t of general) {
        await tx.execute(sql`
          update mail_thread set contact_id = public.contact_upsert(
            agency_id, contact_email, contact_name, null, 'email')
          where id = ${t.id} and contact_id is null
        `);
      }

      const after = await tx.execute<{ agency_id: string; n: number }>(sql`
        select agency_id, count(*)::int as n from contact group by agency_id
      `);
      const dupes = await tx.execute<{ agency_name: string; phone_key: string; names: string[] | string }>(sql`
        select a.name as agency_name, c.phone_key, array_agg(c.name order by c.created_at) as names
        from contact c join agency a on a.id = c.agency_id
        where c.phone_key is not null and c.merged_into_id is null
        group by a.name, c.agency_id, c.phone_key
        having count(*) > 1
        order by a.name, c.phone_key
      `);

      const leadsByAgency = new Map<string, number>();
      for (const l of leads) leadsByAgency.set(l.agency_id, (leadsByAgency.get(l.agency_id) ?? 0) + 1);
      const tally = (rows: { agency_id: string }[]) => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(r.agency_id, (m.get(r.agency_id) ?? 0) + 1);
        return m;
      };
      const threadsByAgency = tally([...leadThreads, ...general]);
      const rolesByAgency = tally(roles);
      const afterByAgency = new Map(after.map((r) => [r.agency_id, Number(r.n)]));

      const report: BackfillReport = {
        applied: opts.apply,
        agencies: before.map((b) => ({
          agencyId: b.agency_id,
          agencyName: b.name,
          contactsBefore: Number(b.n),
          contactsAfter: afterByAgency.get(b.agency_id) ?? 0,
          leadsLinked: leadsByAgency.get(b.agency_id) ?? 0,
          threadsLinked: threadsByAgency.get(b.agency_id) ?? 0,
          rolesAdded: rolesByAgency.get(b.agency_id) ?? 0,
        })),
        possibleDuplicates: dupes.map((d) => ({
          agencyName: d.agency_name,
          phoneKey: d.phone_key,
          names: Array.isArray(d.names) ? d.names : String(d.names).replace(/^\{|\}$/g, '').split(','),
        })),
      };
      if (!opts.apply) throw new Rollback(report);
      return report;
    });
  } catch (err) {
    if (err instanceof Rollback) return err.report;
    throw err;
  }
}
