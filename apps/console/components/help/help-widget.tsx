'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { parseChatMarkdown, type InlineNode } from '@repo/core/markdown';
import { helpPageName, parseHelpReply, type HelpNavGroup, type HelpSurface } from '@repo/core/help/pages';
import styles from './help-widget.module.css';

/**
 * The floating help window (ADR 0088). It lives in the shell, which stays mounted between pages, so the
 * conversation follows the person around the site. It is kept only here: reloading or closing the tab ends it.
 */

type Line = { role: 'user' | 'assistant'; text: string; links?: readonly string[] };

const MAX_SENT = 11;

/** Text with the guide's links in it. Only what the server said this reply may link to becomes one. */
function Linked({ value, allowed }: { value: string; allowed: ReadonlySet<string> }) {
  return (
    <>
      {parseHelpReply(value, allowed).map((s, i) =>
        s.href ? (
          <Link key={i} href={s.href} className={styles.link}>
            {s.text}
          </Link>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function Inline({ nodes, allowed }: { nodes: InlineNode[]; allowed: ReadonlySet<string> }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.type === 'bold') return <strong key={i}><Linked value={node.value} allowed={allowed} /></strong>;
        if (node.type === 'italic') return <em key={i}><Linked value={node.value} allowed={allowed} /></em>;
        if (node.type === 'code') return <code key={i} className={styles.code}>{node.value}</code>;
        return <Linked key={i} value={node.value} allowed={allowed} />;
      })}
    </>
  );
}

/** The answer's Markdown, as a tree React escapes: model text cannot become markup. */
function Answer({ text, links }: { text: string; links: readonly string[] }) {
  const allowed = new Set(links);
  return (
    <div className={styles.answer}>
      {parseChatMarkdown(text).map((block, i) => {
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={i} className={styles.list}>
              {block.items.map((item, j) => (
                <li key={j}><Inline nodes={item} allowed={allowed} /></li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            {block.type === 'heading' ? <strong><Inline nodes={block.content} allowed={allowed} /></strong> : <Inline nodes={block.content} allowed={allowed} />}
          </p>
        );
      })}
    </div>
  );
}

export function HelpWidget({ surface, groups }: { surface: HelpSurface; groups: readonly HelpNavGroup[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const page = helpPageName(pathname, surface, groups);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines, busy, open]);

  // Closing hands the keyboard back to the button that opened it.
  useEffect(() => {
    if (wasOpen.current && !open) launcher.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const ask = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    const next: Line[] = [...lines, { role: 'user', text }];
    setLines(next);
    setDraft('');
    setBusy(true);
    setProblem(null);
    // A window that starts on the person's message: the oldest answer goes with its question.
    const tab = new URLSearchParams(window.location.search).get('tab');
    let recent = next.slice(-MAX_SENT);
    if (recent[0]?.role === 'assistant') recent = recent.slice(1);
    const res = await fetch('/api/help', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The page and its tab only: the rest of a URL is no business of the help window.
      body: JSON.stringify({ path: tab ? `${pathname}?tab=${encodeURIComponent(tab)}` : pathname, messages: recent.map((l) => ({ role: l.role, text: l.text })) }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { text?: string; links?: string[]; error?: string } | null | undefined;
    setBusy(false);
    if (res?.ok && body?.text) setLines((l) => [...l, { role: 'assistant', text: body.text!, links: body.links ?? [] }]);
    else setProblem(body?.error ?? 'Help is not available right now. Please try again.');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };

  const onInputKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(draft);
    }
  };

  const startOver = () => {
    setLines([]);
    setProblem(null);
  };

  const suggestions = [...(page ? ['What can I do on this page?'] : []), 'Where do I switch on a skill?', 'How do I send a bulk email?', 'How do I connect my email?'];

  if (!open) {
    return (
      <div className={styles.root}>
        <button ref={launcher} type="button" className={styles.launcher} aria-label="Open help" onClick={() => setOpen(true)}>
          <span className={styles.glyph} aria-hidden>
            support_agent
          </span>
          <span className={styles.launcherText}>Help</span>
        </button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <section
        className={styles.window}
        aria-label="Help"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <header className={styles.head}>
          <span className={styles.mark} aria-hidden>
            support_agent
          </span>
          <div className={styles.headText}>
            <h2 className={styles.heading}>Help</h2>
            <p className={styles.sub}>{page ? `You’re on ${page}` : 'How to use LocalAgentHub'}</p>
          </div>
          {lines.length ? (
            <button type="button" className={styles.iconBtn} aria-label="Start over" title="Start over" onClick={startOver}>
              <span className={styles.glyph} aria-hidden>
                restart_alt
              </span>
            </button>
          ) : null}
          <button type="button" className={styles.iconBtn} aria-label="Close help" title="Close" onClick={() => setOpen(false)}>
            <span className={styles.glyph} aria-hidden>
              close
            </span>
          </button>
        </header>

        <div className={styles.body} aria-live="polite">
          {!lines.length ? (
            <div className={styles.welcome}>
              <p className={styles.welcomeTitle}>How can I help?</p>
              <p className={styles.welcomeText}>Ask where something is or how to do it.</p>
              <div className={styles.suggestions}>
                {suggestions.map((s) => (
                  <button key={s} type="button" className={styles.suggestion} onClick={() => void ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {lines.map((l, i) => (l.role === 'user' ? <p key={i} className={styles.you}>{l.text}</p> : <Answer key={i} text={l.text} links={l.links ?? []} />))}
          {busy ? (
            <div className={styles.typing} role="status" aria-label="Writing an answer">
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {problem ? <p className={styles.problem} role="alert">{problem}</p> : null}
          <div ref={end} />
        </div>

        <form className={styles.foot} onSubmit={submit}>
          <div className={styles.composer}>
            <textarea className={styles.input} value={draft} rows={1} maxLength={1000} placeholder="Ask how to do something" aria-label="Your question" autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={onInputKey} />
            <button type="submit" className={styles.send} disabled={busy || !draft.trim()} aria-label="Send">
              <span className={styles.glyph} aria-hidden>
                arrow_upward
              </span>
            </button>
          </div>
          <p className={styles.note}>Nothing here is saved.</p>
        </form>
      </section>
    </div>
  );
}
