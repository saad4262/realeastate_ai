import { AU_DUTY_STATES, type DutySource, type DutyState } from '../affordability/duty-rates';
import { PERMIT_TRIGGERS, renovationCategory, type PermitTrigger, type RenovationCategoryKey } from './categories';

/**
 * Permit and approval notes per state (ADR 0080, C3 decision 5): what a trigger in categories.ts means in one
 * state, in our words, from that state's own official pages — every rule carries its source, the day it was
 * checked and how. A state (or a trigger) without a verified rule says "not verified" and links nothing.
 *
 * "Usually": the council, a registered building surveyor or a certifier decides; the page says that every time.
 * No dollar thresholds (the product team's rule): where a rule turns on a value, it says "above a set value" and
 * the source has the figure.
 *
 * Checked 2026-11-03 for VIC, NSW and QLD. Their regulators' sites refuse a direct fetch (403), so each rule was
 * checked against the text of the official page as a search restricted to that state's government domain
 * returned it (`checkedVia: 'official_search'`) — the same standard as the Tasmanian duty rates. Where the only
 * text found was a council's, or none, the trigger stays unverified. WA, SA, TAS, ACT and NT: not yet checked.
 */

export type PermitRule = {
  trigger: PermitTrigger;
  note: string;
  source: DutySource;
  /** `page`: read on the page itself. `official_search`: the page's text as a domain-restricted search returned it. */
  checkedVia: 'page' | 'official_search';
};

export type StatePermitRules = {
  state: DutyState;
  rules: readonly PermitRule[];
};

const CHECKED = '2026-11-03';
const src = (name: string, url: string): DutySource => ({ name, url, checkedOn: CHECKED });
const rule = (trigger: PermitTrigger, note: string, source: DutySource): PermitRule => ({ trigger, note, source, checkedVia: 'official_search' });

const VIC_PERMIT = src('Building and Plumbing Commission — when is a building permit required?', 'https://www.bpc.vic.gov.au/building-surveyors/permits/when-is-a-building-permit-required');
const VIC_RULES: readonly PermitRule[] = [
  rule('structural', 'All building work needs a building permit unless the regulations exempt it. You appoint a registered building surveyor first and apply through them.', VIC_PERMIT),
  rule('new_floor_area', 'An extension needs a building permit; when it is finished, your building surveyor issues a certificate of final inspection.', src('Building and Plumbing Commission — at the end of your building project', 'https://www.bpc.vic.gov.au/home-owners/home-renovation-and-building-essentials/at-the-end-of-your-building-project')),
  rule('deck_or_raised_structure', 'A deck on a structural subfloor needs a building permit. A pergola is exempt only within height, area and siting limits; a gazebo with a roof usually needs one.', src('Building and Plumbing Commission — balconies, decks and balustrades', 'https://www.bpc.vic.gov.au/resource-hub/safety-guides/balconies-decks-and-balustrades')),
  rule('plumbing', 'Plumbing work that needs a compliance certificate must be done or supervised by a licensed plumber, who gives you the certificate.', src('Building and Plumbing Commission — plumbing compliance certificates', 'https://www.bpc.vic.gov.au/plumbers/compliance-certificates')),
  rule('gas', 'Gasfitting is licensed work; ask for the compliance certificate when it is done.', src('Building and Plumbing Commission — plumbing compliance certificates', 'https://www.bpc.vic.gov.au/plumbers/compliance-certificates')),
  rule('electrical', 'A licensed electrician must give you, or your building surveyor, a certificate of electrical safety for any electrical installation work.', src('Energy Safe Victoria — installing air-conditioning systems (fact sheet)', 'https://www.energysafe.vic.gov.au/sites/default/files/2022-12/Fact-sheet-Air-conditioning-systems-VBA.pdf')),
  rule('pool_or_spa', 'Every pool and spa must be registered with the council and have a compliant safety barrier; a barrier compliance certificate is lodged with the council, and the barrier is inspected again every four years.', src('Building and Plumbing Commission — swimming pools and spas', 'https://www.bpc.vic.gov.au/home-owners/home-renovation-and-building-essentials/swimming-pools-and-spas')),
  rule('heritage', 'In a Heritage Overlay you generally need a council planning permit for demolition, outside changes and new building; a place on the Victorian Heritage Register needs Heritage Victoria’s approval.', src('Planning Victoria — local heritage protection', 'https://www.planning.vic.gov.au/guides-and-resources/guides/all-guides/local-heritage-protection')),
  rule('older_home_materials', 'A home built or renovated before 1990 is likely to contain asbestos, and only a laboratory test confirms it. Crumbly (friable) asbestos, large amounts and demolition are for a licensed removalist — not you, and generally not your builder.', src('Victorian Asbestos Hub — homeowner or renovator', 'https://www.asbestos.vic.gov.au/homeowner-or-renovator/')),
];

