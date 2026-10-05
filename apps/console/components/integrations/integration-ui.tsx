import {
  PROVIDERS,
  STATUS_LABELS,
  type IntegrationRequirement,
  type IntegrationSlot,
  type IntegrationState,
} from '@repo/core/integrations';
import { LocalTime } from '@repo/ui';
import contactStyles from '@/components/contacts/contacts.module.css';
import { connectIntegrationAction, disconnectIntegrationAction } from '@/lib/integration-actions';
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

export function IntegrationCard({ slot }: { slot: IntegrationSlot }) {
  const info = PROVIDERS[slot.provider];
  const a = slot.account;
  const state: IntegrationState = a ? a.state : 'not_connected';
  return (
    <article className={styles.card}>
      <div className={styles.cardHead}>
        <span>
          <span className={styles.name}>{info.label}</span>
          <br />
          <span className={styles.level}>{slot.ownerType === 'agency' ? "The agency's account" : 'Your own account'}</span>
        </span>
        <StatusPill state={state} />
      </div>
      <p className={styles.purpose}>{info.purpose}</p>
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
          {a.lastError && !a.missingScopes.length ? (
            <>
              <dt>Problem</dt>
              <dd>{a.lastError}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <details>
        <summary className={styles.note}>Why we ask for each permission</summary>
        <ul className={styles.scopes}>
          {info.scopes.map((s) => (
            <li key={s.scope} className={styles.scope}>
              {s.why} <code>{s.scope}</code>
            </li>
          ))}
        </ul>
      </details>
      {slot.mayManage ? (
        <div className={styles.row}>
          {state !== 'connected' ? (
            <ConnectButton provider={slot.provider} ownerType={slot.ownerType} label={a ? 'Reconnect' : 'Connect'} />
          ) : null}
          {a ? (
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
          ) : null}
        </div>
      ) : (
        <p className={styles.note}>
          {slot.ownerType === 'agency' ? 'Only an owner or admin connects the agency’s account.' : 'You can view this, not change it.'}
        </p>
      )}
    </article>
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
        <p className={styles.note}>Ask an owner or admin to connect it in Settings → Integrations.</p>
      )}
    </div>
  );
}
