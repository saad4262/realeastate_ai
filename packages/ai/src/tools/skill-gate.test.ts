import { describe, expect, it } from 'vitest';
import { CONSUMER_SKILL_OF_TOOL, type ConsumerSkillBlock, type ConsumerSkillKey } from '@repo/core/consumer-skills/catalog';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from './index';

/**
 * ADR 0080 §5: a chat tool whose consumer skill is off is refused before it reads anything. Every reader
 * here throws, so a refusal that let the tool run would fail loudly instead of passing quietly.
 */
function ctx(blocks: [ConsumerSkillKey, ConsumerSkillBlock][]): ToolContext {
  const boom = () => {
    throw new Error('the tool ran');
  };
  return {
    db: {} as ToolContext['db'],
    resolvePlace: boom,
    search: boom,
    getListing: boom,
    nearbyMarket: boom,
    recentSales: boom,
    places: new Map(),
    skillBlocks: new Map(blocks),
    dueDiligence: async () => null,
    research: async () => null, inspections: async () => null, discover: async () => ({ found: false, reason: 'signed_out', note: '' }), opportunities: async () => { throw new Error('not in this test'); }, draftMessage: async () => ({ error: 'not in this test' }), proposalSecret: null, floorplan: async () => null, development: async () => null,
    scheduling: { state: 'signed_out' },
  };
}

describe('the consumer skill gate on the property chat (ADR 0080)', () => {
  it('maps only tools the guide actually has', () => {
    const names = PROPERTY_CHAT_TOOLS.map((t) => t.name);
    for (const tool of Object.keys(CONSUMER_SKILL_OF_TOOL)) expect(names).toContain(tool);
  });

  it('refuses a tool whose skill the buyer switched off, saying where to turn it back on', async () => {
    const out = await dispatchTool('search_listings', { channel: 'sale', suburb: 'Pakenham' }, ctx([['property_search', 'switched_off']]));
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('switched off in your Skills');
  });

  it('refuses a tool whose skill the platform paused', async () => {
    const out = await dispatchTool('recent_sales', { suburb: 'Pakenham' }, ctx([['suburb_insights', 'paused']]));
    expect(JSON.stringify(out.result)).toContain('paused for everyone');
  });

  it('leaves "needs an account" to the scheduling tool, which already says how to sign in', async () => {
    const out = await dispatchTool('draft_schedule', { cadence: 'daily' }, ctx([['smart_alerts', 'needs_account']]));
    expect(out.result).toMatchObject({ needsSignIn: true });
    expect(out.result).not.toHaveProperty('skillOff');
  });

  it('never refuses the way to stop an alert', async () => {
    const out = await dispatchTool('cancel_schedule', {}, ctx([['smart_alerts', 'switched_off']]));
    expect(JSON.stringify(out.result)).not.toContain('switched off in your Skills');
  });
});
