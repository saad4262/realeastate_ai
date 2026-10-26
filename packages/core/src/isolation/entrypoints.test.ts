import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tenant isolation, the doors (ADR 0030 §3 "Routes"): every way into the
 * server from a browser — route handlers and server actions in both apps —
 * first establishes WHO is asking, or is public for a written reason and
 * carries the guard that reason depends on.
 *
 * Why a static check: the smoke suite cannot hold a signed-in browser
 * session, and the core functions behind these doors are covered by the
 * cross-agency matrix (smoke "Tenant isolation"). What is left to prove at the
 * door is that the actor handed to core comes from the session — never from
 * the request — and that a new route or action cannot forget it.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.next')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'apps', 'console', 'app')), ...walk(join(ROOT, 'apps', 'console', 'lib')), ...walk(join(ROOT, 'apps', 'web', 'app')), ...walk(join(ROOT, 'apps', 'web', 'lib'))];
const rel = (p: string) => relative(ROOT, p);

/** Calls that read the caller from the verified session (cookies / middleware header). */
const SESSION = /\b(requireActionUserId|actionUserId|requireAuthAccount|getAuthAccount|ensureConsumerAccount|currentWebUser|requireConsoleAccess|requireConsoleSession|requirePlatformAdmin|getSessionUser|requireUser)\s*\(/;

/**
 * Public on purpose, each with the guard its reason relies on (a regex that
 * must appear in the file). Adding a route here is a review decision.
 */
const PUBLIC_ROUTES: Record<string, { why: string; guard: RegExp }> = {
  'apps/console/app/(shared)/auth/callback/route.ts': { why: 'Supabase sign-in return: it creates the session', guard: /handleAuthCallback/ },
  'apps/web/app/auth/callback/route.ts': { why: 'Supabase sign-in return: it creates the session', guard: /handleAuthCallback/ },
  'apps/web/app/sign-out/route.ts': { why: 'ends the caller’s own session', guard: /signOut/ },
  'apps/console/app/(shared)/sign-out/route.ts': { why: 'ends the caller’s own session; its GET signs nobody out', guard: /signOut/ },
  'apps/console/app/integrations/stub/route.ts': { why: 'dev-only fake OAuth consent', guard: /stubEnabled/ },
  'apps/console/app/integrations/stub/decide/route.ts': { why: 'dev-only fake OAuth consent', guard: /stubEnabled[\s\S]*verifyState|verifyState[\s\S]*stubEnabled/ },
  'apps/web/app/api/chat/route.ts': { why: 'the public property guide: anonymous, public listings only', guard: /runPropertyChat/ },
  'apps/web/app/api/places/route.ts': { why: 'public address autocomplete, rate-limited per IP', guard: /overLimit/ },
  'apps/web/app/api/reviews/[listingId]/route.ts': {
    why: 'a live listing’s agency Google rating (ADR 0028): public like the listing; the agency comes from the listing, rate-limited',
    guard: /overLimit\(request\)[\s\S]*publicListingReviews\(/,
  },
  'apps/web/app/api/cron/alerts/route.ts': { why: 'the scheduler tick', guard: /authoriseCronRequest/ },
  'apps/web/app/api/cron/minute/route.ts': { why: 'the every-minute tick: scheduled actions and reminders (ADR 0035)', guard: /authoriseCronRequest/ },
  'apps/web/app/api/cron/documents/route.ts': { why: 'the document tick: attachments, reading, embedding (ADR 0053)', guard: /authoriseCronRequest/ },
  'apps/web/app/api/cron/opportunities/route.ts': { why: 'the hourly opportunity scan (ADR 0054)', guard: /authoriseCronRequest/ },
  'apps/web/app/api/mail/inbound/route.ts': { why: 'Resend inbound webhook, signed', guard: /svix/i },
  'apps/web/app/api/zoom/webhook/route.ts': {
    why: 'Zoom event notifications (ADR 0037): the URL check and a deauthorization, signed with the Secret Token',
    guard: /handleZoomWebhook\(/,
  },
  'apps/web/app/api/revalidate/route.ts': { why: 'cache revalidation from the console, shared secret', guard: /REVALIDATE_SECRET/ },
  'apps/web/app/unsubscribe/route.ts': { why: 'one-click unsubscribe from an email, signed token', guard: /verify(Contact)?UnsubscribeToken\(/ },
};

/** Server actions (whole files, or single functions as `file#fn`) that are public by nature, with their guard. */
const PUBLIC_ACTIONS: Record<string, { why: string; guard: RegExp }> = {
  'apps/web/app/(auth)/actions.ts': { why: 'sign in / sign up / reset: there is no session yet', guard: /signIn|signUp|resetPassword|auth\./ },
  'apps/web/lib/enquiry-action.ts#sendEnquiryAction': {
    why: 'the public enquiry form: anyone may enquire about a live listing; the agency comes from the listing, never the request',
    guard: /overLimit\(/,
  },
};

describe('tenant isolation — every door asks who is calling', () => {
  it('every route handler establishes the session, or is public for a written reason with its guard', () => {
    const routes = files.filter((f) => /[/\\]route\.ts$/.test(f));
    expect(routes.length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const f of routes) {
      const src = readFileSync(f, 'utf8');
      const pub = PUBLIC_ROUTES[rel(f)];
      if (pub) {
        if (!pub.guard.test(src)) problems.push(`${rel(f)}: public (${pub.why}) but its guard is gone`);
      } else if (!SESSION.test(src)) {
        problems.push(`${rel(f)}: no session check and not listed as public`);
      }
    }
    expect(problems).toEqual([]);
    const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !routes.map(rel).includes(k));
    expect(stale, 'a listed public route no longer exists').toEqual([]);
  });

  it('every exported server action reaches a session check before doing anything', () => {
    const actionFiles = files.filter((f) => f.endsWith('.ts') && /^'use server';/m.test(readFileSync(f, 'utf8')));
    expect(actionFiles.length).toBeGreaterThan(8);
    const problems: string[] = [];
    for (const f of actionFiles) {
      const src = readFileSync(f, 'utf8');
      const wholeFile = PUBLIC_ACTIONS[rel(f)];
      if (wholeFile) {
        if (!wholeFile.guard.test(src)) problems.push(`${rel(f)}: public (${wholeFile.why}) but its guard is gone`);
        continue;
      }
      // Local helpers that check the session (`actor()`, `run()`…), found transitively.
      const fnBodies = new Map<string, string>();
      // A body ends at a closing brace in column 0 followed by a newline (not `}):` of a parameter type).
      for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\([\s\S]*?\n\}(?=\n|$)/g)) fnBodies.set(m[1]!, m[0]);
      const guarded = new Set<string>();
      for (let changed = true; changed; ) {
        changed = false;
        for (const [name, body] of fnBodies) {
          if (guarded.has(name)) continue;
          const callsGuarded = [...guarded].some((g) => new RegExp(`\\b${g}\\s*\\(`).test(body.slice(body.indexOf('{'))));
          if (SESSION.test(body) || callsGuarded) {
            guarded.add(name);
            changed = true;
          }
        }
      }
      for (const m of src.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g)) {
        const pub = PUBLIC_ACTIONS[`${rel(f)}#${m[1]}`];
        if (pub) {
          if (!pub.guard.test(fnBodies.get(m[1]!) ?? '')) problems.push(`${rel(f)}#${m[1]}: public (${pub.why}) but its guard is gone`);
          continue;
        }
        if (!guarded.has(m[1]!)) problems.push(`${rel(f)}: ${m[1]} never checks the session`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no door takes the acting user or agency from the request', () => {
    const doors = files.filter((f) => /[/\\]route\.ts$/.test(f) || (f.endsWith('.ts') && /^'use server';/m.test(readFileSync(f, 'utf8'))));
    const problems: string[] = [];
    for (const f of doors) {
      const src = readFileSync(f, 'utf8');
      if (/searchParams\.get\(['"](userId|agencyId|user_id|agency_id)['"]\)|body\.(userId|agencyId)\b|formData\.get\(['"](userId|agencyId)['"]\)/.test(src)) {
        problems.push(rel(f));
      }
    }
    expect(problems).toEqual([]);
  });
});
