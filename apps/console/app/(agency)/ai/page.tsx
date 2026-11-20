import { redirect } from 'next/navigation';

/**
 * O-40 (owner, 2026-11-21): this was a design mock of an "AI operating system" — invented throughput, model names,
 * latency, automations and results. Removed; the agency's real assistant is the Overview. Kept as a redirect so an
 * old link or bookmark still lands somewhere.
 */
export default function AiPage() {
  redirect('/overview');
}
