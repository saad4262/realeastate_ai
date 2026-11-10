'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LocalTime } from '@repo/ui';
import type { AutomationRow } from '@repo/core/recurring';
import { automationIcon, automationRowHref, filterAutomations, type AutomationFilter } from '@repo/core/recurring/detail-types';
import skills from '@/components/skills/skills.module.css';
import { AutomationSwitch } from './automation-controls';
import styles from './automations-tab.module.css';

/**
 * Skills → Automations as cards, in the Platform skills' look (the user, 2026-11-10): grouped by the skill each came from, with a
 * search and a filter, a switch on each, and the whole card opening it. The rows are the server's; this only narrows and draws them.
 */

const FILTERS: { key: AutomationFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'On' },
  { key: 'off', label: 'Off' },
  { key: 'finished', label: 'Finished' },
];

function Card({ row, home, base }: { row: AutomationRow; home: string; base: string }) {
  const on = row.state === 'active';
  return (
    <article className={`${skills.card} ${styles.cardLink} ${on ? '' : skills.cardOff}`}>
      <div className={skills.cardTop}>
        <span className={skills.icon} aria-hidden>
          {automationIcon(row)}
        </span>
        <Link href={automationRowHref(row, home, base)} className={`${skills.name} ${styles.cover}`}>
          {row.name}
        </Link>
        {row.source !== 'task' ? (
          <span className={styles.above}>
            <AutomationSwitch source={row.source} id={row.id} name={row.name} on={on} disabled={!row.canToggle} className={skills.switch ?? ''} />
          </span>
        ) : null}
      </div>
      <p className={`${skills.cardText} ${styles.clamp}`}>{row.what}</p>
      <div className={skills.tags}>
        <span className={skills.tag}>
          <span className={skills.tagGlyph} aria-hidden>
            {automationIcon(row)}
          </span>
          {row.skill}
        </span>
        <span className={skills.tag}>
          <span className={skills.tagGlyph} aria-hidden>
            {row.source === 'workflow' ? 'bolt' : 'schedule'}
          </span>
          {row.when}
        </span>
        {row.owner ? (
          <span className={skills.tag}>
            <span className={skills.tagGlyph} aria-hidden>
              person
            </span>
            {row.owner}
          </span>
        ) : null}
      </div>
      {row.note ? <p className={styles.note}>{row.note}</p> : null}
      <div className={skills.foot}>
        <span className={on ? skills.state : skills.stateOff}>
          {on ? 'On' : row.state === 'finished' ? 'Finished' : 'Off'}
          {on && row.nextAt ? (
            <>
              {' · next '}
              <LocalTime iso={row.nextAt} style="short" />
            </>
          ) : null}
        </span>
        <span>
          {row.lastAt ? (
            <>
              Last ran <LocalTime iso={row.lastAt} style="short" />
            </>
          ) : (
            'Not run yet'
          )}
        </span>
      </div>
    </article>
  );
}

export function AutomationsBoard({ rows, home, base }: { rows: AutomationRow[]; home: string; base: string }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AutomationFilter>('all');
  const shown = useMemo(() => filterAutomations(rows, query, filter), [rows, query, filter]);
  const count = (f: AutomationFilter) => (f === 'all' ? rows.length : rows.filter((r) => r.state === f).length);
  const groups = [...new Set(shown.map((r) => r.skill))];

  return (
    <>
      <div className={skills.toolbar}>
        <input type="search" className={styles.search} placeholder="Search automations" aria-label="Search automations" value={query} onChange={(e) => setQuery(e.target.value)} />
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={`${skills.filter} ${filter === f.key ? skills.filterOn : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} {count(f.key)}
          </button>
        ))}
        <span className={skills.count}>
          {count('active')} of {rows.length} on
        </span>
      </div>

      {shown.length === 0 ? <p className={skills.groupNote}>Nothing matches{query ? ` “${query}”` : ''}.</p> : null}

      {groups.map((g) => (
        <section key={g} className={skills.group} aria-label={g}>
          <div className={skills.groupHead}>
            <h2 className={skills.groupTitle}>{g}</h2>
          </div>
          <div className={skills.grid}>
            {shown
              .filter((r) => r.skill === g)
              .map((r) => (
                <Card key={r.key} row={r} home={home} base={base} />
              ))}
          </div>
        </section>
      ))}
    </>
  );
}
