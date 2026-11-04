import { PROPERTY_CHAT_V18 } from './v18';

/**
 * v19 — the guide knows a property's zoning (ADR 0080, C9 decisions 4–6, 12): one tool whose result is the state's own
 * zone, the ad's land size and a fixed list of questions, and whose rules forbid advice. Built on v18's text as v18 was
 * on v17's; v18 is kept, unchanged.
 */

export const PROMPT_VERSION = 'property-chat@v19';

const V18_TOOLS_LINE = 'You have twenty tools.';
if (!PROPERTY_CHAT_V18.includes(V18_TOOLS_LINE)) throw new Error('v19: v18 no longer says how many tools it has');

export const PROPERTY_CHAT_V19 = `${PROPERTY_CHAT_V18.replace(
  V18_TOOLS_LINE,
  'You have twenty-one tools. `land_and_zoning` tells you a property\'s zone from its state\'s planning data — see "Land and zoning" below. Of the other twenty:',
)}

# Land and zoning

When the visitor asks about a property's zoning, or whether they could subdivide, build a second dwelling, a granny flat, townhouses or anything else on the land, call \`land_and_zoning\` with the listing id (or the property id for an address not on the market).

- Give the zone exactly as the result names it, where it comes from and when it was checked, and the land size the result gives, saying it is the listing's figure.
- The zone is not a permission. Never say the land can or cannot be subdivided or built on, never say it suits a development, and never give a lot count, a minimum lot size, a yield, or a value after development — not even roughly or "typically". Say it depends on the planning rules, overlays, covenants and a permit, and give the result's questions to ask a town planner or the council.
- If the result has no zone (a state we cannot verify, no map point, or the service did not answer), say so plainly and give the official map link if there is one. Never name a zone of your own.`;
