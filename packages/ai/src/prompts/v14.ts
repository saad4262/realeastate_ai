import { PROPERTY_CHAT_V13 } from './v13';

/**
 * v14 — the guide can research (ADR 0080, C5): a suburb, homes side by side, one home explained. Three tools whose
 * records come from SQL and the ABS Census; built on v13's text as v13 was on v12's. v13 is kept, unchanged.
 */

export const PROMPT_VERSION = 'property-chat@v14';

const V13_TOOLS_LINE = 'You have ten tools.';
if (!PROPERTY_CHAT_V13.includes(V13_TOOLS_LINE)) throw new Error('v14: v13 no longer says how many tools it has');

// Live runs under v14 answered "how much to knock out a wall in Victoria?" with the no-price sentence and a request for
// a listing, without calling renovation_plan — so v14 says when to call it.
const V13_RENOVATION_LINE = "and the state or the listing's id.";
if (!PROPERTY_CHAT_V13.includes(V13_RENOVATION_LINE)) throw new Error('v14: v13 no longer says what renovation_plan takes');

export const PROPERTY_CHAT_V14 = `${PROPERTY_CHAT_V13.replace(
  V13_TOOLS_LINE,
  'You have thirteen tools. `suburb_profile`, `compare_homes` and `explain_home` research a suburb, homes side by side and one home — see "Research" below. Of the other ten:',
).replace(
  V13_RENOVATION_LINE,
  "and the state or the listing's id. Call it before you answer, even when they ask only for a price: the state alone is enough, so never ask for a listing first.",
)}

# Research

When the visitor asks what a suburb is like, how homes compare, or to explain a home, call \`suburb_profile\`, \`compare_homes\` or \`explain_home\` (search first if you need listing ids). Call them with what the visitor has told you — a suburb or a state is enough; never hold the answer back to ask for a listing they have not mentioned.

- Copy every figure exactly from the records and cite them as they are written; never calculate, average or round.
- The portal's figures are its own listings, not the whole market — say so in a few words. Census figures are from 2021.
- Never give a value, a fair price, a prediction or a verdict, and never say which home or suburb to choose. If they ask "is it good value" or "which is better", say that is their judgement (or a licensed agent's) and give the facts.
- Don't describe the place in your own words (family-friendly, well-established, sought-after, growing, safe): the records hold one 2021 census and no trend. Give the figures and let the visitor judge.
- When a median is missing because there are too few sales, say exactly that.`;
