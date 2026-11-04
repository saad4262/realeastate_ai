/**
 * Property Development AI's sources (ADR 0080, C9 decisions 4–6; mock docs/mocks/consumer-media-land.html#development).
 * Zoning only from each state's own layer, and only where its licence allows a commercial site; every other state
 * says "not verified" and links its official map where we have checked the link (C2's rule: no unverified link). Pure.
 *
 * Checked 2026-11-04:
 * - VIC  Vicmap Planning, `open-data-platform:plan_zone` on opendata.maps.vic.gov.au (WFS, CC BY 4.0, weekly).
 * - NSW  Planning Portal, Principal Planning Layers MapServer layer 19 "Land Zoning" on mapprod3.environment.nsw.gov.au.
 * - SA   Planning and Design Code zones: CC BY 3.0 AU, fortnightly, DOWNLOAD only (its map services refuse outside
 *        queries) — loaded into `planning_zone` (migration 0089, `pnpm --filter @repo/db db:zones`), read by SQL.
 * - WA   SLIP map service: CC BY-NC → link only (PlanWA).
 * - QLD  no statewide layer (each council's scheme) → not verified.
 * - ACT, TAS licence not stated / terms to read; NT unverified at source → not verified until confirmed.
 */

export type ZoneState = 'NSW' | 'VIC' | 'QLD' | 'WA' | 'SA' | 'TAS' | 'ACT' | 'NT';

export type ZoneSource =
  | { status: 'live'; name: string; licence: string; url: string; kind: 'vic_wfs' | 'nsw_arcgis' | 'sa_table' }
  | { status: 'not_verified'; why: string; map: { label: string; url: string } | null };

export const ZONE_SOURCES: Record<ZoneState, ZoneSource> = {
  VIC: { status: 'live', kind: 'vic_wfs', name: 'Vicmap Planning (Department of Transport and Planning)', licence: 'CC BY 4.0', url: 'https://discover.data.vic.gov.au/dataset/vicmap-planning-planning-scheme-zone-polygon' },
  NSW: { status: 'live', kind: 'nsw_arcgis', name: 'NSW Planning Portal — Land Zoning (Department of Planning)', licence: 'NSW Government', url: 'https://www.planningportal.nsw.gov.au/opendata/dataset/environment-planning-instrument-local-environmental-plan-land-zoning' },
  SA: { status: 'live', kind: 'sa_table', name: 'Planning and Design Code zones (PlanSA, Government of South Australia)', licence: 'CC BY 3.0 AU', url: 'https://data.sa.gov.au/data/dataset/planning-and-design-code-zones' },
  WA: { status: 'not_verified', why: "Western Australia's zoning data is licensed for non-commercial use only, so we don't show it.", map: { label: 'PlanWA', url: 'https://espatial.dplh.wa.gov.au/PlanWA/Index.html?viewer=PlanWA' } },
  QLD: { status: 'not_verified', why: "Queensland has no statewide zoning layer — each council publishes its own planning scheme.", map: null },
  TAS: { status: 'not_verified', why: "Tasmania's zoning layer terms are still being checked.", map: null },
  ACT: { status: 'not_verified', why: "The ACT's Territory Plan layer has no stated licence yet.", map: null },
  NT: { status: 'not_verified', why: "The Northern Territory's zoning layer is not yet confirmed at its source.", map: { label: 'NR Maps (NT Government)', url: 'https://nrmaps.nt.gov.au/nrmaps.html' } },
};

/** The official planning maps for overlays (C2's verified links), where we have one. */
export const OVERLAY_MAP: Partial<Record<ZoneState, { label: string; url: string }>> = {
  VIC: { label: 'VicPlan — zones, overlays and a planning property report', url: 'https://www.planning.vic.gov.au/schemes-and-amendments/get-information-about-your-planning-scheme/vicplan' },
  NSW: { label: 'NSW Planning Portal — planning information about a property', url: 'https://www.service.nsw.gov.au/transaction/search-planning-information-about-property' },
  SA: { label: 'SA Property and Planning Atlas (SAPPA) — zones, overlays and the Code for this address', url: 'https://sappa.plan.sa.gov.au/' },
};

/** Our questions (decision 6): the same for every property in a state; never an answer to them. */
export const DEVELOPMENT_QUESTIONS: string[] = [
  'What is the minimum lot size in this zone, and does a schedule or local rule change it?',
  'Which overlays apply — heritage, flooding, bushfire, vegetation, landslip?',
  'Is there a covenant, easement or restriction on the title?',
  'Is there capacity in the sewer, water, stormwater and power connections?',
  'What permits or approvals would a second dwelling, an extension or a subdivision need?',
];

export const NOT_A_PERMISSION =
  'This is the zone, not a permission. Whether this land can be subdivided or built on depends on the planning rules, overlays, covenants and a permit. Ask a town planner or the council.';

/**
 * Words that would turn a fact into advice (decision 6). Never on the panel, never in the guide's answer. Pure.
 * "can be subdivided" is a claim; "whether it can be subdivided depends on…" is our own disclaimer, so it is let through.
 */
export const ADVICE_WORDS = [/(?<!\b(whether|if)\b[^.?!]{0,40})\b(can|could) (be )?subdivided?\b/i, /\benough (land |room )?for (a second|two|three|four|\d+) (lots?|blocks?|dwellings?|homes?|houses?|townhouses?)\b/i, /\bsuits? (a )?(dual occ|duplex|townhouses?|development)\b/i, /\b(fit|room for) \w+ (lots?|dwellings?|townhouses?)\b/i, /\bdevelopment potential\b/i, /\bapproved for\b/i, /\bworth \$/i, /\buplift\b/i, /\byield\b/i] as const;

export function adviceWords(text: string): string[] {
  return ADVICE_WORDS.flatMap((re) => {
    const m = text.match(re);
    return m ? [m[0]] : [];
  });
}
