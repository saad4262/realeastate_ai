import { IntegrationError, listIntegrationSlots, stubEnabled, tokenKeysFromEnv, PROVIDERS, isIntegrationProvider } from '@repo/core/integrations';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { IntegrationCard } from './integration-ui';
import styles from './integrations.module.css';

/**
 * Settings → Integrations (docs/adr/0020), shared by the agency console
 * (`/settings/integrations`: the agency's accounts and the admin's own) and
 * the agent desk (`/my-integrations`: their own, and the agency's to look at).
 * Which slots appear, and which may be changed, is can()'s.
 */
export async function IntegrationsPage({
  surface,
  searchParams,
}: {
  surface: 'agency' | 'agent';
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess(surface);
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  let slots: Awaited<ReturnType<typeof listIntegrationSlots>> = [];
  let loadError: string | null = null;
  try {
    slots = await listIntegrationSlots(getConsoleDb(), session.actor);
  } catch (err) {
    loadError = err instanceof IntegrationError ? err.message : 'Failed to load integrations';
  }

  const connected = first(sp.connected);
  const missing = first(sp.missing);
  const disconnected = first(sp.disconnected);
  const unrevoked = first(sp.unrevoked) === '1';
  const error = first(sp.error);
  const configured = tokenKeysFromEnv() !== null;
  // Agency accounts first on the agency console; your own first on the desk.
  const ordered = [...slots].sort((a, b) =>
    a.ownerType === b.ownerType ? 0 : (a.ownerType === 'agency') === (surface === 'agency') ? -1 : 1,
  );

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>{surface === 'agency' ? 'Integrations' : 'My integrations'}</h1>
        <p className={contactStyles.sub}>
          Connect the accounts features rely on. A feature that needs one you have not connected says so,
          and never guesses.
        </p>
      </div>

      {connected && isIntegrationProvider(connected) ? (
        <p className={missing ? styles.bannerBad : styles.bannerOk} role="status">
          {missing
            ? `${PROVIDERS[connected].label} was connected without: ${missing}. Features that need it will ask you to reconnect.`
            : `${PROVIDERS[connected].label} connected.`}
        </p>
      ) : null}
      {disconnected && isIntegrationProvider(disconnected) ? (
        <p className={styles.bannerOk} role="status">{PROVIDERS[disconnected].label} disconnected — its stored access was deleted.
          {unrevoked ? ` ${PROVIDERS[disconnected].label} did not confirm, so also remove this app under your ${disconnected === 'zoom' ? 'Zoom' : 'Google'} account's connected apps.` : ''}</p>
      ) : null}
      {error ? <p className={styles.bannerBad} role="alert">{error}</p> : null}
      {!configured ? (
        <p className={styles.bannerBad} role="note">
          Integrations are not set up on this server yet (INTEGRATION_TOKEN_KEY). See docs/adr/0020.
        </p>
      ) : stubEnabled() ? (
        <p className={styles.banner} role="note">
          Development: Connect opens a pretend provider (INTEGRATIONS_STUB=1). No real account is involved.
        </p>
      ) : null}
      {loadError ? <p className={styles.bannerBad} role="alert">{loadError}</p> : null}

      <div className={styles.grid}>
        {ordered.map((slot) => (
          <IntegrationCard key={`${slot.provider}-${slot.ownerType}`} slot={slot} />
        ))}
      </div>
    </div>
  );
}
