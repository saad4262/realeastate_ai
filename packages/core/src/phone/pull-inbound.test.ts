import { describe, expect, it } from 'vitest';
import { twilioClient } from './twilio';

/** PLATFORM-PLAN 3.8: asking Twilio what came in to a number since a moment. */
describe('twilioClient.inboundSince', () => {
  it('lists inbound texts and calls To the number from the day before, and keeps only inbound ones at or after `since`', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const body = url.includes('/Messages.json')
        ? {
            messages: [
              { sid: 'SMin', from: '+61400000009', body: 'Still available?', direction: 'inbound', date_created: 'Fri, 20 Nov 2026 03:10:00 +0000' },
              { sid: 'SMout', from: '+61480000001', body: 'Our reply', direction: 'outbound-api', date_created: 'Fri, 20 Nov 2026 03:11:00 +0000' },
              { sid: 'SMold', from: '+61400000009', body: 'Yesterday', direction: 'inbound', date_created: 'Thu, 19 Nov 2026 03:10:00 +0000' },
              { from: '+61400000009', direction: 'inbound', date_created: 'Fri, 20 Nov 2026 03:12:00 +0000' },
            ],
          }
        : {
            calls: [
              { sid: 'CAin', from: '+61400000009', direction: 'inbound', start_time: 'Fri, 20 Nov 2026 03:20:00 +0000' },
              { sid: 'CAout', from: '+61480000001', direction: 'outbound-api', start_time: 'Fri, 20 Nov 2026 03:21:00 +0000' },
              { sid: 'CAold', from: '+61400000009', direction: 'inbound', start_time: 'Fri, 20 Nov 2026 01:00:00 +0000' },
            ],
          };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = twilioClient({ accountSid: 'AC123', apiKeySid: 'SK1', apiKeySecret: 's' }, fetchImpl);
    const out = await client.inboundSince({ to: '+61480000001', since: new Date('2026-11-20T02:00:00Z') });
    const msgs = new URL(urls.find((u) => u.includes('/Messages.json'))!).searchParams;
    const calls = new URL(urls.find((u) => u.includes('/Calls.json'))!).searchParams;
    expect([msgs.get('To'), msgs.get('DateSent>'), msgs.get('From')]).toEqual(['+61480000001', '2026-11-19', null]);
    expect([calls.get('To'), calls.get('StartTime>')]).toEqual(['+61480000001', '2026-11-19']);
    expect(out).toEqual({ messages: [{ sid: 'SMin', from: '+61400000009', body: 'Still available?' }], calls: [{ sid: 'CAin', from: '+61400000009' }] });
  });
});
