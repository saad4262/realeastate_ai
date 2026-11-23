import { SKILL_COMBOS, SKILL_GROUPS, skillsForHolder, type PlatformSkill, type SkillKey } from '../skill-switches/catalog';

/**
 * What the help bot knows about each platform skill: where its result shows and what it will not do.
 * What it does, its tag and what it needs come from the skills catalog, so the two cannot disagree.
 * A `Record<SkillKey, …>`: a new skill without a note here does not compile. Words, no figures that
 * change (the prompt forbids stating limits), and nothing here is a promise the code does not keep.
 */

export type SkillHelpSurface = 'agency' | 'agent';

type Note = { where: string; cannot: string };

const HOME = 'the Opportunities panel on the home page (and the bell rings when a new one is found)';
const OPPORTUNITY_CANNOT =
  'It is found by an hourly scan, not the moment it happens. It goes only to the person the contact is assigned to; a contact nobody is assigned to gives nothing. Dismiss it and it stays gone until something real changes. Nobody else sees it.';

function notes(people: string): Record<SkillKey, Note> {
  return {
    bulk_email: { where: `Marketing → Bulk email; a saved list comes from ${people}`, cannot: 'It never sends without Approve & Send. Only approved templates. Anyone without consent or who unsubscribed is left out.' },
    ai_email_drafts: { where: 'the Email chat, opened from the Email card on Skills', cannot: 'It never sends by itself: you read the draft, then send it.' },
    workflow_emails: { where: 'Skills → Automations: the workflow, and what each run did', cannot: 'It sends only your approved email templates, never text the AI wrote. Switched off, that step is skipped and the rest of the workflow runs.' },
    ai_listing_copy: { where: 'the Listing chat, opened from its card on Skills', cannot: 'It only writes a draft. Nothing goes live until a person approves it.' },
    property_summaries: { where: 'a property’s page (Properties → open an address), on a button', cannot: 'It summarises what is already on record for that address, each point linked to its record. It adds nothing and gives no valuation.' },
    buyer_matching: { where: `${HOME}; a buyer’s brief is on the contact’s Requirements tab`, cannot: 'It alerts the buyer’s agent only, never the buyer. A listing that went live more than about a week ago is not matched to a new brief, and a listing with no price shown does not match a brief with a budget.' },
    ai_import: { where: `${people} → Import: a checkbox on the column-matching step`, cannot: 'Only the rows that fail the check, and their matched fields, are sent to the AI. Every suggested fix is listed for you to check, and no marketing consent is ever imported.' },
    ai_workflow_decisions: { where: 'Skills → Automations: the run says what the AI chose and why', cannot: 'It works only on a trigger with words to read, such as a website enquiry. It never assigns a lead in an agent’s personal workflow. Switched off, “Not sure” runs.' },
    ai_understand_enquiries: { where: 'Leads: chips and a one-line summary under each enquiry', cannot: 'It never saves anything to a contact until a person approves the card. A private offer is never read. Only owners and admins can switch it on.' },
    sale_anniversaries: { where: HOME, cannot: `Only for a sold listing’s owner or vendor contact. ${OPPORTUNITY_CANNOT}` },
    cold_contacts: { where: HOME, cannot: `Only for a contact with a role or a lead. ${OPPORTUNITY_CANNOT}` },
    unanswered_emails: { where: HOME, cannot: `Never for an offer’s conversation. ${OPPORTUNITY_CANNOT}` },
    appraisal_follow_ups: { where: HOME, cannot: `A note, an email or a new appointment after the appraisal ends it. ${OPPORTUNITY_CANNOT}` },
    repeat_interest: { where: HOME, cannot: OPPORTUNITY_CANNOT },
    dashboards: { where: 'Knowledge & insights → Projects: New with the assistant', cannot: 'The figures come from the database, never from the AI’s own arithmetic.' },
    agency_performance: { where: 'asking in its chat, opened from its Skills card', cannot: 'Only owners and admins see it. It answers questions; it changes nothing.' },
    team_activity: { where: 'asking in its chat, or as a tile on a dashboard', cannot: 'Only owners and admins see it.' },
    knowledge_answers: { where: 'asking the assistant; documents are added in Knowledge & insights → Knowledge base', cannot: 'It answers only from the agency’s documents and the ones on contacts and listings, and says which one. If it is not in them, it says so.' },
    team_meetings: { where: 'asking the assistant to book a meeting; the meeting shows in Calendar', cannot: 'It needs Zoom connected (Settings → Connectors). It prepares the meeting and a person approves it.' },
    team_management: { where: 'asking the assistant; the Team page does the same by hand', cannot: 'Only owners and admins. Each invite, change or removal comes back as a card to approve.' },
    missed_call_text: { where: 'Daily work → Missed calls: each call says whether it was texted, or why not', cannot: 'It needs Twilio and a number for that agent. For an agent it runs only when the agency and that agent have both switched it on. Never to a landline, a private number or anyone who replied STOP, and not again to the same caller the same day. The text is the agency’s own template; the AI writes nothing.' },
    ai_callback: { where: 'Daily work → Missed calls: the call’s page shows the AI’s summary, transcript and recording', cannot: 'It needs Twilio and a number for that agent, and both the agency’s and the agent’s switches. It calls in calling hours, says it is an AI assistant, gives no prices and promises nothing, and books nothing. It does not call someone who texted back first, or whose call was already handled.' },
    bulk_sms: { where: 'Marketing → Bulk SMS', cannot: 'It never sends without Approve & Send, only in sending hours, never to anyone who replied STOP. It needs Twilio, and for an agent both the agency’s and their own switch.' },
    workflow_texts: { where: 'Skills → Automations: the workflow and its runs', cannot: 'It sends only your SMS templates, in sending hours, to people who may receive marketing, never anyone who replied STOP. It needs Twilio. Switched off, that step is skipped.' },
  };
}

const levelWords = (s: PlatformSkill) => (s.level === 'auto' ? 'works by itself once on' : 'prepares, then you approve');

/** The guide's skills section for one console. Same text every time: it is part of the cached prefix. */
export function skillsGuide(surface: SkillHelpSurface): string {
  const n = notes(surface === 'agency' ? 'Customers' : 'Contacts');
  const skills = skillsForHolder(surface === 'agency' ? 'agency' : 'personal');
  const lines = SKILL_GROUPS.flatMap((group) => {
    const inGroup = skills.filter((s) => s.group === group);
    if (!inGroup.length) return [];
    return [`${group}:`, ...inGroup.map((s) => `- ${s.name} (${levelWords(s)}${s.needs ? `; needs ${s.needs}` : ''}${s.pair ? '; an agent needs the agency’s switch and their own' : ''}): ${s.description} Where: ${n[s.key].where}. It will not: ${n[s.key].cannot}`)];
  });
  const combos = SKILL_COMBOS.map((c) => `${c.name} is one card on Skills for ${c.members.map((m) => skillsForHolder('agency').find((s) => s.key === m)!.name).join(', ')}; each keeps its own switch.`);
  return `Every skill is off until someone switches it on, on Skills → Platform skills. ${surface === 'agency' ? 'An owner or admin’s switch is for the whole agency.' : 'Your switches are your own; the agency’s switch alone does not turn one on for you.'} Someone who can only look cannot switch anything. A skill that is off does nothing, and its pages say it is off. ${combos.join(' ')}\n${lines.join('\n')}`;
}
