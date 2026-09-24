/**
 * Tell the public site that a listing changed.
 *
 * The console and the consumer site are two Next applications, so
 * `revalidatePath` here clears only this one's cache. A published listing that
 * does not appear on the public site until a timer expires is the bug this
 * exists to prevent.
 *
 * Deliberately best-effort: a failure is logged and swallowed. The agent's
 * publish succeeded, and failing their action because a cache hint did not
 * land would be the wrong trade — the public site catches up on its own within
 * the revalidate window either way.
 */
export async function revalidateWeb(listingId?: string): Promise<void> {
  const secret = process.env.REVALIDATE_SECRET?.trim();
  const base = process.env.NEXT_PUBLIC_WEB_URL?.trim();
  if (!secret || !base) return;

  try {
    await fetch(`${base}/api/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': secret,
      },
      body: JSON.stringify(listingId ? { listingId } : {}),
      // The agent is waiting for a page transition; this must not hold it up.
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
  } catch {
    /* the public site expires its own cache soon enough */
  }
}
