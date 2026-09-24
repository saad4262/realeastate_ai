'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { InviteAgentDraft } from '@repo/core/team/schema';
import { useToast } from '@/components/toast';
import { copyText } from '@/lib/copy-text';
import { inviteAgentAction, type InviteAgentActionResult } from '../../actions';
import { WizardChrome } from '../wizard-chrome';
import { useOnboarding } from '../onboarding-state';
import { useStepValidation } from '../use-step-validation';
import { STEP_HREFS, stepForField } from '../validation';
import styles from './dispatch.module.css';

type DispatchError = Extract<InviteAgentActionResult, { ok: false }>;
type DispatchOk = Extract<InviteAgentActionResult, { ok: true }>;

/** Errors the user fixes by editing the draft, not by retrying. */
const FIXABLE: DispatchError['code'][] = [
  'invalid_draft',
  'self_invite',
  'already_member',
  'invite_pending',
];

/** Inlined at build time, so it is safe to read in a client component. */
const AGENT_ORIGIN =
  process.env.NEXT_PUBLIC_AGENT_URL?.replace(/\/$/, '') ?? 'http://agents.lvh.me:3001';

function countdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function OnboardingDispatchPage() {
  const { draft, reset } = useOnboarding();
  const { guardNext } = useStepValidation(5);
  const { toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DispatchError | null>(null);
  const [sent, setSent] = useState<DispatchOk | null>(null);
  /** Kept in memory after reset() so a lapsed link can be re-sent in one click. */
  const [sentDraft, setSentDraft] = useState<InviteAgentDraft | null>(null);
  const [msLeft, setMsLeft] = useState(0);
  const [copied, setCopied] = useState(false);

  const name = draft.displayName || `${draft.firstName} ${draft.lastName}`.trim();
  const displayName = sentDraft
    ? sentDraft.displayName || `${sentDraft.firstName} ${sentDraft.lastName}`.trim()
    : name;
  const displayEmail = sentDraft?.email ?? draft.email;
  // The agent's home is the agent host, not the agency host this wizard runs
  // on. Building the link off window.location sent them to agency.* first and
  // relied on a redirect to bounce them back.
  const inviteUrl = sent ? `${AGENT_ORIGIN}${sent.claimPath}` : null;
  const expired = Boolean(sent) && msLeft <= 0;

  // The link is short-lived, so the card counts down rather than printing a
  // timestamp the user has to compare against the clock.
  useEffect(() => {
    if (!sent) return;
    const deadline = new Date(sent.expiresAt).getTime();
    const tick = () => setMsLeft(deadline - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sent]);

  function goToField(field: keyof InviteAgentDraft) {
    router.push(STEP_HREFS[stepForField(field)]);
  }

  async function dispatchInvite(payload: InviteAgentDraft, resend: boolean) {
    setBusy(true);
    setError(null);
    const result = await inviteAgentAction(payload);
    setBusy(false);

    if (!result.ok) {
      setError(result);
      toast({
        variant: FIXABLE.includes(result.code) ? 'warning' : 'error',
        title: resend ? 'New link not sent' : 'Invite not sent',
        description: result.error,
        action: result.field
          ? {
              label: 'Fix it',
              onClick: () => goToField(result.field as keyof InviteAgentDraft),
            }
          : undefined,
      });
      return;
    }

    setSent(result);
    setSentDraft(payload);
    const who = payload.displayName || payload.email;
    toast({
      variant: 'success',
      title: resend ? 'New link sent' : 'Invitation stored',
      description: `${who} can claim their account with the link below.`,
    });
    if (!resend) reset();
  }

  async function broadcast() {
    // Same contract the server enforces — caught here so a bad draft never
    // needs a round trip to come back as an error.
    if (!guardNext()) return;
    await dispatchInvite(draft, false);
  }

  async function copyLink() {
    if (!inviteUrl) return;
    const ok = await copyText(inviteUrl);

    if (!ok) {
      // The link is already on screen above, so say so rather than pretending.
      toast({
        variant: 'error',
        title: 'Could not reach the clipboard',
        description: 'Select the link above and copy it by hand.',
      });
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
    toast({ variant: 'info', title: 'Claim link copied', duration: 2500 });
  }

  return (
    <WizardChrome
      step={5}
      title="Confirm Onboarding & Send Invitation"
      badge="Pre-Activation State"
      subtitle={`Review dossier for ${displayName || 'agent'}, then write invite + profile rows to the database.`}
      backHref="/team/onboarding/review"
      backLabel="Back to Executive Review"
      hideFooterActions
      footerNote="Invite persists as agent_invite; membership/agent_profile when provisioned or claimed"
    >
      <div className={styles.layout}>
        <div className={styles.stack}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Will be stored</h2>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
              <li>
                <strong>agent_invite</strong> — email, token, full wizard draft (JSONB)
              </li>
              <li>
                <strong>user + membership + agent_profile</strong> — created when the agent opens
                the invite link and sets their password
              </li>
              <li>
                Territory: {(sentDraft ?? draft).territorySuburbs.join(', ') || '—'} · Licence #
                {(sentDraft ?? draft).licenceNumber}
              </li>
            </ul>
          </section>

          {sent ? (
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle}>
                  {expired ? 'Invite link expired' : 'Invite created'}
                </h2>
                <span className={expired ? styles.pillAmber : styles.pillGreen}>
                  {expired ? 'Expired' : `Expires in ${countdown(msLeft)}`}
                </span>
              </div>

              {expired ? (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                    This link no longer works. Send {displayEmail} a fresh one — the dossier is
                    unchanged.
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button
                      type="button"
                      className={styles.broadcast}
                      disabled={busy || !sentDraft}
                      onClick={() => sentDraft && void dispatchInvite(sentDraft, true)}
                    >
                      <span className={styles.glyphSm} aria-hidden>
                        refresh
                      </span>
                      {busy ? 'Sending…' : 'Send a new link'}
                    </button>
                    <button
                      type="button"
                      className={styles.ghost}
                      onClick={() => router.push('/team')}
                    >
                      Back to team directory
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
                    Share this claim link with {displayEmail}:
                  </p>
                  <code
                    style={{
                      display: 'block',
                      marginTop: 10,
                      padding: 12,
                      borderRadius: 8,
                      background: 'var(--surface-canvas)',
                      fontSize: 12,
                      wordBreak: 'break-all',
                    }}
                  >
                    {inviteUrl}
                  </code>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button type="button" className={styles.ghost} onClick={() => void copyLink()}>
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                    <button
                      type="button"
                      className={styles.broadcast}
                      onClick={() => router.push('/team')}
                    >
                      Back to team directory
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : null}
        </div>

        <aside className={styles.aside}>
          <div className={styles.card}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{displayName || 'New agent'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              {displayEmail}
            </div>

            {error ? (
              <div
                className={`${styles.alert} ${
                  FIXABLE.includes(error.code) ? styles.alertWarning : styles.alertError
                }`}
                role="alert"
              >
                <span className={styles.glyphSm} aria-hidden>
                  {FIXABLE.includes(error.code) ? 'warning' : 'error'}
                </span>
                <div className={styles.alertBody}>
                  <p className={styles.alertText}>{error.error}</p>
                  {error.field ? (
                    <button
                      type="button"
                      className={styles.alertAction}
                      onClick={() => goToField(error.field as keyof InviteAgentDraft)}
                    >
                      Edit {String(error.field) === 'email' ? 'the email' : 'this field'}
                      <span className={styles.glyphSm} aria-hidden>
                        arrow_forward
                      </span>
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className={styles.actions} style={{ marginTop: 16 }}>
              {!sent ? (
                <button
                  type="button"
                  className={styles.broadcast}
                  disabled={busy}
                  onClick={() => void broadcast()}
                >
                  <span className={styles.glyphSm} aria-hidden>
                    send
                  </span>
                  {busy ? 'Saving…' : 'Confirm & store invitation'}
                </button>
              ) : null}
              <Link href="/team" className={styles.ghost}>
                Cancel to team
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </WizardChrome>
  );
}
