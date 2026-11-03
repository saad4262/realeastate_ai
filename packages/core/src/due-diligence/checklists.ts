import { AU_DUTY_STATES, type DutySource, type DutyState } from '../affordability/duty-rates';

/**
 * Due-Diligence AI's checklists (ADR 0080, C2; mock docs/mocks/consumer-due-diligence.html, decision 2): what to
 * check before buying, per state, written by us from each state's official pages — never by a model. Every item
 * carries its source and the day it was checked, and is re-checked with the duty rates every 1 July
 * (`dueDiligenceDue`, a smoke note). A state we could not verify gets the general list and says so.
 *
 * General information, not legal advice (decision 1) — the page and the guide say so.
 */

export type ChecklistItem = { id: string; title: string; detail: string };

export type StateChecklist = {
  state: DutyState;
  /** The state's own items, first; null where we have not verified the state's rules. */
  items: readonly ChecklistItem[] | null;
  source: DutySource | null;
  /** The official map viewer for zoning and overlays, where we have verified one. */
  maps: readonly { label: string; url: string }[];
};

/** Good practice anywhere in Australia. Shown under every state's own items, and alone where those are unverified. */
export const GENERAL_CHECKLIST: readonly ChecklistItem[] = Object.freeze([
  { id: 'read-everything', title: 'Read the contract and every document the seller gives you before you sign', detail: 'A conveyancer or solicitor should review them with you.' },
  { id: 'inspection', title: 'Building and pest inspection', detail: 'By a qualified inspector, before you commit or as a condition of the contract.' },
  { id: 'title', title: 'The title', detail: 'Who owns it, and any easements, covenants or caveats on it.' },
  { id: 'maps', title: 'Zoning, flood, bushfire and heritage', detail: 'The official maps and the council — they can limit what you can build or change, and what insurance costs.' },
  { id: 'strata', title: 'Strata or owners corporation (a unit or townhouse)', detail: 'The fees, the rules (pets, renovations) and the records of meetings and repairs.' },
  { id: 'money', title: 'Finance and insurance', detail: 'Finance approved before any finance date in the contract; insurance from the day the risk passes to you.' },
]);

const CHECKED = '2026-11-03';

const VIC: StateChecklist = {
  state: 'VIC',
  source: { name: 'Consumer Affairs Victoria — due diligence checklist (updated 18 July 2025)', url: 'https://www.consumer.vic.gov.au/housing/buying-and-selling-property/checklists/due-diligence', checkedOn: CHECKED },
  maps: [{ label: 'VicPlan — zones, overlays and a planning property report', url: 'https://www.planning.vic.gov.au/schemes-and-amendments/get-information-about-your-planning-scheme/vicplan' }],
  items: [
    { id: 'vic-s32', title: 'Read the vendor statement (section 32) and the contract before you sign', detail: 'It holds important information about the property, including encumbrances. Consider a lawyer or conveyancer.' },
    { id: 'vic-planning', title: 'Planning controls', detail: 'Zoning and overlays can limit building and changes to the property. Check nearby planning permits too — they can change the area’s character, noise and traffic.' },
    { id: 'vic-flood-fire', title: 'Flood and fire risk', detail: 'How they affect land management, the buildings and insurance.' },
    { id: 'vic-permits', title: 'Building permits and safety', detail: 'Confirm past building work was approved. An inspection can check electrical safety, illegal work, pool fencing, asbestos and termites.' },
    { id: 'vic-boundaries', title: 'Land boundaries', detail: 'Check that fences and buildings match the measurements on the title.' },
    { id: 'vic-oc', title: 'Owners corporation', detail: 'Shared property may come with fees and rules that limit what you can do, such as pet bans.' },
    { id: 'vic-services', title: 'Service connections', detail: 'Water, sewerage, electricity, gas, phone and internet may not be connected, or may cost money to connect.' },
    { id: 'vic-recent-work', title: 'Insurance for recent building work', detail: 'Ask about owner-builder insurance or the builder’s warranty for recent renovations.' },
  ],
};

