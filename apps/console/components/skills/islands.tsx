'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  librarySkillSchema,
  parseSkillMarkdown,
  SKILL_HANDLER_LABELS,
  SKILL_HANDLERS,
  skillScheduleSchema,
  type SkillHandler,
} from '@repo/core/skills/schema';
import { browserTimeZone } from '@repo/core/time';
import { useToast } from '@/components/toast';
import {
  addSkillAction,
  archiveLibrarySkillAction,
  createLibrarySkillAction,
  removeSkillAction,
  runSkillNowAction,
  setSkillEnabledAction,
  updateSkillAction,
  type SkillActionResult,
} from '@/lib/skill-actions';
import contactStyles from '@/components/contacts/contacts.module.css';

/**
 * The skills screens' client islands (docs/adr/0021). Every button is drawn
 * from a decision the server made with can(); every action checks again.
 */

function useRun() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<SkillActionResult>, ok?: string, after?: (r: SkillActionResult & { ok: true }) => void) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        toast({ title: 'Not done', description: r.error, variant: 'error' });
        return;
      }
      if (ok) toast({ title: ok, variant: 'success' });
      after?.(r);
      router.refresh();
    });
  return { pending, run, router };
}

export function AddSkillButton({ skillId, basePath }: { skillId: string; basePath: string }) {
  const { pending, run, router } = useRun();
  return (
    <button
      type="button"
      className={contactStyles.btn}
      disabled={pending}
      onClick={() => run(() => addSkillAction(skillId, browserTimeZone()), 'Added to your skills', (r) => r.id && router.push(`${basePath}/${r.id}`))}
    >
      {pending ? 'Adding…' : 'Add to my skills'}
    </button>
  );
}

export function EnabledToggle({ id, enabled, blocked }: { id: string; enabled: boolean; blocked: string | null }) {
  const { pending, run } = useRun();
  return (
    <label className={contactStyles.check} title={blocked ?? undefined}>
      <input
        type="checkbox"
        checked={enabled}
        disabled={pending || (!enabled && Boolean(blocked))}
        onChange={(e) => run(() => setSkillEnabledAction(id, e.target.checked), e.target.checked ? 'Switched on' : 'Switched off')}
      />
      <strong>{enabled ? 'On' : 'Off'}</strong>
      {!enabled && blocked ? <span className={contactStyles.hint}> — {blocked}</span> : null}
    </label>
  );
}

export function RunNowButton({ id, basePath, disabledReason }: { id: string; basePath: string; disabledReason: string | null }) {
  const { pending, run, router } = useRun();
  return (
    <button
      type="button"
      className={contactStyles.btn}
      disabled={pending || Boolean(disabledReason)}
      title={disabledReason ?? undefined}
      onClick={() =>
        run(() => runSkillNowAction(id), undefined, (r) => r.runId && router.push(`${basePath}/${id}/runs/${r.runId}`))
      }
    >
      {pending ? 'Running…' : 'Run now'}
    </button>
  );
}

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function ScheduleForm({
  id,
  cadence,
  sendAtMinute,
  sendOnWeekday,
  intervalMinutes,
  timezone,
  emailMe,
}: {
  id: string;
  cadence: 'daily' | 'weekly' | 'interval';
  sendAtMinute: number;
  sendOnWeekday: number | null;
  intervalMinutes: number | null;
  timezone: string;
  emailMe: boolean;
}) {
  const { pending, run } = useRun();
  const pad = (n: number) => String(n).padStart(2, '0');
  const [c, setC] = useState(cadence);
  const [time, setTime] = useState(`${pad(Math.floor(sendAtMinute / 60))}:${pad(sendAtMinute % 60)}`);
  const [day, setDay] = useState(String(sendOnWeekday ?? 1));
  const [hours, setHours] = useState(String((intervalMinutes ?? 120) / 60));
  const [mail, setMail] = useState(emailMe);
  const [zone, setZone] = useState(timezone);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setZone(browserTimeZone()), []);

  return (
    <form
      className={contactStyles.form}
      style={{ padding: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        const schedule = { cadence: c, time, timezone: zone, ...(c === 'weekly' ? { sendOnWeekday: Number(day) } : {}), ...(c === 'interval' ? { intervalHours: Number(hours) } : {}) };
        const check = skillScheduleSchema.safeParse(schedule);
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Check the schedule');
          return;
        }
        setError(null);
        run(() => updateSkillAction(id, { schedule, emailMe: mail }), 'Schedule saved');
      }}
    >
      {error ? <p className={contactStyles.error} role="alert">{error}</p> : null}
      <div className={contactStyles.inlineForm}>
        <select className={contactStyles.select} value={c} onChange={(e) => setC(e.target.value as typeof c)} aria-label="How often">
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="interval">Every few hours</option>
        </select>
        {c === 'weekly' ? (
          <select className={contactStyles.select} value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day">
            {WEEKDAY_LABELS.map((d, i) => (
              <option key={d} value={i}>{d}</option>
            ))}
          </select>
        ) : null}
        {c === 'interval' ? (
          <select className={contactStyles.select} value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Every">
            {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
              <option key={h} value={h}>every {h} h</option>
            ))}
          </select>
        ) : (
          <input className={contactStyles.input} style={{ minWidth: 0, flex: '0 1 8rem' }} type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
        )}
      </div>
      <span className={contactStyles.hint}>On your clock ({zone}).</span>
      <label className={contactStyles.check}>
        <input type="checkbox" checked={mail} onChange={(e) => setMail(e.target.checked)} />
        Also email me the result
      </label>
      <div className={contactStyles.actions}>
        <button type="submit" className={contactStyles.btnGhost} disabled={pending}>{pending ? 'Saving…' : 'Save schedule'}</button>
      </div>
    </form>
  );
}

