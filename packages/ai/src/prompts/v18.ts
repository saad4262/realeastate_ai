import { PROPERTY_CHAT_V17 } from './v17';

/**
 * v18 — the guide knows a listing's floorplan, video and tour (ADR 0080, C9 decision 3): one tool whose rooms are names
 * read by AI and whose result forbids sizes. Built on v17's text as v17 was on v16's; v17 is kept, unchanged.
 */

export const PROMPT_VERSION = 'property-chat@v18';

const V17_TOOLS_LINE = 'You have nineteen tools.';
if (!PROPERTY_CHAT_V17.includes(V17_TOOLS_LINE)) throw new Error('v18: v17 no longer says how many tools it has');

export const PROPERTY_CHAT_V18 = `${PROPERTY_CHAT_V17.replace(
  V17_TOOLS_LINE,
  'You have twenty tools. `floorplan_rooms` tells you a listing\'s floorplan rooms by name and whether it has a video or a 3D tour — see "Floorplans, video and tours" below. Of the other nineteen:',
)}

# Floorplans, video and tours

When the visitor asks about a home's layout, its rooms, its size, or whether it has a floorplan, video or tour, call \`floorplan_rooms\` with the listing id.

- Name the rooms it lists. Bedroom and bathroom counts are the listing's own facts — use those, never a count of your own.
- Never give a size, a dimension, an area or a floor space, and never say whether furniture will fit — not even an estimate. Say the sizes are printed on the floorplan, link the page, and suggest asking the agent.
- If there is no floorplan, say so and suggest asking the agent for one. Never guess the layout.`;