const NSW: StateChecklist = {
  state: 'NSW',
  source: { name: 'NSW Fair Trading — contracts and deposits when buying property', url: 'https://www.fairtrading.nsw.gov.au/housing-and-property/buying-and-selling-property/buying-a-property/contracts-and-deposits', checkedOn: CHECKED },
  maps: [{ label: 'NSW Planning Portal — planning information about a property', url: 'https://www.service.nsw.gov.au/transaction/search-planning-information-about-property' }],
  items: [
    { id: 'nsw-contract-docs', title: 'Read the contract’s documents before you exchange', detail: 'The contract should include the planning certificate (section 10.7), a drainage diagram and the title documents.' },
    { id: 'nsw-cooling-off', title: 'Know your cooling-off period', detail: 'In a private sale: 5 business days from exchange, ending at 5 pm on the fifth business day. Ending the contract in that time costs 0.25% of the price. There is no cooling-off period at an auction; off the plan it is 10 business days.' },
    { id: 'nsw-use-it', title: 'Inspect before an auction, or within the cooling-off period', detail: 'Use the time for a building and pest inspection and to have the contract reviewed.' },
    { id: 'nsw-deposit', title: 'The deposit', detail: 'Usually 10% of the price unless a smaller amount is agreed.' },
  ],
};

const QLD: StateChecklist = {
  state: 'QLD',
  source: { name: 'Queensland Government — seller disclosure scheme', url: 'https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/seller-disclosure-scheme', checkedOn: CHECKED },
  maps: [],
  items: [
    { id: 'qld-form2', title: 'Get the seller disclosure statement (Form 2) and its certificates before you sign', detail: 'The seller must give them before you sign — at an auction, before the fall of the hammer. They cover the title and encumbrances, zoning and planning notices, contamination and heritage listings, and pool and building notices.' },
    { id: 'qld-not-covered', title: 'Check what the statement does not cover', detail: 'Structural soundness, flooding history and past building or development approvals are not required in it — check them yourself (an inspection, the council).' },
    { id: 'qld-termination', title: 'If it is missing or wrong', detail: 'You may be able to end the contract up to settlement if it was not given, or is wrong or incomplete on something material.' },
  ],
};

const WA: StateChecklist = {
  state: 'WA',
  source: { name: 'Consumer Protection WA — sale by offer and acceptance', url: 'https://www.consumerprotection.wa.gov.au/real-estate-contracts-sale-offer-and-acceptance', checkedOn: CHECKED },
  maps: [],
  items: [
    { id: 'wa-no-cooling-off', title: 'There is no cooling-off period', detail: 'The offer and acceptance binds you once acceptance is communicated, unless the contract adds one.' },
    { id: 'wa-conditions', title: 'Make your offer conditional on what you need', detail: 'Finance, a building inspection — say what must happen, by when, who pays, and what happens if it does not.' },
    { id: 'wa-standard', title: 'Ask for an inspection to the Australian Standard', detail: 'A building inspection that complies with AS 4349.1.' },
    { id: 'wa-final', title: 'Inspect again before settlement', detail: 'Sales have been delayed by faults found only at the final inspection.' },
  ],
};

const unverified = (state: DutyState): StateChecklist => ({ state, items: null, source: null, maps: [] });

export const STATE_CHECKLISTS: Readonly<Record<DutyState, StateChecklist>> = Object.freeze({
  NSW,
  VIC,
  QLD,
  WA,
  SA: unverified('SA'),
  TAS: unverified('TAS'),
  ACT: unverified('ACT'),
  NT: unverified('NT'),
});

export function checklistFor(state: string): StateChecklist | null {
  return (AU_DUTY_STATES as readonly string[]).includes(state) ? STATE_CHECKLISTS[state as DutyState] : null;
}

/** Re-checked with the duty rates every 1 July (ROADMAP technical debt). Pure — `now` is passed in. */
export function dueDiligenceDue(now: Date): { stale: { state: DutyState; source: DutySource }[]; unverified: DutyState[] } {
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const lastFirstOfJuly = `${year}-07-01`;
  const lists = Object.values(STATE_CHECKLISTS);
  return {
    stale: lists.flatMap((c) => (c.source && c.source.checkedOn < lastFirstOfJuly ? [{ state: c.state, source: c.source }] : [])),
    unverified: lists.filter((c) => !c.items).map((c) => c.state),
  };
}
