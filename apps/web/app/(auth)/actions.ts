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
 * ## Still no client JavaScript
 *
 * Every one of these is a server action behind a plain `<form action={…}>`.
 * Supabase's SSR client sets its cookies on the response, so signing in
 * server-side works and the browser downloads nothing. The first build of
 * this screen imported `createBrowserSupabaseClient` and cost 69 kB of
 * First Load to send one email; these pages are 352 B.
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
 * Supabase's own messages leak whether an address is registered.
 *
 * "User already registered" on signup and "Invalid login credentials" on
 * sign-in are different enough to enumerate accounts with. The second is
 * fine — it is the same answer for a wrong password and an unknown address.
 * The first is not, so it is rewritten.
 */
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

function friendlyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('already registered') || lower.includes('already exists')) {
    return 'already_registered';
  }
  if (lower.includes('invalid login')) return 'bad_credentials';
  if (lower.includes('email not confirmed')) return 'unconfirmed';
  if (lower.includes('weak') || lower.includes('password')) return 'weak_password';
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

  if (error) redirect(back(friendlyError(error.message)));

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

  if (error) redirect(back(friendlyError(error.message)));

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

  if (error) redirect(`/reset?error=${friendlyError(error.message)}`);

  redirect('/alerts?password=updated');
}
