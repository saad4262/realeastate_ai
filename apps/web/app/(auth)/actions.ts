'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@repo/auth/server';
import { ensureAppUser } from '@repo/core/identity';
import { getWebDb } from '../../lib/db';
import { MIN_PASSWORD } from './constants';

/**
 * Email, password and a name.
 *
 * This replaced a magic-link-only sign-in. The trade is real and worth
 * writing down: a link in an inbox has no credential to leak and no reset
 * flow to build, but it also means waiting for an email every single time
 * you want to look at your own saved searches. For somebody checking
 * property daily that is the wrong side of the trade, and it is the reason
 * the console has always used passwords.
 *
 * ## Almost no client JavaScript
 *
 * Every one of these is a server action behind a plain `<form action={…}>`.
 * Supabase's SSR client sets its cookies on the response, so signing in
 * happens server-side. The first build of this screen imported
 * `createBrowserSupabaseClient` and cost 69 kB of First Load to send one
 * email; these pages were 352 B afterwards.
 *
 * They are 815 B now, and the ~460 B is `./submit-button.tsx` — one client
 * component per form, which is what gives the button a pending state and
 * stops it being pressed twice while Supabase is thinking. The rule that
 * mattered was never "zero JavaScript"; it was "no auth SDK in the
 * browser", and that still holds. See the note in that file for why the
 * button had to be its own component.
 */



function originOf(host: string | null): string {
  if (!host) return process.env.NEXT_PUBLIC_WEB_URL ?? '';
  const proto = host.startsWith('localhost') || host.endsWith('.lvh.me') ? 'http' : 'https';
  return `${proto}://${host}`;
}

/** Relative only. This value lands an authenticated session. */
function safeNext(value: FormDataEntryValue | null): string {
  const candidate = typeof value === 'string' ? value : '';
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/alerts';
}

function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Mirror the new auth user into `public.user`, now rather than later.
 *
 * Everything a consumer owns — saved searches, saved conversations — has a
 * foreign key to this row, and it was only being created on a visit to
 * /alerts. Somebody who signed up and went straight to the chat therefore
 * had a session and no row, so every transcript insert died on
 * `chat_thread_user_id_user_id_fk` and was swallowed by the writer's catch.
 * The symptom was an empty History with nothing in the UI to explain it.
 *
 * Done here because this is the moment the account comes into existence,
 * and the identity comes from Supabase's own response rather than from the
 * form — the ADR 0006 rule, applied to the one request where the session
 * headers do not exist yet because the session is being created by it.
 *
 * Failure is swallowed: `ensureAppUser` is idempotent and runs again on
 * the first account page, so a database hiccup must not cost somebody the
 * sign-in they just completed.
 */
async function mirrorAppUser(user: { id: string; email?: string | null }, name?: string) {
  try {
    await ensureAppUser(getWebDb(), {
      id: user.id,
      email: user.email ?? '',
      ...(name ? { name } : {}),
    });
  } catch (err) {
    console.error('[auth] could not mirror the account into public.user', err);
  }
}

/** Enough of an address to match a log line to a report, and no more. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(local.length - 2, 0))}@${domain}`;
}

/**
 * What went wrong, as a code the page has a sentence for.
 *
 * ## Read `code`, not `message`
 *
 * This used to match on substrings of `error.message`, and that was wrong in
 * a way that cost an afternoon. The test was
 * `lower.includes('weak') || lower.includes('password')` — so ANY failure
 * whose message happened to contain the word "password" came back as
 * `weak_password`, and `/login` has no sentence for that code because a
 * weak password is not a thing you can fail sign-in with. It fell through to
 * `failed`: "Something went wrong signing you in." A rate limit, a banned
 * account and a dropped connection all arrived looking identical, and none
 * of them said what they were.
 *
 * `AuthApiError` has carried a stable `code` since auth-js 2.x, so that is
 * what is read. The message is still consulted as a fallback for the
 * non-API errors — a fetch that never got a reply has no code at all.
 *
 * ## And it is logged
 *
 * Every branch here throws the real reason away before it reaches the
 * browser, which is correct — `invalid_credentials` is deliberately the
 * same answer for a wrong password and an address with no account, because
 * a page that tells those apart is an account-enumeration oracle. Signup is
 * the one place that cannot hide it: the account either gets created or it
 * does not. But nothing was
 * writing it down either, so a report of "it says something went wrong" had
 * no corresponding record anywhere. One `console.error` on the server is the
 * whole difference between that and knowing.
 */
