/**
 * The security headers both apps send on every response (next.config.ts `headers()`).
 *
 * Two layers, on purpose:
 *
 *  - ENFORCED: the directives that stop an attack and cannot stop a page loading anything —
 *    `frame-ancestors 'self'` (another site may not frame the console and click its Approve and Send
 *    buttons through a decoy), `object-src 'none'`, `base-uri 'self'`, plus nosniff, a referrer
 *    policy, HSTS and a permissions policy.
 *
 *  - REPORT-ONLY: the full resource policy (scripts, styles, images, connections, frames). The
 *    browser reports what it would block in its console and blocks nothing. A resource policy that is
 *    wrong breaks a page silently: the map, the Supabase sign-in, Sentry, a YouTube tour, Google's
 *    Sheets picker. So it is enforced only after a browser pass over both apps reads no violations;
 *    then move these directives into the enforced header.
 *
 * Scripts keep 'unsafe-inline' even then: Next's inline bootstrap needs it unless every page takes a
 * per-request nonce, which makes every page dynamic, and the public site's cached pages are worth
 * more than that. The policy still allow-lists where a script may come FROM.
 *
 * The email reader's <iframe srcdoc> inherits these and adds its own stricter policy
 * (mail/sandbox.ts), so nothing here loosens it.
 */
export type SecurityApp = 'web' | 'console';
export type SecurityHeader = { key: string; value: string };

/** https://x.supabase.co from NEXT_PUBLIC_SUPABASE_URL, or null. Media and auth both live there. */
function supabaseOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

function policy(directives: Record<string, (string | null | false)[]>): string {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources.filter((s): s is string => Boolean(s))].join(' '))
    .join('; ');
}

const GOOGLE_MAPS = ['https://maps.googleapis.com', 'https://maps.gstatic.com'];
const SENTRY = ['https://*.ingest.sentry.io', 'https://*.ingest.us.sentry.io', 'https://*.ingest.de.sentry.io'];

const ENFORCED = policy({
  'frame-ancestors': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
});

export function securityHeaders(app: SecurityApp, env: NodeJS.ProcessEnv = process.env): SecurityHeader[] {
  const supabase = supabaseOrigin(env);
  const supabaseWs = supabase ? supabase.replace(/^http/, 'ws') : null;
  const dev = env.NODE_ENV !== 'production';

  const reportOnly = policy({
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      dev && "'unsafe-eval'",
      ...GOOGLE_MAPS,
      // The console's Google Sheets import loads Google's picker (components/imports/sheet-import.tsx).
      app === 'console' && 'https://apis.google.com',
    ],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    // Google's reviewer avatars (packages/ui google-reviews) come from googleusercontent.
    'img-src': ["'self'", 'data:', 'blob:', supabase, ...GOOGLE_MAPS, 'https://*.googleusercontent.com'],
    'connect-src': ["'self'", supabase, supabaseWs, ...GOOGLE_MAPS, ...SENTRY],
    'frame-src':
      app === 'web'
        ? ['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://my.matterport.com']
        : ["'self'", 'https://docs.google.com', 'https://accounts.google.com', 'https://content.googleapis.com'],
    'worker-src': ["'self'", 'blob:'],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
  });

  return [
    { key: 'Content-Security-Policy', value: ENFORCED },
    { key: 'Content-Security-Policy-Report-Only', value: reportOnly },
    // The older header, for browsers that predate frame-ancestors.
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // Two years. No includeSubDomains or preload: those bind every subdomain of the apex for good,
    // and that is a decision for the DNS cutover, not this file.
    { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
    // Nothing in either app asks for these. fullscreen and autoplay are left alone: the listing's
    // video and tour embeds use both.
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  ];
}
