import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { listMySkills, listSkillLibrary, SkillError, SKILL_HANDLER_LABELS } from '@repo/core/skills';
import { PROVIDERS } from '@repo/core/integrations';
import { holderOf } from '@repo/core/skill-switches';
import { ensureTemplateEmailSkill } from '@repo/core/template-email';
import type { Actor } from '@repo/core/permissions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { WorkflowsPage } from '@/components/workflows/workflows-page';
import { LIBRARY_GROUPS, type LibraryGroup } from '@repo/core/workflows';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { AddSkillButton, ArchiveLibrarySkillButton } from './islands';
import { PlatformSkills, type SkillFilter } from './platform-skills';
import styles from './skills.module.css';

const STATUS_LABEL = { running: 'Running', succeeded: 'Done', failed: 'Failed', skipped: 'Skipped' } as const;

export const SKILL_TABS = ['platform', 'ai', 'automations'] as const;
export type SkillTab = (typeof SKILL_TABS)[number];
const TAB_LABELS: Record<SkillTab, string> = { platform: 'Platform skills', ai: 'AI skills', automations: 'Automations' };

/** The page's own search params, read loosely: anything unknown is the default. */
export function skillsParams(sp: { tab?: string; show?: string; runs?: string; lib?: string }): { tab: SkillTab; show: SkillFilter; runs?: string; lib?: LibraryGroup } {
  const tab = (SKILL_TABS as readonly string[]).includes(sp.tab ?? '') ? (sp.tab as SkillTab) : 'platform';
  const show = sp.show === 'on' || sp.show === 'off' ? sp.show : 'all';
  const lib = (LIBRARY_GROUPS as readonly string[]).includes(sp.lib ?? '') ? (sp.lib as LibraryGroup) : undefined;
  return { tab, show, ...(sp.runs ? { runs: sp.runs } : {}), ...(lib ? { lib } : {}) };
}

/**
 * Skills — the Control Centre (ADR 0058), shared by the agency's `/skills` and the agent's `/my-skills`.
 * Three tabs in the URL: Platform skills (every built capability with its switch), AI skills (the
 * scheduled jobs of ADR 0021) and Automations (the workflows of ADR 0041). What each person sees and
 * may change is can()'s, in packages/core.
 */