function classify(error: unknown, context: string, email: string): string {
  const err = error as { code?: string; status?: number; message?: string; name?: string };
  const code = typeof err?.code === 'string' ? err.code : '';
  const message = typeof err?.message === 'string' ? err.message : String(error);

  console.error('[auth] %s failed', context, {
    email: maskEmail(email),
    code: code || '(none)',
    status: err?.status ?? '(none)',
    name: err?.name ?? '(none)',
    message,
  });

  switch (code) {
    case 'invalid_credentials':
      return 'bad_credentials';
    case 'email_not_confirmed':
      return 'unconfirmed';
    case 'user_already_exists':
    case 'email_exists':
      return 'already_registered';
    case 'weak_password':
      return 'weak_password';
    case 'user_banned':
      return 'banned';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
    case 'over_sms_send_rate_limit':
      return 'rate_limited';
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'signup_disabled';
  }

  /**
   * No code means it never reached Supabase's API — a DNS failure, a dropped
   * TLS handshake, a timeout. Worth its own sentence: "try again" is real
   * advice for this one and useless for most of the others.
   */
  if (err?.status === 429) return 'rate_limited';
  if (err?.name === 'AuthRetryableFetchError' || /fetch failed|network|timeout|ENOTFOUND|ECONNRESET/i.test(message)) {
    return 'unavailable';
  }

  const lower = message.toLowerCase();
  if (lower.includes('already registered') || lower.includes('already exists')) {
    return 'already_registered';
  }
  if (lower.includes('invalid login')) return 'bad_credentials';
  if (lower.includes('email not confirmed')) return 'unconfirmed';
  return 'failed';
}

export async function signUpAction(formData: FormData): Promise<void> {
  const name = field(formData, 'name');
  const email = field(formData, 'email').toLowerCase();
  const password = field(formData, 'password');
  const next = safeNext(formData.get('next'));
  const back = (code: string) =>
    `/signup?error=${code}&next=${encodeURIComponent(next)}&name=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`;

  if (!name) redirect(back('no_name'));
  if (!email.includes('@') || email.length > 320) redirect(back('bad_email'));
  if (password.length < MIN_PASSWORD) redirect(back('short_password'));

  const origin = originOf((await headers()).get('host'));
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Read back by ensureConsumerAccount through the middleware's label
      // header, so the `user` row gets a name without a second form.
      data: { full_name: name },
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) redirect(back(classify(error, 'sign-up', email)));

  /**
   * Whether a session exists here depends on a project setting.
   *
   * With "Confirm email" on, Supabase creates the user and returns NO
   * session — they have to click the link first. With it off, they are
   * signed in immediately. Both are legitimate configurations, so this
   * branches on what actually came back rather than assuming one.
   */
  if (data.user) await mirrorAppUser(data.user, name);

  if (!data.session) redirect('/signup?sent=1');

  redirect(next);
}

export async function signInAction(formData: FormData): Promise<void> {
  const email = field(formData, 'email').toLowerCase();
  const password = field(formData, 'password');
  const next = safeNext(formData.get('next'));
  const back = (code: string) =>
    `/login?error=${code}&next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`;

  if (!email || !password) redirect(back('bad_credentials'));

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) redirect(back(classify(error, 'sign-in', email)));

  // Covers accounts created before this mirroring existed, too.
  if (data.user) {
    const meta = data.user.user_metadata as { full_name?: string } | undefined;
    await mirrorAppUser(data.user, meta?.full_name);
  }

  redirect(next);
}

/**
 * Send a reset link.
 *
 * Always reports success, whatever Supabase says. "No account with that
 * address" on a public form is an account-enumeration oracle, and the
 * person who genuinely mistyped is told to check their inbox and will work
 * it out when nothing arrives — which is the ordinary experience of every
 * password reset anywhere.
 */
export async function requestResetAction(formData: FormData): Promise<void> {
  const email = field(formData, 'email').toLowerCase();
  if (!email.includes('@')) redirect('/forgot?error=bad_email');

  const origin = originOf((await headers()).get('host'));
  const supabase = await createServerSupabaseClient();

  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset`,
  });

  redirect('/forgot?sent=1');
}

/**
 * Set a new password.
 *
 * Reached only from the emailed link, which `handleAuthCallback` has
 * already traded for a session — so the authorisation here is that session,
 * and `updateUser` fails on its own if there is not one.
 */
export async function setPasswordAction(formData: FormData): Promise<void> {
  const password = field(formData, 'password');
  if (password.length < MIN_PASSWORD) redirect('/reset?error=short_password');

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) redirect(`/reset?error=${classify(error, 'set-password', '(session)')}`);

  redirect('/alerts?password=updated');
}
