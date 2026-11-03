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
 * Checked 2026-11-03 for all eight. The regulators' sites refuse a direct fetch (403), so each rule was checked
 * against the text of the official page as a search restricted to that state's government domain returned it
 * (`checkedVia: 'official_search'`) — the same standard as the Tasmanian duty rates. Where the only text found
 * was a council's, or none, the trigger stays unverified — a council is not the state.
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

const WA_POOLS = src('WA Building and Energy — swimming pool and spa safety barrier requirements', 'https://www.wa.gov.au/organisation/building-and-energy/swimming-pool-and-spa-safety-barrier-requirements');
const WA_RULES: readonly PermitRule[] = [
  rule('electrical', 'All electrical work must be done by a person who holds the relevant electrical licence.', src('WA Building and Energy', 'https://www.wa.gov.au/organisation/building-and-energy/building-and-energy')),
  rule('plumbing', 'Water supply, sanitary and drainage plumbing must be done by a plumber licensed by the Plumbers Licensing Board; a home owner may do only a few limited tasks.', src('WA Building and Energy — plumbing work in your home', 'https://www.wa.gov.au/organisation/building-and-energy/plumbing-work-your-home')),
  rule('pool_or_spa', 'A new pool or spa needs a building permit from the local government before it is built. The local government inspects its safety barrier once it is finished, and again at regular intervals.', WA_POOLS),
];

const SA_PLANSA = src('PlanSA — development applications (FAQ)', 'https://plan.sa.gov.au/__data/assets/pdf_file/0004/799231/FAQ_-_Development_Applications.pdf');
const SA_APPROVAL = 'PlanSA’s approval wizard, given your address, says whether the work needs development approval and what to do next. Do not start work that needs approval before you have it.';
const SA_LICENCES = src('SA Government — check occupational licence holders', 'https://www.sa.gov.au/topics/business-and-trade/licensing/licence-check');
const SA_RULES: readonly PermitRule[] = [
  rule('structural', SA_APPROVAL, SA_PLANSA),
  rule('new_floor_area', SA_APPROVAL, SA_PLANSA),
  rule('deck_or_raised_structure', 'Verandahs, carports and similar structures often need development approval; PlanSA’s approval wizard says for your address.', SA_PLANSA),
  rule('electrical', 'Electrical work must be certified by the contractor or the worker with an electronic certificate of compliance.', src('Consumer and Business Services — working as an electrician in SA', 'https://www.cbs.sa.gov.au/documents/AMR-Working-as-an-electrician-in-SA.pdf')),
  rule('plumbing', 'Plumbing is registered trade work; check the plumber on the government’s public licence register.', SA_LICENCES),
  rule('gas', 'Gas fitting is registered trade work; check the gas fitter on the government’s public licence register.', SA_LICENCES),
  rule('pool_or_spa', 'A pool needs a continuous safety barrier that keeps young children out, with gates that close properly; the council enforces it.', src('SA Government — inspecting a property', 'https://www.sa.gov.au/topics/housing/buying-building-selling/building-or-buying-home/inspecting-a-property')),
  rule('older_home_materials', 'Older homes may contain asbestos; demolition, renovation, cutting, sanding or drilling can release it. Professional removal is strongly recommended.', src('SafeWork SA — a DIY guide to asbestos safety for home renovators', 'https://www.safework.sa.gov.au/news-and-alerts/news/news/2022/a-diy-guide-to-asbestos-safety-for-home-renovators')),
];