const NSW_PATHWAYS = src('NSW Planning Portal — exempt development', 'https://www.planningportal.nsw.gov.au/development-and-assessment/planning-approval-pathways/exempt-development');
const NSW_TRADES = src('NSW Government — building and trade licences and registrations', 'https://www.nsw.gov.au/business-and-economy/licences-and-credentials/building-and-trade-licences-and-registrations');
const NSW_SPECIALIST = 'Electrical, plumbing, drainage, gasfitting and air-conditioning work is specialist work: it needs a licensed tradesperson whatever it costs, and an owner-builder permit does not cover it.';
const NSW_RULES: readonly PermitRule[] = [
  rule('structural', 'Work that is not exempt development needs a complying development certificate (from the council or a registered certifier) or a development application to the council. A planning certificate (section 10.7) says whether complying development is possible on the lot.', NSW_PATHWAYS),
  rule('new_floor_area', 'An addition that does not meet every exempt-development standard needs a complying development certificate or a development application.', NSW_PATHWAYS),
  rule('deck_or_raised_structure', 'A deck or pergola needs no approval only if it meets every exempt-development standard (size, height, setbacks, structure); otherwise it needs a complying development certificate or a development application.', src('NSW Planning Portal — balconies, decks and patios', 'https://www.planningportal.nsw.gov.au/development-and-assessment/planning-approval-pathways/exempt-development/balconies-decks-and-patios')),
  rule('electrical', NSW_SPECIALIST, NSW_TRADES),
  rule('plumbing', NSW_SPECIALIST, NSW_TRADES),
  rule('gas', NSW_SPECIALIST, NSW_TRADES),
  rule('wet_area', 'Waterproofing — showers and other wet areas — is licensed trade work above a set value; check the licence before work starts.', src('NSW Government — waterproofing work', 'https://www.nsw.gov.au/business-and-economy/licences-and-credentials/building-and-trade-licences-and-registrations/waterproofing-work')),
  rule('heritage', 'On heritage-listed land — and on bushfire-prone or flood-control land — exempt or complying development may not be available, and the council’s approval may be needed.', NSW_PATHWAYS),
];

const QLD_APPROVALS = src('QBCC — building approvals and certification', 'https://www.qbcc.qld.gov.au/home-owner-hub/build-renovate/doing-work/building-approvals-certification');
const QLD_LICENSED = src('QBCC — find a licensed contractor', 'https://www.qbcc.qld.gov.au/home-owner-hub/build-renovate/finding-contractor-getting-quotes/find-licensed-contractor');
const QLD_APPROVAL_NOTE = 'Before work starts, you as the owner must make sure the right building approvals are in place — even when you have hired a builder. A licensed building certifier assesses the application, inspects the stages and gives the final approval.';
const QLD_RULES: readonly PermitRule[] = [
  rule('structural', QLD_APPROVAL_NOTE, QLD_APPROVALS),
  rule('new_floor_area', QLD_APPROVAL_NOTE, QLD_APPROVALS),
  rule('plumbing', 'Plumbing and drainage need a QBCC licence whatever the value of the work.', QLD_LICENSED),
  rule('gas', 'Gas fitting needs a QBCC licence whatever the value of the work.', QLD_LICENSED),
  rule('electrical', 'Electrical work needs a licence from the Electrical Safety Office.', QLD_LICENSED),
  rule('pool_or_spa', 'Selling, buying or leasing a property with a pool needs a pool safety certificate from a licensed pool safety inspector; the QBCC pool safety register shows whether a pool is registered and certified.', src('QBCC — buy, sell or lease a property with a pool', 'https://www.qbcc.qld.gov.au/home-owner-hub/swimming-pools/buy-sell-lease-property-pool')),
  rule('older_home_materials', 'Asbestos is common in houses built before 1990: assume it is there until an accredited laboratory has tested it. Use a licensed asbestos removalist; crumbly (friable) asbestos needs a Class A licence.', src('Queensland Government — asbestos safety', 'https://www.qld.gov.au/emergency/safety/home/asbestos')),
];

const VERIFIED: Partial<Record<DutyState, readonly PermitRule[]>> = { VIC: VIC_RULES, NSW: NSW_RULES, QLD: QLD_RULES };

export const STATE_PERMIT_RULES: Readonly<Record<DutyState, StatePermitRules>> = Object.freeze(
  Object.fromEntries(AU_DUTY_STATES.map((state) => [state, { state, rules: VERIFIED[state] ?? [] }])) as unknown as Record<DutyState, StatePermitRules>,
);

/** Each state's own government domain: a rule's source must be on it (tests). */
export const STATE_SOURCE_DOMAINS: Readonly<Record<DutyState, string>> = Object.freeze({
  NSW: '.nsw.gov.au',
  VIC: '.vic.gov.au',
  QLD: '.qld.gov.au',
  WA: '.wa.gov.au',
  SA: '.sa.gov.au',
  TAS: '.tas.gov.au',
  ACT: '.act.gov.au',
  NT: '.nt.gov.au',
});

export type PermitNote =
  | { trigger: PermitTrigger; verified: true; note: string; source: DutySource }
  | { trigger: PermitTrigger; verified: false };

/**
 * The notes for a plan in one state: every trigger its categories raise, once, in the order PERMIT_TRIGGERS
 * lists them, each with its verified rule or marked not verified. Pure.
 */
export function permitNotesFor(state: DutyState, categories: readonly RenovationCategoryKey[], rules: Readonly<Record<DutyState, StatePermitRules>> = STATE_PERMIT_RULES): PermitNote[] {
  const raised = new Set(categories.flatMap((k) => renovationCategory(k).triggers));
  const byTrigger = new Map(rules[state].rules.map((r) => [r.trigger, r]));
  return PERMIT_TRIGGERS.filter((tr) => raised.has(tr)).map((trigger) => {
    const rule = byTrigger.get(trigger);
    return rule ? { trigger, verified: true, note: rule.note, source: rule.source } : { trigger, verified: false };
  });
}

/** Re-checked with the duty rates every 1 July (ROADMAP technical debt). Pure — `now` is passed in. */
export function renovationRulesDue(now: Date, rules: Readonly<Record<DutyState, StatePermitRules>> = STATE_PERMIT_RULES): { stale: { state: DutyState; source: DutySource }[]; unverifiedStates: DutyState[] } {
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const lastFirstOfJuly = `${year}-07-01`;
  const all = Object.values(rules);
  return {
    stale: all.flatMap((s) => s.rules.filter((r) => r.source.checkedOn < lastFirstOfJuly).map((r) => ({ state: s.state, source: r.source }))),
    unverifiedStates: all.filter((s) => !s.rules.length).map((s) => s.state),
  };
}
