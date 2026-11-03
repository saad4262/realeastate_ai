import type { Metadata } from 'next';
import Link from 'next/link';
import { CONSUMER_SKILL_GROUPS, listConsumerSkills, type ConsumerSkillView } from '@repo/core/consumer-skills';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { SkillSwitch } from './skill-switch';
import styles from '../account.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your AI skills',
  robots: { index: false, follow: false },
};

/**
 * The buyer's AI skills (ADR 0080): every skill the platform has for them, each with its switch, and the
 * ones still being built under "Coming soon". One read — the buyer's stored switches; the list itself is
 * the catalog in code.
 */
export default async function SkillsPage() {
  await requireWebUser('/account/skills');
  const session = await ensureConsumerAccount();
  if (!session) return null;

  const skills = await listConsumerSkills(getWebDb(), { userId: session.id });
  const built = skills.filter((s) => s.status !== 'planned');
  const planned = skills.filter((s) => s.status === 'planned');

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <p className="mb-2 text-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>
        <h1 className={styles.title}>Your AI skills</h1>
        <p className={`${styles.body} mt-2`}>
          Choose what the property guide may do for you. Skills that only answer your questions start on;
          skills that act for you or contact someone start off until you turn them on.
        </p>

        {CONSUMER_SKILL_GROUPS.map((group) => {
          const inGroup = built.filter((s) => s.group === group);
          if (!inGroup.length) return null;
          return (
            <section key={group} className={styles.card}>
              <h2 className={styles.cardLabel}>{group}</h2>
              <ul className="m-0 list-none p-0">
                {inGroup.map((s) => (
                  <SkillRow key={s.key} skill={s} />
                ))}
              </ul>
            </section>
          );
        })}

        {planned.length ? (
          <section className={styles.card}>
            <h2 className={styles.cardLabel}>Coming soon</h2>
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              {planned.map((s) => (
                <li key={s.key}>
                  <p className="text-sm font-semibold text-ink">{s.name}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-ink-soft">{s.description}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </WebShell>
  );
}

function SkillRow({ skill }: { skill: ConsumerSkillView }) {
  return (
    <li className="flex items-start justify-between gap-4 border-t border-line-subtle py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className="text-base font-semibold leading-snug text-ink">
          {skill.name}
          {skill.status === 'partial' ? <span className="ml-2 align-middle text-xs font-normal text-ink-soft">More coming</span> : null}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">{skill.description}</p>
        {skill.block === 'paused' ? <p className="mt-1 text-xs text-ink-soft">Paused for everyone at the moment.</p> : null}
      </div>
      {/* The buyer's own choice, still theirs to change while the platform has it paused; the note says why it is not running. */}
      <SkillSwitch skillKey={skill.key} name={skill.name} on={skill.chosen} />
    </li>
  );
}

