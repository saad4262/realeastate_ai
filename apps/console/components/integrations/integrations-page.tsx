import Link from 'next/link';
import { IntegrationError, listIntegrationSlots, stubEnabled, tokenKeysFromEnv, PROVIDERS, isIntegrationProvider } from '@repo/core/integrations';
import { agencyGmailSharing } from '@repo/core/mail';
import { setAgencyGmailSharingAction } from '../../lib/integration-actions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { FeatureCard, IntegrationCard } from './integration-ui';
import styles from './integrations.module.css';

/**
 * Connectors (docs/adr/0020; called Integrations until the agency redesign),
 * shared by the agency console (`/settings/integrations`: the agency's
 * accounts and the admin's own) and the agent desk (`/my-integrations`: their
 * own, and the agency's to look at). Which slots appear, and which may be
 * changed, is can()'s.
 *
 * Laid out as a rail of filters beside a grid of cards. The filter and the
 * search are the URL (`?view=`, `?q=`) — a GET form and links — so they work
 * before JavaScript and survive Back; they only choose which of the cards
 * can() already allowed are drawn.
 */

type View = 'all' | 'connected' | 'agency' | 'user' | 'builtin';
const VIEWS: readonly View[] = ['all', 'connected', 'agency', 'user', 'builtin'];

