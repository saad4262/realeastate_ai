'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { switchedOnHref, type AutomationPaths, type SkillsPanel } from '@repo/core/automation-status/links';
import { SkillSwitch } from '@/components/skills/skill-switch';
import { usePanelDismiss } from './use-panel';
import styles from './automation-status.module.css';

/**
 * The top bar's Skills panel (ADR 0088): the ready-made skills that are on, a switch for each, and the way into
 * its chat. What people set up themselves is the Automations panel beside it. Asked for only when opened.
 */
export function SkillsStatusButton({ paths, className, glyphClassName, textClassName }: { paths: AutomationPaths; className?: string; glyphClassName?: string; textClassName?: string }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<SkillsPanel | null>(null);
  const [failed, setFailed] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePanelDismiss(open, close, wrap);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetch('/api/automations?view=skills', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<SkillsPanel>) : null))
      .catch(() => null)
      .then((body) => {
        if (!live) return;
        setFailed(!body);
        if (body) setPanel(body);
      });
    return () => {
      live = false;
    };
  }, [open]);

  return (
    <div className={styles.wrap} ref={wrap}>
      <button type="button" className={className} aria-label="Skills" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <span className={glyphClassName} aria-hidden>
          auto_awesome
        </span>
        <span className={textClassName}>Skills</span>
      </button>

      {open ? (
        <div className={styles.panel} role="dialog" aria-label="Skills">
          <div className={styles.head}>
            <h2 className={styles.heading}>Skills</h2>
            {panel ? <span className={styles.note}>{panel.skills.length} on</span> : null}
          </div>
          {failed && !panel ? <p className={styles.empty}>This could not be loaded.</p> : null}
          {!failed && !panel ? <p className={styles.empty}>Loading…</p> : null}
          {panel && !panel.skills.length ? <p className={styles.empty}>No skill is switched on yet.</p> : null}

          {panel?.skills.length ? (
            <ul className={styles.list}>
              {panel.skills.map((s) => (
                <li key={s.key} className={styles.rowWrap}>
                  <Link href={switchedOnHref(s, paths)} className={`${styles.row} ${styles.skillRow} ${styles.rowGrow}`} onClick={close}>
                    <span className={styles.skillGlyph} aria-hidden>
                      {s.icon}
                    </span>
                    <span className={styles.rowText}>
                      <span className={styles.title}>{s.name}</span>
                    </span>
                    {s.chat ? <span className={styles.chatTag}>Chat</span> : null}
                  </Link>
                  <span className={styles.control}>
                    <SkillSwitch skillKey={s.key} name={s.name} on disabled={!panel.mayManage} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <Link href={paths.skills} className={styles.seeAll} onClick={close}>
            See all skills
          </Link>
        </div>
      ) : null}
    </div>
  );
}
