'use client';

import { useEffect, useState, useTransition } from 'react';
import type { AgencyInviteRow } from '@repo/core/team';
import { useToast } from '@/components/toast';
import { copyText } from '@/lib/copy-text';
import { resendInviteAction } from './actions';
import styles from './team.module.css';

/** Inlined at build time, so it is safe to read in a client component. */
const AGENT_ORIGIN =
  process.env.NEXT_PUBLIC_AGENT_URL?.replace(/\/$/, '') ?? 'http://agents.lvh.me:3001';

type Row = Omit<AgencyInviteRow, 'expiresAt'> & { expiresAt: string };

function countdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Outstanding invites, with the link kept reachable after the wizard closes.
 *
 * Until now the claim link existed only on the dispatch screen, so leaving
 * that page lost it and a lapsed link meant redoing the whole wizard.
 */
export function PendingInvites({ invites }: { invites: Row[] }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>(invites);
  const [isPending, startTransition] = useTransition();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Rows whose link the browser refused to copy — shown so it can be selected. */
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setRows(invites), [invites]);

  // One timer for the whole list rather than one per row.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!rows.length) return null;

  function urlFor(row: Row) {
    return `${AGENT_ORIGIN}${row.claimPath}`;
  }

  async function copy(row: Row) {
    const ok = await copyText(urlFor(row));

    if (!ok) {
      // Never claim success here — the link is the only way in for that agent.
      setRevealedId(row.id);
      toast({
        variant: 'error',
        title: 'Could not reach the clipboard',
        description: 'The link is shown below — select it and copy it by hand.',
      });
      return;
    }

    setRevealedId(null);
    setCopiedId(row.id);
    window.setTimeout(() => setCopiedId((c) => (c === row.id ? null : c)), 1600);
    toast({ variant: 'info', title: 'Claim link copied', duration: 2500 });
  }

  /**
   * A resend replaces the token, so the new link is genuinely client state
   * until the next server read — it is kept in `rows` rather than guessed
   * optimistically, because inventing a token would put a dead link on screen.
   * Only the pending state is optimistic.
   */
  function resend(row: Row) {
    startTransition(async () => {
      const result = await resendInviteAction(row.id);

      if (!result.ok) {
        toast({ variant: 'error', title: 'New link not created', description: result.error });
        return;
      }

      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? { ...r, claimPath: result.claimPath, expiresAt: result.expiresAt, state: 'live' }
            : r,
        ),
      );
      setRevealedId(null);
      toast(
        result.emailed
          ? {
              variant: 'success',
              title: 'New link emailed',
              description: `We emailed it to ${row.email}. The old link no longer works.`,
            }
          : {
              variant: 'warning',
              title: 'New link ready — not emailed',
              description: `The email did not go. Share the link with ${row.email} yourself — the old one no longer works.`,
            },
      );
    });
  }

  return (
    <div className={styles.card} style={{ padding: '14px 16px', marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>
        Pending invites ({rows.length})
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {rows.map((row) => {
          const msLeft = new Date(row.expiresAt).getTime() - now;
          const expired = row.state !== 'live' || msLeft <= 0;

          return (
            <div
              key={row.id}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'var(--surface-canvas)',
              }}
            >
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{row.name}</div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {row.email}
                </div>
              </div>

              <span className={expired ? styles.badgeAmber : styles.badgeGreen}>
                {expired ? 'Link expired' : `Expires in ${countdown(msLeft)}`}
              </span>

              {expired ? (
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={isPending}
                  onClick={() => resend(row)}
                >
                  <span className={styles.glyphSm} aria-hidden>
                    refresh
                  </span>
                  {isPending ? 'Creating…' : 'New link'}
                </button>
              ) : (
                <button type="button" className={styles.btn} onClick={() => void copy(row)}>
                  <span className={styles.glyphSm} aria-hidden>
                    content_copy
                  </span>
                  {copiedId === row.id ? 'Copied' : 'Copy link'}
                </button>
              )}

              {revealedId === row.id ? (
                <input
                  readOnly
                  value={urlFor(row)}
                  onFocus={(e) => e.currentTarget.select()}
                  autoFocus
                  style={{
                    flex: '1 1 100%',
                    marginTop: 4,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--border-default)',
                    background: 'var(--surface-elevated)',
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 12,
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
