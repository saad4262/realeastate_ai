import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { runAssistantTool, type ToolContext } from '../assistant/tools';
import type { SkillKey } from './catalog';

const agencyId = '11111111-1111-1111-1111-111111111111';
const noDb = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the database was reached');
    },
  },
) as unknown as Db;

function ctx(off: SkillKey[], role: 'agent' | 'owner' = 'owner'): ToolContext {
  return {
    db: noDb,
    actor: { userId: 'u1', agencyId, membershipRole: role },
    skillsOff: async () => new Set(off),
    timeZone: 'Australia/Sydney',
    handles: {},
    now: new Date('2026-10-27T00:00:00Z'),
  };
}

describe('an assistant tool whose skill is switched off (ADR 0058)', () => {
  it('is refused before anything is read, with where to switch it back', async () => {
    const out = await runAssistantTool(ctx(['dashboards']), 'create_dashboard', { title: 'Leads', widgets: [{ widget: 'new_leads' }] });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toMatch(/“Dashboards” is switched off for the agency in Skills/);
  });

  it('refuses the Agents widget when Team activity is off, even inside show_widget', async () => {
    const out = await runAssistantTool(ctx(['team_activity']), 'show_widget', { widget: 'agent_activity', range: 'today' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toMatch(/Team activity/);
  });

  it("speaks of the person's own switch to an agent", async () => {
    const out = await runAssistantTool(ctx(['knowledge_answers'], 'agent'), 'search_documents', { query: 'deposit' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toMatch(/switched off for you in Skills/);
  });
});
