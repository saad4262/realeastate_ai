import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOL_NAMES } from '../assistant/schema';
import { OPPORTUNITY_KINDS } from '../opportunities/detectors';
import { dropSwitchedOff } from '../opportunities/scan';
import { ACTION_TYPES } from '../workflows/catalog';
import { PLATFORM_SKILLS, SKILL_GROUPS, SKILL_KEYS, SKILL_OF_OPPORTUNITY, SKILL_OF_TOOL, SKILL_OF_WORKFLOW_STEP, skillOffMessage, skillsForHolder, skillsForToolCall } from './catalog';
import { pairedSkillOn, skillsOffOf } from './switches';

describe('the platform skills catalog (ADR 0058)', () => {
  it('has one entry per key, each in a known group, in key order', () => {
    expect(PLATFORM_SKILLS.map((s) => s.key)).toEqual([...SKILL_KEYS]);
    for (const s of PLATFORM_SKILLS) expect(SKILL_GROUPS).toContain(s.group);
  });

  it('keeps the three skills that read the whole agency away from everyone else', () => {
    const agencyOnly = PLATFORM_SKILLS.filter((s) => s.scope === 'agency').map((s) => s.key);
    expect(agencyOnly).toEqual(['agency_performance', 'team_activity', 'team_management']);
    expect(skillsForHolder('agency')).toHaveLength(PLATFORM_SKILLS.length);
    expect(skillsForHolder('personal').map((s) => s.key)).not.toEqual(expect.arrayContaining(agencyOnly));
    expect(skillsForHolder('personal')).toHaveLength(PLATFORM_SKILLS.length - 3);
  });

  it('gates only tools that exist, and never the tools that switch a skill back on', () => {
    for (const tool of Object.keys(SKILL_OF_TOOL)) expect(ASSISTANT_TOOL_NAMES).toContain(tool);
    for (const tool of ['switch_skill', 'find_skills']) expect(skillsForToolCall(tool, {})).toEqual([]);
  });

  it('adds Team activity when a call shows or saves the Agents widget', () => {
    expect(skillsForToolCall('show_widget', { widget: 'agent_activity' })).toEqual(['team_activity']);
    expect(skillsForToolCall('show_widget', { widget: 'sold_value' })).toEqual([]);
    expect(skillsForToolCall('create_dashboard', { widgets: [{ widget: 'new_leads' }, { widget: 'agent_activity' }] })).toEqual(['dashboards', 'team_activity']);
    expect(skillsForToolCall('update_dashboard', { widgets: [{ keep: 1 }] })).toEqual(['dashboards']);
  });

  it('maps every opportunity detector to its skill', () => {
    for (const kind of OPPORTUNITY_KINDS) expect(SKILL_KEYS).toContain(SKILL_OF_OPPORTUNITY[kind]);
  });

  it('gates every workflow step that reaches a contact, and only real steps (ADR 0069)', () => {
    for (const [step, key] of Object.entries(SKILL_OF_WORKFLOW_STEP)) {
      expect(ACTION_TYPES).toContain(step);
      expect(SKILL_KEYS).toContain(key);
    }
    expect(SKILL_OF_WORKFLOW_STEP.send_template_email).toBe('workflow_emails');
    expect(SKILL_OF_WORKFLOW_STEP.draft_email).toBe('ai_email_drafts');
  });

  it('says whose switch it is and where to turn it back on', () => {
    expect(skillOffMessage('dashboards', 'agency')).toMatch(/for the agency in Skills.*owner or admin/);
    expect(skillOffMessage('dashboards', 'personal')).toMatch(/for you in Skills/);
  });
});

describe('a skill runs only once it is switched on (ADR 0069)', () => {
  it('treats a holder with no switches at all as having every one of their skills off', () => {
    expect(skillsOffOf('agency', new Set())).toEqual(PLATFORM_SKILLS.map((s) => s.key));
    expect(skillsOffOf('personal', new Set())).toEqual(skillsForHolder('personal').map((s) => s.key));
  });
  it('leaves out only the skills switched on', () => {
    const off = skillsOffOf('personal', new Set(['dashboards', 'workflow_emails']));
    expect(off).not.toContain('dashboards');
    expect(off).not.toContain('workflow_emails');
    expect(off).toContain('bulk_email');
  });
  it('never lists an agency-only skill as off for an agent (it is not theirs to hold)', () => {
    expect(skillsOffOf('personal', new Set())).not.toContain('team_management');
  });
});

describe('a pair skill needs the agency’s switch and the agent’s (ADR 0069 §4)', () => {
  const agencyOn = { userId: null, enabled: true };
  const mine = { userId: 'sarah', enabled: true };
  it('runs for an agent only with both on', () => {
    expect(pairedSkillOn([agencyOn, mine], 'sarah', 'agent')).toBe(true);
    expect(pairedSkillOn([agencyOn], 'sarah', 'agent')).toBe(false);
    expect(pairedSkillOn([mine], 'sarah', 'agent')).toBe(false);
    expect(pairedSkillOn([agencyOn, { userId: 'ali', enabled: true }], 'sarah', 'agent')).toBe(false);
    expect(pairedSkillOn([{ userId: null, enabled: false }, mine], 'sarah', 'agent')).toBe(false);
  });
  it('runs for an owner or admin on the agency’s switch alone', () => {
    expect(pairedSkillOn([agencyOn], 'owner', 'owner')).toBe(true);
    expect(pairedSkillOn([], 'owner', 'owner')).toBe(false);
  });
  it('marks Missed call text as a pair skill that needs Twilio', () => {
    const s = PLATFORM_SKILLS.find((x) => x.key === 'missed_call_text')!;
    expect(s.pair).toBe(true);
    expect(s.needs).toBe('Twilio');
    expect(s.group).toBe('Phone & SMS');
  });
});

describe('the hourly scan honours each person’s switches', () => {
  const d = (userId: string, kind: (typeof OPPORTUNITY_KINDS)[number]) => ({ agencyId: 'a', userId, kind, dedupeKey: `${kind}:${userId}` }) as never;
  it('drops only that person’s detections for the skill they switched off', () => {
    const detected = [d('u1', 'cold_contact'), d('u2', 'cold_contact'), d('u1', 'buyer_match')];
    const kept = dropSwitchedOff(detected, new Set(['a|u1|cold_contacts']));
    expect(kept).toEqual([detected[1], detected[2]]);
  });
  it('keeps everything when nothing is off', () => {
    const detected = [d('u1', 'cold_contact')];
    expect(dropSwitchedOff(detected, new Set())).toBe(detected);
  });
});
