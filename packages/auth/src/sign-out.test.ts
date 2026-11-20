import { afterEach, describe, expect, it, vi } from 'vitest';
import { signOutResponse } from './sign-out';

const request = (host: string, names: string[]) => ({
  headers: new Headers({ host }),
  cookies: { getAll: () => names.map((name) => ({ name, value: 'x' })) },
});

describe('signOutResponse', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('deletes each session cookie host-only AND under the cookie domain, and nothing else', async () => {
    vi.stubEnv('COOKIE_DOMAIN', '.lvh.me');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const r = await signOutResponse(request('agents.lvh.me:3001', ['sb-ref-auth-token.0', 'sb-ref-auth-token.1', 'console-other']), 'local', 'http://agents.lvh.me:3001/login');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('http://agents.lvh.me:3001/login');
    expect(r.headers.getSetCookie()).toEqual([
      'sb-ref-auth-token.0=; Path=/; Max-Age=0; SameSite=Lax',
      'sb-ref-auth-token.0=; Path=/; Max-Age=0; Domain=.lvh.me; SameSite=Lax',
      'sb-ref-auth-token.1=; Path=/; Max-Age=0; SameSite=Lax',
      'sb-ref-auth-token.1=; Path=/; Max-Age=0; Domain=.lvh.me; SameSite=Lax',
    ]);
  });

  it('a host outside the cookie domain gets the host-only deletion only', async () => {
    vi.stubEnv('COOKIE_DOMAIN', '.lvh.me');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const r = await signOutResponse(request('localhost:3000', ['sb-ref-auth-token']), 'global', 'http://localhost:3000/');
    expect(r.headers.getSetCookie()).toEqual(['sb-ref-auth-token=; Path=/; Max-Age=0; SameSite=Lax']);
  });
});
