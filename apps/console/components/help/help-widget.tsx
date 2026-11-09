'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import styles from './help-widget.module.css';

/**
 * The floating help window (ADR 0088). It lives in the shell, which stays mounted between pages, so the
 * conversation follows the person around the site. It is kept only here: reloading or closing the tab ends it.
 */

type Segment = { text: string; href?: string };
type Line = { role: 'user' | 'assistant'; text: string; segments?: Segment[] };

const MAX_SENT = 11;

export function HelpWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines, busy, open]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const next: Line[] = [...lines, { role: 'user', text }];
    setLines(next);
    setDraft('');
    setBusy(true);
    setProblem(null);
    // A window that starts on the person's message: the oldest answer goes with its question.
    let recent = next.slice(-MAX_SENT);
    if (recent[0]?.role === 'assistant') recent = recent.slice(1);
    const res = await fetch('/api/help', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: pathname, messages: recent.map((l) => ({ role: l.role, text: l.text })) }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { text?: string; segments?: Segment[]; error?: string } | null | undefined;
    setBusy(false);
    if (res?.ok && body?.text) {
      setLines((l) => [...l, { role: 'assistant', text: body.text!, ...(body.segments ? { segments: body.segments } : {}) }]);
    } else {
      setProblem(body?.error ?? 'Help is not available right now. Please try again.');
    }
  };

  return (
    <div className={styles.root}>
      {open ? (
        <section className={styles.window} aria-label="Help">
          <header className={styles.head}>
            <div>
              <h2 className={styles.heading}>Help</h2>
              <p className={styles.sub}>How to use the site. Not saved.</p>
            </div>
            <button type="button" className={styles.close} aria-label="Close help" onClick={() => setOpen(false)}>
              <span className={styles.glyph} aria-hidden>
                close
              </span>
            </button>
          </header>

          <div className={styles.body} aria-live="polite">
            {!lines.length ? <p className={styles.hint}>Ask where something is or how to do it. I can see which page you are on.</p> : null}
            {lines.map((l, i) => (
              <p key={i} className={styles.line} data-role={l.role}>
                {l.segments
                  ? l.segments.map((s, j) =>
                      s.href ? (
                        <Link key={j} href={s.href} className={styles.link}>
                          {s.text}
                        </Link>
                      ) : (
                        <span key={j}>{s.text}</span>
                      ),
                    )
                  : l.text}
              </p>
            ))}
            {busy ? <p className={styles.line} data-role="assistant">…</p> : null}
            {problem ? <p className={styles.problem} role="alert">{problem}</p> : null}
            <div ref={end} />
          </div>

          <form className={styles.form} onSubmit={send}>
            <input className={styles.input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask how to do something" aria-label="Your question" maxLength={1000} autoFocus />
            <button type="submit" className={styles.send} disabled={busy || !draft.trim()} aria-label="Send">
              <span className={styles.glyph} aria-hidden>
                arrow_upward
              </span>
            </button>
          </form>
        </section>
      ) : null}

      <button type="button" className={styles.fab} aria-label={open ? 'Close help' : 'Open help'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={styles.glyph} aria-hidden>
          {open ? 'close' : 'help'}
        </span>
      </button>
    </div>
  );
}
