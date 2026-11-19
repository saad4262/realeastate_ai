import { headers } from 'next/headers';
import { readSignedIdentity, sessionHeaderSecret } from '@repo/auth/session-header';

/** This request's assurance level and last MFA time for `userId`, from middleware's signed header (1.2, 1.3, 1.22). */
export async function sessionAuth(userId: string): Promise<{ aal?: 'aal1' | 'aal2'; mfaAt?: number } | undefined> {
  const h = await headers();
  const who = await readSignedIdentity((n) => h.get(n), 'x-console-user', Date.now(), sessionHeaderSecret());
  return who?.id === userId ? { aal: who.aal, mfaAt: who.mfaAt } : undefined;
}
