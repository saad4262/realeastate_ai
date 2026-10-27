import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { can, type Actor } from '@repo/core/permissions';
import { listSkillSwitches, SKILL_GROUP_NOTES, SKILL_GROUPS, type SkillSwitchView } from '@repo/core/skill-switches';
import { getConsoleDb } from '../../lib/db';
import { SkillSwitch } from './skill-switch';
import styles from './skills.module.css';

export type SkillFilter = 'all' | 'on' | 'off';

/**
 * Platform skills (ADR 0058): every built capability as a card with its switch, in the catalog's
 * groups. An owner or admin sees and flips the agency's switches; anyone else their own, and never
 * the skills that read the whole agency. Everything shown is from core; the switch asks can() again.
 */
export async function PlatformSkills({ actor, basePath, filter }: { actor: Actor; basePath: string; filter: SkillFilter }) {
  const { holder, skills } = await listSkillSwitches(getConsoleDb(), actor);
  const resource = { type: 'skill_switch', agencyId: actor.agencyId as string, ...(holder === 'personal' ? { ownerId: actor.userId } : {}) };
  const mayManage = can(actor, 'skill_switch:manage', resource);
  const onCount = skills.filter((s) => s.on).length;
  const shown = skills.filter((s) => filter === 'all' || (filter === 'on') === s.on);
  const href = (f: SkillFilter) => (f === 'all' ? basePath : `${basePath}?show=${f}`);

  return (
    <>
      <div className={styles.toolbar}>
        {(['all', 'on', 'off'] as const).map((f) => (
          <Link key={f} href={href(f)} className={`${styles.filter} ${filter === f ? styles.filterOn : ''}`} aria-current={filter === f ? 'page' : undefined}>
            {f === 'all' ? 'All' : f === 'on' ? 'On' : 'Off'}
          </Link>
        ))}
        <span className={styles.count}>
          {onCount} of {skills.length} on
        </span>
      </div>

      {shown.length === 0 ? <p className={styles.groupNote}>No skill is {filter} right now.</p> : null}

      {SKILL_GROUPS.map((group) => {
        const inGroup = shown.filter((s) => s.group === group);
        if (!inGroup.length) return null;
        return (
          <section key={group} className={styles.group} aria-labelledby={`skills-${group}`}>
            <div className={styles.groupHead}>
              <h2 id={`skills-${group}`} className={styles.groupTitle}>{group}</h2>
              {SKILL_GROUP_NOTES[group] ? <span className={styles.groupNote}>{SKILL_GROUP_NOTES[group]}</span> : null}
            </div>
            <div className={styles.grid}>
              {inGroup.map((s) => (
                <SkillCard key={s.key} skill={s} holder={holder} mayManage={mayManage} />
              ))}
            </div>
          </section>
        );
      })}

      <p className={styles.note}>
        <span className={styles.noteGlyph} aria-hidden>
          {holder === 'agency' ? 'info' : 'shield_person'}
        </span>
        <span>
          {holder === 'agency'
            ? 'Agents have their own switches for the skills they can use, and theirs and the agency’s never change each other. Agents never see skills marked Agency only. Every skill works only within what that person may see.'
            : 'Every skill here works on your own work only: your leads, contacts and emails. Your switches change nothing for anyone else.'}
          {mayManage ? ' You can also ask the assistant: “turn off cold contact alerts”.' : ' You may look but not change these.'}
        </span>
      </p>
    </>
  );
}

function SkillCard({ skill: s, holder, mayManage }: { skill: SkillSwitchView; holder: 'agency' | 'personal'; mayManage: boolean }) {
  return (
    <article className={`${styles.card} ${s.on ? '' : styles.cardOff}`}>
      <div className={styles.cardTop}>
        <span className={styles.icon} aria-hidden>
          {s.icon}
        </span>
        <span className={styles.name}>{s.name}</span>
        <SkillSwitch skillKey={s.key} name={s.name} on={s.on} disabled={!mayManage} />
      </div>
      <p className={styles.cardText}>{s.description}</p>
      <div className={styles.tags}>
        {s.level === 'auto' ? (
          <span className={`${styles.tag} ${styles.tagAuto}`}>
            <span className={styles.tagGlyph} aria-hidden>bolt</span>Runs by itself
          </span>
        ) : (
          <span className={`${styles.tag} ${styles.tagApproval}`}>
            <span className={styles.tagGlyph} aria-hidden>how_to_reg</span>Needs your approval
          </span>
        )}
        {s.scope === 'agency' ? (
          <span className={`${styles.tag} ${styles.tagAgency}`}>
            <span className={styles.tagGlyph} aria-hidden>apartment</span>Agency only
          </span>
        ) : null}
        {s.needs ? (
          <span className={styles.tag}>
            <span className={styles.tagGlyph} aria-hidden>hub</span>Needs {s.needs}
          </span>
        ) : null}
      </div>
      <div className={styles.foot}>
        <span className={s.on ? styles.state : styles.stateOff}>{s.on ? 'On' : 'Off: the assistant and automations won’t use it'}</span>
        <span>
          {s.changedAt ? (
            <>
              {holder === 'agency' && s.changedBy ? `${s.changedBy} · ` : ''}
              <LocalTime iso={s.changedAt.toISOString()} style="short" />
            </>
          ) : (
            'On by default'
          )}
        </span>
      </div>
    </article>
  );
}
