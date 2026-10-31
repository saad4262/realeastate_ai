import {
  PROVIDERS,
  STATUS_LABELS,
  type IntegrationRequirement,
  type IntegrationSlot,
  type IntegrationState,
} from '@repo/core/integrations';
import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import contactStyles from '@/components/contacts/contacts.module.css';
import { chooseIntegrationAction, connectIntegrationAction, disconnectIntegrationAction } from '@/lib/integration-actions';
import { ConfirmSubmit } from './confirm-submit';
import styles from './integrations.module.css';

/**
 * The reusable integration UI (docs/adr/0020): a settings card per slot, and
 * the "Connect X first" gate any feature shows when `requireIntegrations` says
 * a provider is not usable. Server components; the buttons are plain forms
 * posting to server actions, which re-check with can().
 */

const TONE: Record<IntegrationState, string | undefined> = {
  connected: styles.ok,
  expired: styles.warn,
  permission_missing: styles.warn,
  error: styles.bad,
  not_connected: '',
};

export function StatusPill({ state }: { state: IntegrationState }) {
  return <span className={`${styles.status} ${TONE[state] ?? ''}`}>{STATUS_LABELS[state]}</span>;
}

/** A Connect button for one slot — a form, so it works before any JavaScript loads. */
export function ConnectButton({
  provider,
  ownerType,
  label,
}: {
  provider: IntegrationSlot['provider'];
  ownerType: IntegrationSlot['ownerType'];
  label?: string;
}) {
  return (
    <form action={connectIntegrationAction}>
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="ownerType" value={ownerType} />
      <button type="submit" className={contactStyles.btn}>{label ?? 'Connect'}</button>
    </form>
  );
}

/** A glyph per provider for the card's icon tile — the console's icon font, not brand logos. */
const ICONS: Partial<Record<IntegrationSlot['provider'], string>> = {
  google_calendar: 'calendar_month',
  zoom: 'videocam',
  google_sheets: 'table_chart',
  gmail: 'mail',
  google_reviews: 'reviews',
  // ADR 0076: the console's own glyphs, never a brand logo.
  outlook_mail: 'outgoing_mail',
  outlook_calendar: 'event',
};

/** The card's icon tile; the dot says "connected" at a glance, the pill beside it says it in words. */
function ConnectorIcon({ icon, connected = false }: { icon: string; connected?: boolean }) {
  return (
    <span className={styles.icon} aria-hidden>
      <span className={styles.iconGlyph}>{icon}</span>
      {connected ? <span className={styles.iconDot} /> : null}
    </span>
  );
}

/**
 * One connector, as a card in the grid: icon, name, what it is for, and the
 * one action that matters (Connect / Reconnect) on the right. The account's
 * facts, the permission list and Disconnect wait under Details.
 *
 * `compact`: a slot this person can only look at — the agency's accounts on
 * the agent desk. Name, status and which account; the permission list and the
 * "who may change it" line belong to whoever manages it, and the section
 * heading above already says it is the agency's.
 */
