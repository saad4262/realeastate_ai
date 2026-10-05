import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { buildContactAssignedEmail } from '../email';
import { notifyContactAssigned } from './contact-notices';

const from = { email: 'alerts@example.test', name: 'Example Realty' };

describe('the contact-assigned notice', () => {
  it('sends nothing when somebody assigns a contact to themselves — before touching the database', async () => {
    let touched = false;
    const db = new Proxy({}, { get: () => { touched = true; throw new Error('no'); } }) as unknown as Db;
    const sent: unknown[] = [];
    const deps = {
      mailer: {
        sender: { from, postalAddress: '1 Test St, Testville VIC 3000' },
        transport: { send: async (m: unknown) => { sent.push(m); return { ok: true as const, id: 'x' }; } },
      },
      urls: { agentUrl: 'http://agents.test', agencyUrl: 'http://agency.test' },
    } as unknown as Parameters<typeof notifyContactAssigned>[1];
    const outcome = await notifyContactAssigned(db, deps, 'c-1', 'admin-1', 'admin-1');
    expect(outcome).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
    expect(touched).toBe(false);
  });

  it('carries who they are and how to reach them, escaped, and nothing about their leads', () => {
    const msg = buildContactAssignedEmail({
      to: { email: 'agent@example.test' },
      from,
      postalAddress: '1 Test St, Testville VIC 3000',
      contact: { name: 'Tom <b>', email: 'tom@example.test', phone: '0412 345 678', roles: ['Buyer'], nextAction: null },
      assignedByName: 'Sarah',
      profileUrl: 'http://agents.test/my-contacts/c-1',
    });
    expect(msg.kind).toBe('transactional');
    expect(msg.subject).toBe('Tom <b> is now your contact');
    expect(msg.html).toContain('Tom &lt;b&gt;');
    expect(msg.html).not.toContain('Tom <b>');
    expect(msg.text).toContain('Sarah assigned them to you.');
    expect(msg.text).toContain('http://agents.test/my-contacts/c-1');
    expect(msg.text).not.toMatch(/offer|enquir/i);
  });
});
