import { AiConsole } from './ai-console';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * A design mock, labelled as one.
 *
 * Everything on this screen except the agency's own name is placeholder. It is
 * said out loud at the top rather than left for the viewer to work out, because
 * the previous version of this page was indistinguishable from real reporting
 * about a real agency.
 */
export default async function AiPage() {
  const session = await requireConsoleAccess('agency');

  return (
    <>
      <p
        role="note"
        style={{
          margin: '0 0 1rem',
          padding: '0.625rem 0.875rem',
          borderRadius: '0.5rem',
          border: '1px solid var(--amber, #b45309)',
          background: 'color-mix(in srgb, #b45309 10%, transparent)',
          color: 'var(--text-primary)',
          fontSize: '0.8125rem',
          fontWeight: 500,
        }}
      >
        Preview only — every figure on this page is placeholder. Nothing here is
        connected to a model or a data feed yet.
      </p>
      <AiConsole agencyName={session.agencyName} />
    </>
  );
}
