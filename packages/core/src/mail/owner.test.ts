import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { conversationOwnerSql, emailOwnerSql } from './owner';

/** One definition of whose email it is (ADR 0036 P3) — the Agents widget and Email replies both read it. */
describe('the email owner', () => {
  const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q).sql;

  it('a conversation is the lead’s assignee’s, else the contact’s (mail to the agency address)', () => {
    expect(render(conversationOwnerSql)).toBe('coalesce("lead"."assigned_to", "contact"."assigned_to")');
  });

  it('an email we sent is its sender’s; one we received is the conversation’s', () => {
    expect(render(emailOwnerSql)).toBe(
      `case when "mail_message"."direction" = 'out' then "mail_message"."sent_by" else coalesce("lead"."assigned_to", "contact"."assigned_to") end`,
    );
  });
});