export function BodyEditor({ id, bodyMd }: { id: string; bodyMd: string }) {
  const { pending, run } = useRun();
  const [text, setText] = useState(bodyMd);
  const errors = parseSkillMarkdown(text).errors;
  return (
    <form
      className={contactStyles.noteForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (errors.length) return;
        run(() => updateSkillAction(id, { bodyMd: text }), 'Skill text saved');
      }}
    >
      <textarea
        className={contactStyles.textarea}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8125rem' }}
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Skill instructions (Markdown)"
      />
      {errors.length ? <p className={contactStyles.error} role="alert">{errors.join(' · ')}</p> : null}
      <div className={contactStyles.actions}>
        <button type="submit" className={contactStyles.btnGhost} disabled={pending || Boolean(errors.length) || text === bodyMd}>
          {pending ? 'Saving…' : 'Save text'}
        </button>
        <button type="button" className={contactStyles.btnGhost} disabled={text === bodyMd} onClick={() => setText(bodyMd)}>Undo changes</button>
      </div>
    </form>
  );
}

export function RemoveSkillButton({ id, basePath }: { id: string; basePath: string }) {
  const { pending, run, router } = useRun();
  return (
    <button
      type="button"
      className={contactStyles.linkBtn}
      disabled={pending}
      onClick={() => {
        if (window.confirm('Remove this skill from your list? It stops running; its past results are kept.')) {
          run(() => removeSkillAction(id), 'Removed', () => router.push(basePath));
        }
      }}
    >
      Remove from my skills
    </button>
  );
}

export function NewLibrarySkillForm({ basePath }: { basePath: string }) {
  const { pending, run, router } = useRun();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [handler, setHandler] = useState<SkillHandler>('morning_brief');
  const [bodyMd, setBodyMd] = useState('---\nrequires: []\nmodel: summary\nschedule: daily 07:00\n---\n\nWrite the instructions here.\n');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={contactStyles.form}
      onSubmit={(e) => {
        e.preventDefault();
        const input = { name, description, handler, bodyMd };
        const check = librarySkillSchema.safeParse(input);
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Check the fields');
          return;
        }
        setError(null);
        run(() => createLibrarySkillAction(input), 'Added to the agency library', () => router.push(basePath));
      }}
    >
      {error ? <p className={contactStyles.error} role="alert">{error}</p> : null}
      <label className={contactStyles.field}>
        <span className={contactStyles.label}>Name</span>
        <input className={contactStyles.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <label className={contactStyles.field}>
        <span className={contactStyles.label}>Description</span>
        <input className={contactStyles.input} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </label>
      <label className={contactStyles.field}>
        <span className={contactStyles.label}>What it does (fixed in code)</span>
        <select className={contactStyles.select} value={handler} onChange={(e) => setHandler(e.target.value as SkillHandler)}>
          {SKILL_HANDLERS.map((h) => (
            <option key={h} value={h}>{SKILL_HANDLER_LABELS[h]}</option>
          ))}
        </select>
        <span className={contactStyles.hint}>The text below changes how it writes, never what it can read.</span>
      </label>
      <label className={contactStyles.field}>
        <span className={contactStyles.label}>Instructions (Markdown, with front-matter)</span>
        <textarea className={contactStyles.textarea} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.8125rem' }} rows={12} value={bodyMd} onChange={(e) => setBodyMd(e.target.value)} />
      </label>
      <div className={contactStyles.actions}>
        <button type="submit" className={contactStyles.btn} disabled={pending}>{pending ? 'Adding…' : 'Add to library'}</button>
      </div>
    </form>
  );
}

export function ArchiveLibrarySkillButton({ skillId }: { skillId: string }) {
  const { pending, run } = useRun();
  return (
    <button
      type="button"
      className={contactStyles.linkBtn}
      disabled={pending}
      onClick={() => {
        if (window.confirm('Archive this library skill? Nobody can add it any more; agents who have it keep their copy.')) {
          run(() => archiveLibrarySkillAction(skillId), 'Archived');
        }
      }}
    >
      Archive
    </button>
  );
}
