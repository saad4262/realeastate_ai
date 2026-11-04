/**
 * The consumer skills (ADR 0080): the client's 21 AI skills for buyers on the public site, each with a
 * switch. Fixed in code — a new one is an entry here plus the gate that honours it, both reviewed. Pure
 * data, no database, so the account page, the property chat and the tests read the same list.
 * The plan and the order they are built in: docs/CONSUMER-SKILLS.md.
 */

export const CONSUMER_SKILL_KEYS = [
  'property_search',
  'discovery',
  'visual_search',
  'opportunities',
  'property_analyst',
  'suburb_insights',
  'comparison',
  'due_diligence',
  'development',
  'affordability',
  'renovation',
  'inspection_planner',
  'inspection_notes',
  'immersive',
  'smart_alerts',
  'property_monitor',
  'tasks',
  'automation',
  'buyer_assistant',
  'personal_profile',
  'agent_messages',
] as const;

export type ConsumerSkillKey = (typeof CONSUMER_SKILL_KEYS)[number];

export const CONSUMER_SKILL_GROUPS = ['Find homes', 'Understand a property', 'Money & plans', 'Inspections', 'Keep watch', 'Your assistant'] as const;
export type ConsumerSkillGroup = (typeof CONSUMER_SKILL_GROUPS)[number];

export type ConsumerSkill = {
  key: ConsumerSkillKey;
  group: ConsumerSkillGroup;
  name: string;
  /** One line, for the card and the guide. */
  description: string;
  /**
   * `answers`: only replies to what the buyer asks — ON until they switch it off. `acts`: does something
   * by itself or contacts somebody — OFF until they switch it on (the user, 2026-11-03).
   */
  kind: 'answers' | 'acts';
  /** Works only for a signed-in buyer: it keeps something of theirs, or acts in their name. */
  account: boolean;
  /** `planned` has no switch yet: there is nothing to turn on. */
  status: 'live' | 'partial' | 'planned';
  /** Its phase in docs/CONSUMER-SKILLS.md. */
  phase: string;
};

export const CONSUMER_SKILLS: readonly ConsumerSkill[] = Object.freeze([
  { key: 'property_search', group: 'Find homes', name: 'AI Property Search', description: 'Ask for a home in your own words and the guide searches the live listings.', kind: 'answers', account: false, status: 'live', phase: 'live' },
  { key: 'discovery', group: 'Find homes', name: 'Discovery AI', description: 'Homes you may like, including ones not advertised for sale.', kind: 'answers', account: false, status: 'live', phase: 'C7' },
  { key: 'visual_search', group: 'Find homes', name: 'Visual Search AI', description: 'Find homes whose photos look like your words or like a photo on this site. Early: it works once there are enough photos to compare.', kind: 'answers', account: false, status: 'partial', phase: 'C9' },
  { key: 'opportunities', group: 'Find homes', name: 'Opportunity AI', description: "Price reductions, homes on the market a long time, and asking prices below this site's recent sales.", kind: 'answers', account: false, status: 'live', phase: 'C7' },
  { key: 'property_analyst', group: 'Understand a property', name: 'Property Analyst', description: 'One property explained from its records, including homes not for sale.', kind: 'answers', account: false, status: 'live', phase: 'C5' },
  { key: 'suburb_insights', group: 'Understand a property', name: 'Suburb AI', description: 'What has sold in a suburb, and how suburbs compare.', kind: 'answers', account: false, status: 'live', phase: 'C5' },
  { key: 'comparison', group: 'Understand a property', name: 'Comparison AI', description: 'Two to four properties side by side, and the trade-offs between them.', kind: 'answers', account: false, status: 'live', phase: 'C5' },
  { key: 'due_diligence', group: 'Understand a property', name: 'Due-Diligence AI', description: 'What to check before you buy, what the records show, and what to ask the agent.', kind: 'answers', account: false, status: 'live', phase: 'C2' },
  { key: 'development', group: 'Understand a property', name: 'Property Development AI', description: "A property's zone from the state's own data, the land size from the ad, and the questions to ask a town planner. Facts, never advice.", kind: 'answers', account: false, status: 'live', phase: 'C9' },
  { key: 'affordability', group: 'Money & plans', name: 'Affordability AI', description: 'Repayments, stamp duty and what you could borrow, with what-if scenarios. Estimates, not advice.', kind: 'answers', account: false, status: 'live', phase: 'C1' },
  { key: 'renovation', group: 'Money & plans', name: 'Renovation AI', description: 'What a renovation could involve and an indicative cost range.', kind: 'answers', account: false, status: 'live', phase: 'C3' },
  { key: 'inspection_planner', group: 'Inspections', name: 'Inspection AI', description: 'Plan your open homes in a sensible order and add them to your calendar.', kind: 'answers', account: false, status: 'live', phase: 'C6' },
  { key: 'inspection_notes', group: 'Inspections', name: 'Inspection Assistant', description: 'Your notes, photos and checklist from each inspection, kept private and summarised.', kind: 'answers', account: true, status: 'live', phase: 'C6' },
  { key: 'immersive', group: 'Inspections', name: 'Immersive Property AI', description: 'Floorplans, video and 3D tours as the agent publishes them, and the guide knows the rooms by name.', kind: 'answers', account: false, status: 'live', phase: 'C9' },
  { key: 'smart_alerts', group: 'Keep watch', name: 'Smart Alerts', description: 'Emails with new homes for the searches you saved. Off: your saved searches stop sending until you turn it back on.', kind: 'answers', account: true, status: 'live', phase: 'live' },
  { key: 'property_monitor', group: 'Keep watch', name: 'Property Monitor', description: 'Watch an address and hear when it is listed, changes price, goes under offer or sells.', kind: 'acts', account: true, status: 'live', phase: 'C4' },
  { key: 'tasks', group: 'Keep watch', name: 'Tasks', description: 'Property research done once or on a schedule, with a report when it is done.', kind: 'acts', account: true, status: 'live', phase: 'C8' },
  { key: 'automation', group: 'Keep watch', name: 'Automation', description: 'When something happens to a home you follow, do what you asked.', kind: 'acts', account: true, status: 'live', phase: 'C8' },
  { key: 'buyer_assistant', group: 'Your assistant', name: 'Buyer AI', description: 'The property guide you chat with. Off: the chat is switched off for you.', kind: 'answers', account: false, status: 'live', phase: 'live' },
  { key: 'personal_profile', group: 'Your assistant', name: 'Personal Property AI', description: 'Learns what you like from your searches and saves, so answers fit you. You can see and delete it.', kind: 'acts', account: true, status: 'live', phase: 'C4' },
  { key: 'agent_messages', group: 'Your assistant', name: 'Agent AI', description: 'The guide drafts a question or enquiry to the agent; you read it and send it.', kind: 'acts', account: true, status: 'live', phase: 'C8' },
] satisfies ConsumerSkill[]);