export function IntegrationCard({ slot, compact = false }: { slot: IntegrationSlot; compact?: boolean }) {
  const info = PROVIDERS[slot.provider];
  const a = slot.account;
  const state: IntegrationState = a ? a.state : 'not_connected';
  const icon = <ConnectorIcon icon={ICONS[slot.provider] ?? 'extension'} connected={state === 'connected'} />;
  if (compact) {
    return (
      <article className={`${styles.card} ${styles.compact}`}>
        <div className={styles.cardMain}>
          {icon}
          <div className={styles.cardText}>
            <span className={styles.name}>{info.label}</span>
            {a?.accountLabel ? <p className={styles.purpose}>{a.accountLabel}</p> : null}
          </div>
          <div className={styles.cardSide}>
            <StatusPill state={state} />
          </div>
        </div>
      </article>
    );
  }
  return (
    <article className={styles.card}>
      <div className={styles.cardMain}>
        {icon}
        <div className={styles.cardText}>
          <span className={styles.name}>{info.label}</span>
          <span className={styles.level}>{slot.ownerType === 'agency' ? "The agency's account" : 'Your own account'}</span>
          <p className={styles.purpose}>{info.purpose}</p>
        </div>
        <div className={styles.cardSide}>
          {state !== 'not_connected' ? <StatusPill state={state} /> : null}
          {/* ADR 0076: with Google's and Microsoft's both connected, one of each is in use. */}
          {slot.choice?.alternative && slot.choice.active ? <span className={styles.level}>In use</span> : null}
          {slot.choice?.alternative && !slot.choice.active && slot.mayManage ? (
            <form action={chooseIntegrationAction}>
              <input type="hidden" name="provider" value={slot.provider} />
              <input type="hidden" name="ownerType" value={slot.ownerType} />
              <button type="submit" className={contactStyles.btnGhost}>Use this one instead</button>
            </form>
          ) : null}
          {slot.mayManage && state !== 'connected' ? (
            <ConnectButton provider={slot.provider} ownerType={slot.ownerType} label={a ? 'Reconnect' : 'Connect'} />
          ) : null}
        </div>
      </div>
      <details className={styles.details}>
        <summary className={styles.detailsSummary}>Details</summary>
        <div className={styles.detailsBody}>
          {a ? (
            <dl className={styles.facts}>
              <dt>Account</dt>
              <dd>{a.accountLabel ?? '—'}</dd>
              <dt>Connected</dt>
              <dd><LocalTime iso={a.connectedAt.toISOString()} style="short" /></dd>
              <dt>Last sync</dt>
              <dd>{a.lastSyncedAt ? <LocalTime iso={a.lastSyncedAt.toISOString()} style="short" /> : 'Not yet'}</dd>
              {a.missingScopes.length ? (
                <>
                  <dt>Missing</dt>
                  <dd>{a.missingScopes.join(', ')} — reconnect and leave every box ticked.</dd>
                </>
              ) : null}
              {a.connectorLeft ? (
                <>
                  <dt>Reconnect</dt>
                  <dd>Connected by someone who has left the agency. It still works — reconnect it with an account the agency controls.</dd>
                </>
              ) : null}
              {a.lastError && !a.missingScopes.length ? (
                <>
                  <dt>Problem</dt>
                  <dd>{a.lastError}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <p className={styles.note}>Why we ask for each permission:</p>
          <ul className={styles.scopes}>
            {info.scopes.map((s) => (
              <li key={s.scope} className={styles.scope}>
                {s.why} <code>{s.scope}</code>
              </li>
            ))}
          </ul>
          {slot.mayManage ? (
            a ? (
              <div className={styles.row}>
                <form action={disconnectIntegrationAction}>
                  <input type="hidden" name="provider" value={slot.provider} />
                  <input type="hidden" name="ownerType" value={slot.ownerType} />
                  <ConfirmSubmit
                    className={contactStyles.btnGhost}
                    message={`Disconnect ${info.label}? The stored access is deleted from this platform.`}
                  >
                    Disconnect
                  </ConfirmSubmit>
                </form>
              </div>
            ) : null
          ) : (
            <p className={styles.note}>
              {slot.ownerType === 'agency' ? 'Only an owner or admin connects the agency’s account.' : 'You can view this, not change it.'}
            </p>
          )}
        </div>
      </details>
    </article>
  );
}

/** One of the console's own tools, as a card in the same grid. It opens the tool's page; nothing to connect. */
export function FeatureCard({ href, label, icon, purpose }: { href: string; label: string; icon: string; purpose: string }) {
  return (
    <Link href={href} className={`${styles.card} ${styles.featureCard}`}>
      <div className={styles.cardMain}>
        <ConnectorIcon icon={icon} />
        <div className={styles.cardText}>
          <span className={styles.name}>{label}</span>
          <p className={styles.purpose}>{purpose}</p>
        </div>
        <span className={`${styles.cardSide} ${styles.iconGlyph} ${styles.go}`} aria-hidden>
          arrow_forward
        </span>
      </div>
    </Link>
  );
}

/**
 * "Connect X first" — what a feature shows instead of guessing when a provider
 * it needs is not usable. With a Connect button when this person can fix it;
 * otherwise who can.
 */
export function ConnectFirst({ requirement: r, purpose }: { requirement: IntegrationRequirement; purpose: string }) {
  const info = PROVIDERS[r.provider];
  if (r.state === 'connected') {
    return (
      <div className={styles.gate}>
        <div className={styles.row}>
          <span className={styles.gateTitle}>{info.label}</span>
          <StatusPill state="connected" />
        </div>
        <p className={styles.note}>
          {r.ownerType === 'agency' ? "Using the agency's account" : 'Using your account'}
          {r.accountLabel ? ` (${r.accountLabel})` : ''}. {purpose}
        </p>
      </div>
    );
  }
  const why =
    r.state === 'not_connected'
      ? `Connect ${info.label} first.`
      : r.state === 'permission_missing'
        ? `${info.label} is connected without a permission it needs (${r.missingScopes.join(', ')}). Reconnect and leave every box ticked.`
        : r.state === 'expired'
          ? `${info.label}'s connection has expired. Connect it again.`
          : `${info.label} has a problem. Connect it again.`;
  // A person connects their own; for agency-only providers, an admin does.
  const ownerType = PROVIDERS[r.provider].ownerTypes.includes('user') ? 'user' : 'agency';
  return (
    <div className={styles.gate}>
      <div className={styles.row}>
        <span className={styles.gateTitle}>{info.label}</span>
        <StatusPill state={r.state} />
      </div>
      <p className={styles.note}>{why} {purpose}</p>
      {r.mayConnect ? (
        <ConnectButton provider={r.provider} ownerType={ownerType} label={`Connect ${info.label}`} />
      ) : (
        <p className={styles.note}>Ask an owner or admin to connect it in Settings → Connectors.</p>
      )}
    </div>
  );
}
