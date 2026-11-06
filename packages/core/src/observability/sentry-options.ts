/**
 * Error monitoring's shared settings (ADR 0082). Pure, so the browser, the server and the edge all use the same rules, and a test
 * can hold them. Errors only: no tracing, no session replay, nothing about the person. A buyer's email, a phone number, a query
 * string or a secret in an error's text is removed before it leaves the platform. No DSN means switched off.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const AU_PHONE = /(?<![\d.])(?:\+?61|0)[\s-]?4(?:[\s-]?\d){8}(?!\d)/g;
const LANDLINE = /(?<![\d.])(?:\+?61|0)[\s-]?[2378](?:[\s-]?\d){8}(?!\d)/g;
const CONNECTION = /\b(postgres(?:ql)?|mysql|redis):\/\/[^\s'"]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY = /\b(?:sk|re|whsec|sb_secret|AC|SK|xoxb)[-_][A-Za-z0-9_-]{12,}/g;

export function scrubText(text: string): string {
  return text
    .replace(CONNECTION, '$1://[removed]')
    .replace(BEARER, 'Bearer [removed]')
    .replace(KEY, '[key removed]')
    .replace(EMAIL, '[email removed]')
    .replace(AU_PHONE, '[phone removed]')
    .replace(LANDLINE, '[phone removed]');
}

const withoutQuery = (url: string) => scrubText(url.split(/[?#]/)[0] ?? '');

type Crumb = { message?: string; data?: Record<string, unknown> };

type EventLike = {
  message?: string;
  user?: unknown;
  request?: { url?: string; query_string?: unknown; cookies?: unknown; data?: unknown; headers?: Record<string, string> };
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: Crumb[];
};

const KEPT_HEADERS = new Set(['user-agent', 'host']);

function scrubCrumb<C extends Crumb>(crumb: C): C {
  if (crumb.message) crumb.message = scrubText(crumb.message);
  if (crumb.data) {
    if (typeof crumb.data.url === 'string') crumb.data.url = withoutQuery(crumb.data.url);
    for (const key of ['to', 'from']) if (typeof crumb.data[key] === 'string') crumb.data[key] = withoutQuery(crumb.data[key] as string);
    delete crumb.data.arguments;
  }
  return crumb;
}

/** Sentry's `beforeSend`: the last thing an error passes through on its way out. */
export function scrubSentryEvent<E extends EventLike>(event: E): E {
  delete event.user;
  if (event.message) event.message = scrubText(event.message);
  if (event.request) {
    if (event.request.url) event.request.url = withoutQuery(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(Object.entries(event.request.headers).filter(([k]) => KEPT_HEADERS.has(k.toLowerCase())));
    }
  }
  for (const value of event.exception?.values ?? []) if (value.value) value.value = scrubText(value.value);
  event.breadcrumbs?.forEach(scrubCrumb);
  return event;
}

/** What every `Sentry.init` starts from. `app` separates the public site from the consoles inside one Sentry project. */
export function sentryOptions(input: { dsn: string | undefined; environment: string | undefined; app: 'web' | 'console' }) {
  const dsn = input.dsn?.trim() || undefined;
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: input.environment || 'development',
    initialScope: { tags: { app: input.app } },
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubCrumb,
  };
}