const TAS_CATEGORIES = src('CBOS Tasmania — categories of building and demolition work (Director’s Determination)', 'https://www.cbos.tas.gov.au/__data/assets/pdf_file/0014/405014/Directors-determination-categories-of-building-and-demolition-work-2021.pdf');
const TAS_BUILDING = 'Building work falls into four categories: low-risk work an owner may do within size and setback limits; low-risk work for a licensed builder; notifiable work, which a building surveyor assesses and notifies to the permit authority; and permit work, which needs a building surveyor’s certificate of likely compliance and a building permit from the council.';
const TAS_RULES: readonly PermitRule[] = [
  rule('structural', TAS_BUILDING, TAS_CATEGORIES),
  rule('new_floor_area', TAS_BUILDING, TAS_CATEGORIES),
  rule('deck_or_raised_structure', TAS_BUILDING, TAS_CATEGORIES),
  rule('plumbing', 'Plumbing has its own four categories: some an owner may do; others need a licensed plumber; notifiable and permit plumbing need the council’s approval, and permit work cannot start before the plumbing permit.', src('Tasmanian building standards — plumbing for consumers', 'https://buildingstandards.tas.gov.au/topics/technical-regulation/plumbing-standards/for-consumers')),
  rule('older_home_materials', 'A home built or renovated before the 1990s probably contains asbestos; have a survey done before you start. Friable asbestos, and non-friable asbestos above a set area, needs a WorkSafe Tasmania licensed removalist.', src('WorkSafe Tasmania — asbestos safety for DIYers', 'https://worksafe.tas.gov.au/safety/safety_subjects/subject/asbestos_safety/diys_asbestos_safety')),
];

const ACT_DA = src('ACT Planning — check if you need a DA', 'https://www.planning.act.gov.au/applications-and-assessments/development-applications/check-if-you-need-a-da');
const ACT_TRADES = src('Access Canberra — choosing a tradesperson', 'https://www.accesscanberra.act.gov.au/consumer-rights/choosing-a-tradesperson');
const ACT_RULES: readonly PermitRule[] = [
  rule('structural', 'ACT Planning’s “Check if you need a DA” says whether the work needs a development application.', ACT_DA),
  rule('new_floor_area', 'ACT Planning’s “Check if you need a DA” says whether an addition needs a development application.', ACT_DA),
  rule('electrical', 'Check that the electrician is licensed for the work on Access Canberra’s public register.', ACT_TRADES),
  rule('plumbing', 'Check that the plumber is licensed for the work on Access Canberra’s public register.', ACT_TRADES),
  rule('gas', 'Check that the gasfitter is licensed for the work on Access Canberra’s public register.', ACT_TRADES),
  rule('older_home_materials', 'A house built before 1990 may contain asbestos, and you cannot tell by looking; only a licensed asbestos removalist may remove asbestos-containing material from a home.', src('ACT Government — asbestos', 'https://www.act.gov.au/housing-planning-and-property/staying-healthy-in-your-home/asbestos')),
];

const NT_PERMITS = src('NT Government — residential building work that requires permits', 'https://nt.gov.au/property/building/build-or-renovate-your-home/building-and-renovating-a-home/residential-building-work-that-requires-permits');
const NT_PERMIT_NOTE = 'Alterations and extensions need a building permit, whether or not they add floor area. A registered building certifier issues it before work starts.';
const NT_RULES: readonly PermitRule[] = [
  rule('structural', NT_PERMIT_NOTE, NT_PERMITS),
  rule('new_floor_area', NT_PERMIT_NOTE, NT_PERMITS),
  rule('deck_or_raised_structure', 'Some garden sheds, carports, fences and shade structures in residential areas need no building permit if they meet the exemption criteria; otherwise they need a permit and occupancy certification.', src('NT Government — a garden shed, carport, fence or shade structure that doesn’t need approval', 'https://nt.gov.au/property/building/build-or-renovate-your-home/building-a-garden-shed-carport,-fence-or-shade-structure')),
  rule('plumbing', 'Plumbing and drainage work must be done by a licensed plumber and drainer; a certifying plumber and drainer issues the certificate of compliance.', src('NT Government — plumbing or drainage work on your property', 'https://nt.gov.au/property/building/build-or-renovate-your-home/plumbing-or-drainage-work-on-your-property')),
];

const VERIFIED: Record<DutyState, readonly PermitRule[]> = { VIC: VIC_RULES, NSW: NSW_RULES, QLD: QLD_RULES, WA: WA_RULES, SA: SA_RULES, TAS: TAS_RULES, ACT: ACT_RULES, NT: NT_RULES };

export const STATE_PERMIT_RULES: Readonly<Record<DutyState, StatePermitRules>> = Object.freeze(
  Object.fromEntries(AU_DUTY_STATES.map((state) => [state, { state, rules: VERIFIED[state] }])) as unknown as Record<DutyState, StatePermitRules>,
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