const BY_KEY = new Map(CONSUMER_SKILLS.map((s) => [s.key, s]));

export function consumerSkill(key: ConsumerSkillKey): ConsumerSkill {
  return BY_KEY.get(key)!;
}

export function isConsumerSkillKey(value: unknown): value is ConsumerSkillKey {
  return typeof value === 'string' && BY_KEY.has(value as ConsumerSkillKey);
}

/** On until switched off, or off until switched on (ADR 0080 §2). */
export function consumerSkillDefault(key: ConsumerSkillKey): boolean {
  return consumerSkill(key).kind === 'answers';
}

/** Built enough to have a switch. */
export function isSwitchable(key: ConsumerSkillKey): boolean {
  return consumerSkill(key).status !== 'planned';
}

/** The skills the platform paused for everyone (ADR 0080 §4): `CONSUMER_SKILLS_PAUSED`, a comma list. */
export function pausedConsumerSkills(env: Record<string, string | undefined> = process.env): ReadonlySet<ConsumerSkillKey> {
  return new Set((env.CONSUMER_SKILLS_PAUSED ?? '').split(',').map((k) => k.trim()).filter(isConsumerSkillKey));
}

/** Why a skill is not running for this buyer; null when it is. */
export type ConsumerSkillBlock = 'not_built' | 'paused' | 'needs_account' | 'switched_off';

/**
 * One skill's state for one buyer. Pure: the buyer's stored switch (undefined = never touched), whether
 * they are signed in, and what the platform paused. The order is the order of the reasons a buyer can do
 * nothing about first, so the page tells them the one that matters.
 */
export function consumerSkillBlock(key: ConsumerSkillKey, stored: boolean | undefined, signedIn: boolean, paused: ReadonlySet<ConsumerSkillKey>): ConsumerSkillBlock | null {
  if (!isSwitchable(key)) return 'not_built';
  if (paused.has(key)) return 'paused';
  if (consumerSkill(key).account && !signedIn) return 'needs_account';
  return (stored ?? consumerSkillDefault(key)) ? null : 'switched_off';
}

/**
 * The property chat's tools and the skill each needs on (ADR 0080 §5). A tool in no list is never gated:
 * `resolve_location` is a step of several skills, and `cancel_schedule` stops something — switching a
 * skill off must never take away the way to stop it.
 */
export const CONSUMER_SKILL_OF_TOOL: Readonly<Record<string, ConsumerSkillKey>> = Object.freeze({
  search_listings: 'property_search',
  cheapest_near: 'property_search',
  get_listing: 'property_search',
  recent_sales: 'suburb_insights',
  draft_schedule: 'smart_alerts',
  affordability_estimate: 'affordability',
  due_diligence: 'due_diligence',
  renovation_plan: 'renovation',
  suburb_profile: 'suburb_insights',
  compare_homes: 'comparison',
  explain_home: 'property_analyst',
  plan_inspections: 'inspection_planner',
  discover_homes: 'discovery',
  find_opportunities: 'opportunities',
  draft_message: 'agent_messages',
  draft_task: 'tasks',
  draft_automation: 'automation',
  floorplan_rooms: 'immersive',
  land_and_zoning: 'development',
  homes_that_look_like: 'visual_search',
});

/** The words every refusal uses, so the buyer (and the guide) know why and where to change it. */
export function consumerSkillOffMessage(key: ConsumerSkillKey, block: ConsumerSkillBlock): string {
  const name = consumerSkill(key).name;
  switch (block) {
    case 'switched_off':
      return `“${name}” is switched off in your Skills. You can turn it back on at My account → Skills.`;
    case 'needs_account':
      return `“${name}” needs an account. Sign in, then it is in your Skills.`;
    case 'paused':
      return `“${name}” is paused for everyone at the moment. Try again later.`;
    case 'not_built':
      return `“${name}” is not available yet.`;
  }
}