export async function SkillsPage({ surface, tab = 'platform', show = 'all', runs, lib }: { surface: 'agency' | 'agent'; tab?: SkillTab; show?: SkillFilter; runs?: string; lib?: LibraryGroup }) {
  const session = await requireConsoleAccess(surface);
  const basePath = surface === 'agency' ? '/skills' : '/my-skills';
  const forAgency = holderOf(session.actor.membershipRole) === 'agency';
  const tabHref = (t: SkillTab) => (t === 'platform' ? basePath : `${basePath}?tab=${t}`);

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>Skills</h1>
          <p className={contactStyles.sub}>
            {forAgency
              ? 'Everything the platform and the assistant can do for the agency. A skill that is off is off everywhere: on its page, in automations and in the assistant.'
              : 'What the platform and the assistant do for you. Turn on what helps, turn off what doesn’t. It changes only your own work.'}
          </p>
          <span className={styles.whoChip}>
            <span className={styles.tagGlyph} aria-hidden>
              {forAgency ? 'apartment' : 'person'}
            </span>
            {forAgency ? 'Switches here are for the whole agency' : 'Your own switches'}
          </span>
        </div>
        <Link href={surface === 'agency' ? '/overview' : '/assistant'} className={contactStyles.btnGhost}>
          Ask the assistant
        </Link>
      </div>

      <nav className={contactStyles.tabs} aria-label="Skills sections">
        {SKILL_TABS.map((t) => (
          <Link key={t} href={tabHref(t)} className={`${contactStyles.tab} ${tab === t ? contactStyles.tabOn : ''}`} aria-current={tab === t ? 'page' : undefined}>
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      {tab === 'platform' ? <PlatformSkills actor={session.actor} basePath={basePath} filter={show} /> : null}
      {tab === 'ai' ? <AiSkills actor={session.actor} surface={surface} basePath={basePath} /> : null}
      {tab === 'automations' ? <WorkflowsPage surface={surface} {...(runs ? { runsOf: runs } : {})} {...(lib ? { lib } : {})} /> : null}
    </div>
  );
}

/** AI skills (ADR 0021): the person's own scheduled jobs, then the library. */
async function AiSkills({ actor, surface, basePath }: { actor: Actor; surface: 'agency' | 'agent'; basePath: string }) {
  const db = getConsoleDb();
  let data: [Awaited<ReturnType<typeof listMySkills>>, Awaited<ReturnType<typeof listSkillLibrary>>] | null = null;
  let loadError: string | null = null;
  try {
    // The template-email library entry cannot be seeded by its migration (a new enum value); see ensureTemplateEmailSkill.
    await ensureTemplateEmailSkill(db);
    data = await Promise.all([listMySkills(db, actor), listSkillLibrary(db, actor)]);
  } catch (err) {
    loadError = err instanceof SkillError ? err.message : 'Failed to load skills';
  }
  if (!data) return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{loadError}</p>;
  const [mine, library] = data;

  return (
    <>
      <div className={contactStyles.head}>
        <p className={contactStyles.sub}>
          Ready-made AI jobs that read only what you can see and never send or change anything on their own.
          Add one, adjust its instructions, put it on a schedule.
        </p>
        {library.mayCurate ? (
          <Link href={`${basePath}/library/new`} className={contactStyles.btnGhost}>+ New library skill</Link>
        ) : null}
      </div>

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Your skills</h2>
          {mine.length === 0 ? (
            <p className={contactStyles.note}>None yet — add one from the library below.</p>
          ) : (
            <ul className={contactStyles.plainList}>
              {mine.map((s) => (
                <li key={s.id} className={contactStyles.plainItem}>
                  <span style={{ display: 'grid', gap: '0.15rem' }}>
                    <Link href={`${basePath}/${s.id}`} className={contactStyles.name}>{s.name}</Link>
                    <span className={contactStyles.muted}>
                      {s.enabled ? 'On' : 'Off'}
                      {s.enabled && s.nextRunAt ? <> · next <LocalTime iso={s.nextRunAt.toISOString()} style="short" /></> : null}
                      {s.lastRun ? <> · last {STATUS_LABEL[s.lastRun.status].toLowerCase()} <LocalTime iso={s.lastRun.at.toISOString()} style="short" /></> : null}
                      {s.consecutiveFailures >= 3 ? ' · paused after 3 failures' : null}
                    </span>
                  </span>
                  <Link href={`${basePath}/${s.id}`} className={contactStyles.btnGhost}>Open</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Library</h2>
          <ul className={contactStyles.plainList}>
            {library.skills.map((s) => (
              <li key={s.id} className={contactStyles.plainItem}>
                <span style={{ display: 'grid', gap: '0.2rem', maxWidth: '44rem' }}>
                  <span className={contactStyles.name}>
                    {s.name}
                    <span className={contactStyles.chipInferred} style={{ marginLeft: '0.4rem' }}>{s.scope === 'agency' ? 'Agency' : 'Built-in'}</span>
                  </span>
                  <span className={contactStyles.muted}>{s.description}</span>
                  <span className={contactStyles.hint}>
                    Does: {SKILL_HANDLER_LABELS[s.handler]} · Needs: {s.requires.length ? s.requires.map((p) => PROVIDERS[p].label).join(', ') : 'nothing to connect'}
                  </span>
                </span>
                <span className={contactStyles.inlineForm}>
                  {s.handler === 'template_email' ? (
                    <Link href={surface === 'agency' ? '/bulk-email' : '/my-bulk-email'} className={contactStyles.btnGhost}>
                      Open bulk email
                    </Link>
                  ) : s.myCopyId ? (
                    <Link href={`${basePath}/${s.myCopyId}`} className={contactStyles.btnGhost}>In your skills</Link>
                  ) : library.mayAdd ? (
                    <AddSkillButton skillId={s.id} basePath={basePath} />
                  ) : null}
                  {s.scope === 'agency' && library.mayCurate ? <ArchiveLibrarySkillButton skillId={s.id} /> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
