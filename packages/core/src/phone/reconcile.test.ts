import { describe, expect, it } from 'vitest';
import { twilioClient } from './twilio';

/** PLATFORM-PLAN 3.9: asking Twilio which messages went from a number to a number since a day. */
describe('twilioClient.findMessages', () => {
  it('asks Messages.json by From, To and DateSent (a day earlier), and reads sid, body, status, time', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ messages: [{ sid: 'SM1', body: 'Hello', status: 'delivered', date_created: 'Wed, 18 Nov 2026 22:00:00 +0000' }, { body: 'no sid' }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = twilioClient({ accountSid: 'AC123', apiKeySid: 'SK1', apiKeySecret: 's' }, fetchImpl);
    const out = await client.findMessages({ from: '+61400000001', to: '+61400000002', since: new Date('2026-11-18T22:00:00Z') });
    const q = new URL(urls[0]!).searchParams;
    expect(urls[0]).toMatch(/\/Accounts\/AC123\/Messages\.json\?/);
    expect([q.get('From'), q.get('To'), q.get('DateSent>'), q.get('PageSize')]).toEqual(['+61400000001', '+61400000002', '2026-11-17', '50']);
    expect(out).toEqual([{ sid: 'SM1', body: 'Hello', status: 'delivered', createdAt: new Date('2026-11-18T22:00:00Z') }]);
  });
});
