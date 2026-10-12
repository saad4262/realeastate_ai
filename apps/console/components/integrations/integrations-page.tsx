import { IntegrationError, listIntegrationSlots, stubEnabled, tokenKeysFromEnv, PROVIDERS, isIntegrationProvider } from '@repo/core/integrations';
import { agencyGmailSharing } from '@repo/core/mail';
import { setAgencyGmailSharingAction } from '../../lib/integration-actions';
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
  const sharing = await agencyGmailSharing(getConsoleDb(), session.actor);
  // Zoom, Sheets and Gmail can each be connected twice — the person's own and
  // the agency's — so the two kinds are separate sections, never one grid
  // where the same app appears twice with nothing to say why. Agency accounts
  // first on the agency console; your own first on the desk.
  const own = slots.filter((s) => s.ownerType === 'user');
  const agency = slots.filter((s) => s.ownerType === 'agency');
  const agencyManaged = agency.some((s) => s.mayManage);
  const sections = [
    {
      key: 'user',
      title: 'Your accounts',
      hint: 'Connected by you and used for what you do. Where both exist, your own account is used before the agency’s.',
      slots: own,
    },
    {
      key: 'agency',
      title: 'The agency’s accounts',
      hint: agencyManaged
        ? 'Shared by everyone in the agency. Used when a member has not connected their own.'
        : `Shared by everyone in the agency, used when you have not connected your own${
            sharing.on ? '' : ' (except Gmail — the agency has not shared it with members)'
          }. Only an owner or admin connects these.`,
      slots: agency,
    },
  ].filter((section) => section.slots.length > 0);
  if (surface === 'agency') sections.reverse();

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

      {sections.map((section) => (
        <section key={section.key} className={styles.section}>
          <div>
            <h2 className={styles.sectionTitle}>{section.title}</h2>
            <p className={styles.note}>{section.hint}</p>
          </div>
          <div className={styles.grid}>
            {section.slots.map((slot) => (
              <IntegrationCard
                key={`${slot.provider}-${slot.ownerType}`}
                slot={slot}
                compact={slot.ownerType === 'agency' && !slot.mayManage}
              />
            ))}
          </div>
        </section>
      ))}

      {sharing.mayChange && surface === 'agency' ? (
        <form action={setAgencyGmailSharingAction} className={contactStyles.card} style={{ padding: '1rem', marginTop: '1rem' }}>
          <input type="hidden" name="on" value={sharing.on ? '0' : '1'} />
          <p style={{ margin: '0 0 0.5rem' }}>
            <strong>Members may send from the agency Gmail:</strong> {sharing.on ? 'On' : 'Off'}. When it is on, an agent
            without their own Gmail connected sends one-to-one emails from the agency’s Gmail; when off, from the platform
            address. Owners and admins may always use it. Bulk template email always goes from the platform address.
          </p>
          <button type="submit">{sharing.on ? 'Turn off' : 'Turn on'}</button>
        </form>
      ) : null}
    </div>
  );
}
