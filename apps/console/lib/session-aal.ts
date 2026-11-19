import { headers } from 'next/headers';
import { readSignedIdentity, sessionHeaderSecret } from '@repo/auth/session-header';

/** This request's assurance level for `userId`, from middleware's signed header (PLATFORM-PLAN 1.2, 1.3). */
export async function sessionAal(userId: string): Promise<'aal1' | 'aal2' | undefined> {
  const h = await headers();
  const who = await readSignedIdentity((n) => h.get(n), 'x-console-user', Date.now(), sessionHeaderSecret());
  return who?.id === userId ? who.aal : undefined;
}
