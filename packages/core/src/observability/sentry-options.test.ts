import { describe, expect, it } from 'vitest';
import { browserMonitoring } from './browser-monitoring';
import { scrubSentryEvent, scrubText, sentryOptions } from './sentry-options';

describe('what leaves the platform in an error', () => {
  it('removes an email, a mobile, a landline, a connection string, a bearer token and a key', () => {
    const out = scrubText('jane.citizen@example.com on 0412 345 678 or +61 3 9123 4567 via postgresql://u:p@host:6543/db Bearer abc.def-123 sk-ant-abcdefghijklmnop');
    expect(out).toBe('[email removed] on [phone removed] or [phone removed] via postgresql://[removed] Bearer [removed] [key removed]');
  });
  it('leaves ordinary text and ids alone', () => {
    const text = 'Listing 33333333-3333-3333-3333-333333333333 failed after 1500 ms, price 680000';
    expect(scrubText(text)).toBe(text);
  });
  it('drops the person, cookies, the body, the query string and all but two headers', () => {
    const event = scrubSentryEvent({
      user: { email: 'a@b.com', ip_address: '1.2.3.4' },
      message: 'failed for a@b.com',
      request: {
        url: 'https://findoraaus.com.au/unsubscribe?token=secret&email=a@b.com',
        query_string: 'token=secret',
        cookies: { sb: 'session' },
        data: { password: 'x' },
        headers: { 'User-Agent': 'x', host: 'findoraaus.com.au', authorization: 'Bearer t', 'x-revalidate-secret': 's', cookie: 'c' },
      },
      exception: { values: [{ value: 'duplicate key for buyer@example.com' }] },
      breadcrumbs: [{ message: 'sending to b@c.com', data: { url: 'https://api.example.com/x?key=secret', arguments: ['b@c.com'] } }],
    });
    expect(event.user).toBeUndefined();
    expect(event.message).toBe('failed for [email removed]');
    expect(event.request).toEqual({ url: 'https://findoraaus.com.au/unsubscribe', headers: { 'User-Agent': 'x', host: 'findoraaus.com.au' } });
    expect(event.exception!.values![0]!.value).toBe('duplicate key for [email removed]');
    expect(event.breadcrumbs![0]).toEqual({ message: 'sending to [email removed]', data: { url: 'https://api.example.com/x' } });
  });
});

describe('the settings', () => {
  it('no DSN is switched off, and a blank one is no DSN', () => {
    for (const dsn of [undefined, '', '  ']) expect(sentryOptions({ dsn, environment: 'production', app: 'web' })).toMatchObject({ dsn: undefined, enabled: false });
  });
  it('a DSN is on: errors only, nothing about the person, tagged by app', () => {
    expect(sentryOptions({ dsn: 'https://k@o1.ingest.sentry.io/1', environment: 'production', app: 'console' })).toMatchObject({
      enabled: true,
      environment: 'production',
      sendDefaultPii: false,
      tracesSampleRate: 0,
      initialScope: { tags: { app: 'console' } },
    });
  });
});

describe('the browser loads the SDK late', () => {
  const fake = () => {
    const calls = { load: 0, init: 0, captured: [] as unknown[] };
    const load = async () => {
      calls.load += 1;
      return { init: () => { calls.init += 1; }, captureException: (e: unknown) => { calls.captured.push(e); } };
    };
    return { calls, load };
  };
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it('no DSN never loads it, even for an error', async () => {
    const { calls, load } = fake();
    const m = browserMonitoring(load, { enabled: false });
    m.start(new EventTarget(), (run) => run());
    m.report(new Error('x'));
    await settled();
    expect(calls.load).toBe(0);
  });
  it('nothing loads until the page is idle; then once, and started', async () => {
    const { calls, load } = fake();
    let idle: () => void = () => undefined;
    browserMonitoring(load, { enabled: true }).start(new EventTarget(), (run) => { idle = run; });
    await settled();
    expect(calls.load).toBe(0);
    idle();
    await settled();
    expect(calls).toMatchObject({ load: 1, init: 1, captured: [] });
  });
  it('an error before idle loads it at once and is not lost; later errors are the SDK’s own', async () => {
    const { calls, load } = fake();
    const target = new EventTarget();
    browserMonitoring(load, { enabled: true }).start(target, () => undefined);
    const boom = new Error('boom');
    target.dispatchEvent(Object.assign(new Event('error'), { error: boom }));
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('second') }));
    await settled();
    expect(calls).toMatchObject({ load: 1, init: 1, captured: [boom] });
  });
  it('a boundary’s report starts it, and it starts once', async () => {
    const { calls, load } = fake();
    const m = browserMonitoring(load, { enabled: true });
    m.report(new Error('a'));
    m.report(new Error('b'));
    await settled();
    expect(calls.load).toBe(1);
    expect(calls.init).toBe(1);
    expect(calls.captured).toHaveLength(2);
  });
});
