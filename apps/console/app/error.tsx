'use client';

import { ConsoleError } from '@/components/console-error';

/**
 * The console's outer boundary.
 *
 * Catches what the route-group boundaries cannot: a throw inside
 * (agency)/layout.tsx or (agent)/layout.tsx themselves, and anything on the
 * (shared) auth pages, which sit in no group with a boundary of its own.
 *
 * Home is /login here rather than a console route, because a visitor who hits
 * this may well have no session — that is one of the ways the layouts fail.
 */
export default function ConsoleRootError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ConsoleError {...props} homeHref="/login" homeLabel="Go to sign in" />;
}
