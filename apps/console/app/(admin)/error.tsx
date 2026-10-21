'use client';

import { ConsoleError } from '@/components/console-error';

/** Admin console failures: the sidebar stays, only the content area is replaced. */
export default function AdminError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ConsoleError {...props} homeHref="/platform" homeLabel="Back to overview" />;
}
