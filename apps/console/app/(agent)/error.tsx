'use client';

import { ConsoleError } from '@/components/console-error';

/** Agent desk failures — same treatment, different home. */
export default function AgentError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ConsoleError {...props} homeHref="/listings" homeLabel="Back to my listings" />;
}
