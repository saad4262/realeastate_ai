import { sql, type SQL } from 'drizzle-orm';

/**
 * Marketing consent (ADR 0043, amending ADR 0022 and ADR 0018): the ONE definition, used when a
 * batch is prepared and again at the moment of sending. Consent is any of:
 *   - recorded — `marketing_consent_at` is set;
 *   - inferred from an enquiry — a lead from them at this agency in the last 24 months;
 *   - inferred as a client — a seller, landlord or tenant of the agency.
 * Whoever unsubscribed is never sent to, whatever this says: the opt-out is tested FIRST
 * (`classify` in batches.ts), and this expression never looks at it.
 *
 * Columns are named as `"contact"."…"` by hand: the query's FROM must have `contact` under that
 * name, and a bare `id` inside the sub-selects would bind to the lead's or the role's own.
 */
export const INFERRED_CONSENT_MONTHS = 24;
export const CLIENT_ROLES = ['seller', 'landlord', 'tenant'] as const;

export function hasMarketingConsentSql(): SQL<boolean> {
  return sql<boolean>`(
    "contact"."marketing_consent_at" is not null
    or exists (
      select 1 from lead consent_lead
      where consent_lead.contact_id = "contact"."id" and consent_lead.agency_id = "contact"."agency_id"
        and consent_lead.created_at > now() - make_interval(months => ${INFERRED_CONSENT_MONTHS})
    )
    or exists (
      select 1 from contact_role consent_role
      where consent_role.contact_id = "contact"."id" and consent_role.role::text in (${sql.join(CLIENT_ROLES.map((r) => sql`${r}`), sql`, `)})
    )
  )`;
}