/** The console's own features that sit beside the connected accounts, as cards that open them. */
const FEATURES: Record<'agency' | 'agent', { href: string; label: string; icon: string; purpose: string }[]> = {
  agency: [
    { href: '/bulk-email', label: 'Bulk email', icon: 'forward_to_inbox', purpose: 'An approved template to the contacts in one of your saved filters — only people who agreed to marketing email.' },
    { href: '/bulk-email/templates', label: 'Email templates', icon: 'draft', purpose: 'The approved templates that bulk email and the assistant send from.' },
    { href: '/skills', label: 'Skills', icon: 'auto_awesome', purpose: 'Ready-made AI jobs that read only what you can see and never send or change anything on their own.' },
    { href: '/settings/reviews', label: 'Google reviews', icon: 'reviews', purpose: 'The agency’s public Google rating and reviews, shown on your live listings’ pages.' },
  ],
  agent: [
    { href: '/my-bulk-email', label: 'Bulk email', icon: 'forward_to_inbox', purpose: 'An approved template to the contacts in one of your saved filters — only people who agreed to marketing email.' },
    { href: '/my-bulk-email/templates', label: 'Email templates', icon: 'draft', purpose: 'The approved templates that bulk email and the assistant send from.' },
    { href: '/my-skills', label: 'Skills', icon: 'auto_awesome', purpose: 'Ready-made AI jobs that read only what you can see and never send or change anything on their own.' },
    { href: '/my-reviews', label: 'Agency reviews', icon: 'reviews', purpose: 'The agency’s public Google rating and reviews, shown on your live listings’ pages.' },
  ],
};
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
    loadError = err instanceof IntegrationError ? err.message : 'Failed to load connectors';
  }

  const connected = first(sp.connected);
  const missing = first(sp.missing);
  const disconnected = first(sp.disconnected);
  const unrevoked = first(sp.unrevoked) === '1';
  const error = first(sp.error);
  const rawView = first(sp.view);
  const view: View = VIEWS.includes(rawView as View) ? (rawView as View) : 'all';
  const q = (first(sp.q) ?? '').trim().slice(0, 80);
  const matches = (...text: string[]) => !q || text.some((t) => t.toLowerCase().includes(q.toLowerCase()));
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

  const isConnected = (slot: (typeof slots)[number]) => slot.account?.state === 'connected';
  const features = FEATURES[surface].filter((f) => matches(f.label, f.purpose));
  const shownSections = sections
    .filter((section) => view === 'all' || view === 'connected' || view === section.key)
    .map((section) => ({
      ...section,
      slots: section.slots.filter(
        (slot) => (view !== 'connected' || isConnected(slot)) && matches(PROVIDERS[slot.provider].label, PROVIDERS[slot.provider].purpose),
      ),
    }))
    .filter((section) => section.slots.length > 0);
  const showFeatures = (view === 'all' || view === 'builtin') && features.length > 0;
  const rail: { view: View; label: string; count: number }[] = [
    { view: 'all', label: 'All', count: slots.length + FEATURES[surface].length },
    { view: 'connected', label: 'Connected', count: slots.filter(isConnected).length },
    ...sections.map((section) => ({ view: section.key as View, label: section.title, count: section.slots.length })),
    { view: 'builtin', label: 'Built-in tools', count: FEATURES[surface].length },
  ];
  const hrefFor = (v: View) => {
    const params = new URLSearchParams();
    if (v !== 'all') params.set('view', v);
    if (q) params.set('q', q);
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };
  const title = surface === 'agency' ? 'Connectors' : 'My connectors';
  const path = surface === 'agency' ? '/settings/integrations' : '/my-integrations';

  return (
    <div className={contactStyles.wrap}>
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
          Connectors are not set up on this server yet (INTEGRATION_TOKEN_KEY). See docs/adr/0020.
        </p>
      ) : stubEnabled() ? (
        <p className={styles.banner} role="note">
          Development: Connect opens a pretend provider (INTEGRATIONS_STUB=1). No real account is involved.
        </p>
      ) : null}
      {loadError ? <p className={styles.bannerBad} role="alert">{loadError}</p> : null}

      <div className={styles.layout}>
        <aside className={styles.rail} aria-label="Filter connectors">
          {/* A GET form keyed on the query, so a navigation remounts it rather than drifting from the URL. */}
          <form key={q} method="get" role="search" className={styles.search}>
            <span className={styles.searchIcon} aria-hidden>
              search
            </span>
            {view !== 'all' ? <input type="hidden" name="view" value={view} /> : null}
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search"
              aria-label="Search connectors"
              className={styles.searchInput}
            />
          </form>
          {rail.map((r, i) => (
            <div key={r.view}>
              {i === 2 ? <div className={styles.railLabel}>Categories</div> : null}
              {/* Not prefetched: five variants of this same page, each a request through middleware. */}
              <Link
                href={hrefFor(r.view)}
                prefetch={false}
                className={r.view === view ? `${styles.railLink} ${styles.railLinkOn}` : styles.railLink}
                aria-current={r.view === view ? 'page' : undefined}
              >
                <span>{r.label}</span>
                <span className={styles.railCount}>{r.count}</span>
              </Link>
            </div>
          ))}
        </aside>

        <section className={styles.panel} aria-labelledby="connectors-title">
          <div className={styles.panelHead}>
            <span className={styles.glyph} aria-hidden>
              hub
            </span>
            <h1 id="connectors-title" className={styles.panelTitle}>
              {title}
            </h1>
          </div>
          <div className={styles.hero}>
            <h2 className={styles.heroTitle}>Build from what you already use</h2>
            <p className={styles.heroSub}>
              Connect the accounts features rely on. A feature that needs one you have not connected says so,
              and never guesses.
            </p>
          </div>

          <div className={styles.panelBody}>
            {shownSections.map((section) => (
              <section key={section.key} className={styles.section}>
                <div>
                  <h3 className={styles.sectionTitle}>{section.title}</h3>
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

            {showFeatures ? (
              <section className={styles.section}>
                <div>
                  <h3 className={styles.sectionTitle}>Built-in tools</h3>
                  <p className={styles.note}>Part of the console — nothing to connect. Each opens its own page.</p>
                </div>
                <div className={styles.grid}>
                  {features.map((f) => (
                    <FeatureCard key={f.href} {...f} />
                  ))}
                </div>
              </section>
            ) : null}

            {!shownSections.length && !showFeatures ? (
              <p className={styles.empty}>{q ? `Nothing matches “${q}”.` : 'Nothing here yet.'}</p>
            ) : null}

            {sharing.mayChange && surface === 'agency' && (view === 'all' || view === 'agency') && !q ? (
              <form action={setAgencyGmailSharingAction} className={contactStyles.card} style={{ padding: '1rem' }}>
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
        </section>
      </div>
    </div>
  );
}
