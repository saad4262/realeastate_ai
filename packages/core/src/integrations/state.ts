import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { stateKey, type TokenKeys } from './crypto';
import { INTEGRATION_PROVIDERS } from './providers';

/**
 * The OAuth `state` parameter (ADR 0020): who started the connection, for
 * what, from which console — signed, expiring in ten minutes, and BOUND to the
 * user: the return route refuses unless the signed-in user is `userId`.
 *
 * `surface` decides which console host the return route hands over to; the
 * host itself is never in the state, so a state cannot point anywhere else.
 */

export const STATE_TTL_MS = 10 * 60 * 1000;

export const oauthStateSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  ownerType: z.enum(['user', 'agency']),
  ownerId: z.string().uuid(),
  agencyId: z.string().uuid(),
  userId: z.string().uuid(),
  surface: z.enum(['agency', 'agent']),
  nonce: z.string().min(8),
  exp: z.number().int(),
});
export type OAuthState = z.infer<typeof oauthStateSchema>;

function mac(body: string, keys: TokenKeys): Buffer {
  return createHmac('sha256', stateKey(keys)).update(body).digest();
}

export function signState(
  input: Omit<OAuthState, 'nonce' | 'exp'>,
  keys: TokenKeys,
  now = Date.now(),
): string {
  const payload: OAuthState = { ...input, nonce: randomBytes(12).toString('base64url'), exp: now + STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, keys).toString('base64url')}`;
}

/** The state, if it is ours, intact and not expired. Null otherwise — never a reason an attacker could use. */
export function verifyState(token: string | null | undefined, keys: TokenKeys, now = Date.now()): OAuthState | null {
  if (!token || token.length > 2000) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = mac(body, keys);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const parsed = oauthStateSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (!parsed.success || parsed.data.exp < now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
