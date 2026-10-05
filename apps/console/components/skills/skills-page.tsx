import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { listMySkills, listSkillLibrary, SkillError, SKILL_HANDLER_LABELS } from '@repo/core/skills';
import { PROVIDERS } from '@repo/core/integrations';
import { ensureTemplateEmailSkill } from '@repo/core/template-email';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { AddSkillButton, ArchiveLibrarySkillButton } from './islands';

const STATUS_LABEL = { running: 'Running', succeeded: 'Done', failed: 'Failed', skipped: 'Skipped' } as const;

/**
 * Skills (docs/adr/0021): the agent's own skills, then the library. Shared by
 * the agency's `/skills` and the agent's `/my-skills`; what each person sees
 * and may do is can()'s, in packages/core.
 */
export async function SkillsPage({ surface }: { surface: 'agency' | 'agent' }) {
  const session = await requireConsoleAccess(surface);
  const basePath = surface === 'agency' ? '/skills' : '/my-skills';
  const db = getConsoleDb();
  let data: [Awaited<ReturnType<typeof listMySkills>>, Awaited<ReturnType<typeof listSkillLibrary>>] | null = null;
  let loadError: string | null = null;
  try {
    // The template-email library entry cannot be seeded by its migration (a new enum value); see ensureTemplateEmailSkill.
    await ensureTemplateEmailSkill(db);
    data = await Promise.all([listMySkills(db, session.actor), listSkillLibrary(db, session.actor)]);
  } catch (err) {
    loadError = err instanceof SkillError ? err.message : 'Failed to load skills';
  }
  if (!data) return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{loadError}</p>;
  const [mine, library] = data;

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{surface === 'agency' ? 'Skills' : 'My skills'}</h1>
          <p className={contactStyles.sub}>
            Ready-made AI jobs that read only what you can see and never send or change anything on their own.
            Add one, adjust its instructions, put it on a schedule.
          </p>
        </div>
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
    </div>
  );
}
