import { sql, type SQL } from 'drizzle-orm';
import { contact, lead, mailMessage } from '@repo/db';

/**
 * Whose conversation, and whose email, it is (ADR 0034 §3, made the one
 * definition by ADR 0036 P3). The schema has no recipient-agent column, so
 * every figure that puts mail on a person uses these — two tiles can never
 * put the same email on different people again.
 *
 * Both name the tables `mail_message`, `lead` and `contact` as they are: the
 * query joins `mail_thread` → left `lead` (on lead_id) → left `contact` (on
 * contact_id) without aliases (an alias is a Postgres error, not a wrong figure).
 */

/** A conversation's agent: the lead's assignee, else the contact's (mail to the agency address). Null: nobody's. */
export const conversationOwnerSql: SQL = sql`coalesce(${lead.assignedTo}, ${contact.assignedTo})`;

/** An email's person: one we SENT is its sender's (`sent_by`); one we RECEIVED is the conversation's agent. */
export const emailOwnerSql: SQL = sql`case when ${mailMessage.direction} = 'out' then ${mailMessage.sentBy} else ${conversationOwnerSql} end`;
