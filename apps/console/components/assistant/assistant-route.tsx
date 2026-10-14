'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Where "Ask the assistant" goes when the assistant is a page, not a panel.
 *
 * The contact directory's picks bar fires `assistant:open` (picks.ts). On the
 * agent desk the floating panel listens for it; on the agency console the
 * assistant is the home page, so this takes the person there. The picks live
 * in an in-browser store, so they arrive with them.
 */
export function AssistantRoute({ home }: { home: string }) {
  const router = useRouter();
  useEffect(() => {
    const go = () => router.push(home);
    window.addEventListener('assistant:open', go);
    return () => window.removeEventListener('assistant:open', go);
  }, [router, home]);
  return null;
}
