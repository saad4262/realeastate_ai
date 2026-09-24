'use client';

import { ConsoleError } from '@/components/console-error';

/**
 * Agency console failures.
 *
 * Sits under (agency)/layout.tsx, so the sidebar, the nav and the header stay
 * on screen and only the content area is replaced. A full-page error would
 * lose the agent's place in the console for something that is usually one
 * failed query.
 */
export default function AgencyError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ConsoleError {...props} homeHref="/overview" homeLabel="Back to overview" />;
}
