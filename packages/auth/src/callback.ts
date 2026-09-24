import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from './server';

/**
 * Where every emailed auth link lands: password recovery, email confirmation,
 * invitations.
 *
 * @supabase/ssr pins flowType 'pkce', so the link comes back carrying a
 * one-time `code` that only the server can trade for a session. Pointing those
 * emails straight at /login skipped that trade entirely — the session was
 * never created and the code was silently dropped.
 *
 * This lives in @repo/auth rather than in a route file because it is the only
 * remaining place an app imported @supabase/* directly, and every other piece
 * of the auth flow is already here. An app's route handler should be able to
 * hand the request over and forward the answer.
 */

/**
 * request.nextUrl.origin reports the server's own address, not the host the
 * browser asked for, so on agency.lvh.me it hands back localhost and the
 * redirect lands on the wrong surface. The host header is the same source
 * middleware resolves the surface from.
 */
function originOf(request: NextRequest): string {
  const host = request.headers.get('host');
  if (!host) return request.nextUrl.origin;
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.endsWith('.lvh.me') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function handleAuthCallback(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const origin = originOf(request);

  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const nextParam = searchParams.get('next');

  // Relative only — this value decides where an authenticated session lands,
  // and `//evil.example` is a protocol-relative absolute URL.
  const next =
    nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  const fail = (reason?: string) =>
    NextResponse.redirect(
      reason
        ? `${origin}/login?error=auth_link&reason=${encodeURIComponent(reason)}`
        : `${origin}/login?error=auth_link`,
    );

  // Supabase reports a refused or stale link in the query, not by omission.
  const errorCode = searchParams.get('error') ?? searchParams.get('error_code');
  if (errorCode) {
    return fail(searchParams.get('error_description') ?? errorCode);
  }

  const supabase = await createServerSupabaseClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return fail(error.message);
  }

  // Older templates send {{ .TokenHash }} instead of a code.
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as 'recovery' | 'email' | 'invite' | 'magiclink' | 'signup',
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return fail(error.message);
  }

  return fail();
}
