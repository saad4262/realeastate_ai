'use client';

import { useEffect, useState } from 'react';
import type { AutomationPaths } from '@repo/core/automation-status/links';
import { AutomationDetailPanel } from './automation-detail';
import styles from './automation-detail.module.css';

type Made = { key: string; name: string; state: string };

/**
 * The automations made in this chat, beside it (the user, 2026-11-10). Nothing shows until the chat has made one. On a wide screen
 * it sits on the right; on a narrow one a button opens it. `version` changes after each answer, so a card just approved shows up.
 */
export function ChatAutomations({ conversationId, paths, version, initial }: { conversationId: string; paths: AutomationPaths; version: number; initial: string | null }) {
  const [made, setMade] = useState<Made[]>([]);
  const [picked, setPicked] = useState<string | null>(initial);
  const [open, setOpen] = useState(Boolean(initial));

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/automations?chat=${encodeURIComponent(conversationId)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<Made[]>) : []))
        .catch(() => [] as Made[])
        .then((list) => {
          if (live) setMade(list);
        });
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [conversationId, version]);

  if (!made.length) return null;
  const current = made.find((m) => m.key === picked)?.key ?? made[0]!.key;

  return (
    <>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={styles.glyph} aria-hidden>
          bolt
        </span>
        Automation{made.length > 1 ? `s (${made.length})` : ''}
      </button>
      <aside className={styles.side} data-open={open || undefined} aria-label="This chat’s automations">
        <div className={styles.sideHead}>
          {made.length > 1 ? (
            <div className={styles.tabs} role="tablist">
              {made.map((m) => (
                <button key={m.key} type="button" role="tab" aria-selected={m.key === current} className={styles.tab} onClick={() => setPicked(m.key)}>
                  {m.name}
                </button>
              ))}
            </div>
          ) : (
            <span className={styles.sideTitle}>This chat’s automation</span>
          )}
          <button type="button" className={styles.close} aria-label="Close" onClick={() => setOpen(false)}>
            <span className={styles.glyph} aria-hidden>
              close
            </span>
          </button>
        </div>
        <AutomationDetailPanel key={current} automationKey={current} paths={paths} inChat />
      </aside>
    </>
  );
}

/** The same panel, as a drawer on Skills → Automations, for an automation whose chat this person cannot open. */
export function AutomationDrawer({ automationKey, paths, closeHref }: { automationKey: string; paths: AutomationPaths; closeHref: string }) {
  return (
    <aside className={`${styles.side} ${styles.drawer}`} data-open aria-label="Automation">
      <div className={styles.sideHead}>
        <span className={styles.sideTitle}>Automation</span>
        <a href={closeHref} className={styles.close} aria-label="Close">
          <span className={styles.glyph} aria-hidden>
            close
          </span>
        </a>
      </div>
      <AutomationDetailPanel automationKey={automationKey} paths={paths} />
    </aside>
  );
}
