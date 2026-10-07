import { notFound } from 'next/navigation';
import { OffboardError, offboardingPreview } from '@repo/core/team';
import { RemoveMember } from '@/components/offboarding/remove-member';
import { getConsoleDb } from '../../../../../lib/db';
import { requireConsoleAccess } from '../../../../../lib/require-console-access';

/** Remove a member (docs/adr/0030 §5): what it touches, who receives the work, then Remove. */
export default async function Page({ params }: { params: Promise<{ userId: string }> }) {
  const session = await requireConsoleAccess('agency');
  const { userId } = await params;
  try {
    const preview = await offboardingPreview(getConsoleDb(), session.actor, userId);
    return <RemoveMember preview={preview} />;
  } catch (err) {
    if (err instanceof OffboardError) {
      if (err.code === 'not_found') notFound();
      return <p style={{ padding: '1.5rem' }}>{err.message}</p>;
    }
    throw err;
  }
}
