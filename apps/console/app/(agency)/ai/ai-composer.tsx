'use client';

import { useState } from 'react';
import styles from './ai.module.css';

const CHIPS = [
  { icon: 'insights', label: 'Show Top 3 Suburb Opportunities' },
  { icon: 'summarize', label: 'Prepare Principal Monday Briefing' },
  { icon: 'account_balance', label: 'Audit Trust Account Discrepancies' },
];

/**
 * The only interactive thing on the AI page: a box you can type in, and three
 * chips that fill it.
 *
 * It used to be one `useState` at the top of a 407-line file, which made the
 * entire page a client component — every automation card, every KPI, the whole
 * mock — shipped to the browser to hold one string. Run is still inert; this
 * screen is a labelled preview and nothing here is wired to a model.
 */
export function AiComposer() {
  const [prompt, setPrompt] = useState('');

  return (
    <div className={styles.composer}>
      <div className={styles.chips}>
        {CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            className={styles.chipBtn}
            onClick={() => setPrompt(c.label)}
          >
            <span className={styles.glyphSm} aria-hidden>
              {c.icon}
            </span>
            {c.label}
          </button>
        ))}
      </div>
      <div className={styles.composeRow}>
        <input
          className={styles.input}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Draft high-converting vendor report for 92 Ocean Ave incorporating Double Bay +6.1%…"
          aria-label="AI command"
        />
        <button type="button" className={styles.btnRun}>
          Run
          <span aria-hidden>↑</span>
        </button>
      </div>
    </div>
  );
}
