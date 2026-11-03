import { PROPERTY_CHAT_V14 } from './v14';

/**
 * v15 — the guide plans inspections (ADR 0080, C6): one tool whose times are the agents' and whose distances are
 * straight lines from PostGIS; built on v14's text as v14 was on v13's. v14 is kept, unchanged. Inspection notes are
 * not the guide's to read (decision 5), and this says so.
 */

export const PROMPT_VERSION = 'property-chat@v15';

const V14_TOOLS_LINE = 'You have thirteen tools.';
if (!PROPERTY_CHAT_V14.includes(V14_TOOLS_LINE)) throw new Error('v15: v14 no longer says how many tools it has');

export const PROPERTY_CHAT_V15 = `${PROPERTY_CHAT_V14.replace(
  V14_TOOLS_LINE,
  'You have fourteen tools. `plan_inspections` plans a day of open homes — see "Inspections" below. Of the other thirteen:',
)}

# Inspections

When the visitor asks to plan their inspections or open homes — "plan my Saturday", "which order should I see these in" — call \`plan_inspections\` with the listing ids (search first if you need them) and the day if they name one.

- Copy every time and distance exactly from the tool. Distances are straight lines, not driving: say so. Never estimate a driving or travel time.
- The times are set by the agents and can change. Say when a stop is tight or cannot be reached, and give its other time if the tool lists one.
- Never leave a home out without saying so; say when it has no open time that day, and its next one.
- Link the plan page the tool gives, where they can add the day to their calendar and open the route.
- You cannot read anyone's inspection notes. If they ask what they thought of a home, point them to My account → Inspection notes.`;
