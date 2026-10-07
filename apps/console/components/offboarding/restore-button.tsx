'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { restoreMemberAction } from '@/lib/offboarding-actions';

export function RestoreButton({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        confirm(`Restore ${name}? They get access back; their connected accounts must be reconnected, and moved work stays moved.`) &&
        start(async () => {
          const r = await restoreMemberAction(userId);
          if (!r.ok) alert(r.error);
          router.refresh();
        })
      }
    >
      {pending ? 'Restoring…' : 'Undo removal'}
    </button>
  );
}
