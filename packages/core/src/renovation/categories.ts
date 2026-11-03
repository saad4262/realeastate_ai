/**
 * Renovation AI's fixed kinds of work (ADR 0080, C3; mock docs/mocks/consumer-renovation.html, approved by the
 * product team 2026-11-03). The model may only pick from these keys (decision 2); everything attached to a key —
 * what drives its cost, the trades involved, what can trigger a permit — is written here, by us, never by the
 * model. A new kind is an entry here plus its tests.
 *
 * No price anywhere (decision 1): there is no free, official source of renovation prices in Australia, so this
 * file says what a cost depends on, never what it is. `categories.test.ts` refuses any dollar figure or rate.
 */

export const RENOVATION_CATEGORY_KEYS = [
  'kitchen',
  'bathroom',
  'laundry',
  'remove_wall',
  'extension',
  'second_storey',
  'restumping',
  'deck',
  'pergola_or_carport',
  'landscaping',
  'fencing',
  'driveway_paving',
  'pool',
  'flooring',
  'painting',
  'plastering',
  'windows_and_doors',
  'insulation',
  'reroof',
  'guttering',
  'electrical_upgrade',
  'lighting',
  'heating_cooling',
  'solar',
  'plumbing',
] as const;

export type RenovationCategoryKey = (typeof RENOVATION_CATEGORY_KEYS)[number];

export const RENOVATION_GROUPS = ['Rooms', 'Structure', 'Inside', 'Outside', 'Services'] as const;
export type RenovationGroup = (typeof RENOVATION_GROUPS)[number];

/** Who usually does the work. A description of the job, not a licensing rule — those are per state (permits.ts). */
export const TRADES = [
  'builder',
  'carpenter',
  'electrician',
  'plumber',
  'gas_fitter',
  'structural_engineer',
  'building_surveyor',
  'roofer',
  'tiler',
  'painter',
  'plasterer',
  'glazier',
  'hvac_technician',
  'solar_installer',
  'landscaper',
  'fencer',
  'concreter',
  'pool_builder',
  'restumper',
  'flooring_installer',
  'cabinet_maker',
] as const;
export type Trade = (typeof TRADES)[number];

export const TRADE_LABELS: Readonly<Record<Trade, string>> = Object.freeze({
  builder: 'Builder',
  carpenter: 'Carpenter',
  electrician: 'Electrician',
  plumber: 'Plumber',
  gas_fitter: 'Gas fitter',
  structural_engineer: 'Structural engineer',
  building_surveyor: 'Building surveyor or certifier',
  roofer: 'Roofer',
  tiler: 'Tiler',
  painter: 'Painter',
  plasterer: 'Plasterer',
  glazier: 'Glazier',
  hvac_technician: 'Heating and cooling technician',
  solar_installer: 'Solar installer',
  landscaper: 'Landscaper',
  fencer: 'Fencer',
  concreter: 'Concreter',
  pool_builder: 'Pool builder',
  restumper: 'Restumping specialist',
  flooring_installer: 'Flooring installer',
  cabinet_maker: 'Cabinet maker',
});

/**
 * What about a piece of work can bring in a permit, an approval or a licensed trade. Neutral facts about the
 * work; what each one MEANS in a state — the rule, its wording, its source — lives in permits.ts.
 */
export const PERMIT_TRIGGERS = [
  'structural',
  'new_floor_area',
  'deck_or_raised_structure',
  'roof_work',
  'wet_area',
  'electrical',
  'plumbing',
  'gas',
  'pool_or_spa',
  'boundary',
  'heritage',
  'strata',
  'older_home_materials',
] as const;
export type PermitTrigger = (typeof PERMIT_TRIGGERS)[number];

export type RenovationCategory = {
  key: RenovationCategoryKey;
  group: RenovationGroup;
  name: string;
  /** One line, for the model's list and the page. */
  description: string;
  /** What the cost depends on, most important first. Words only — never a figure. */
  costDrivers: readonly string[];
  trades: readonly Trade[];
  triggers: readonly PermitTrigger[];
};

/** Every kind of work can touch these when the home is a unit, heritage-listed or older. */
const COMMON: readonly PermitTrigger[] = ['heritage', 'strata', 'older_home_materials'];
const t = (...own: PermitTrigger[]): PermitTrigger[] => [...own, ...COMMON];

export const RENOVATION_CATEGORIES: readonly RenovationCategory[] = Object.freeze([
  { key: 'kitchen', group: 'Rooms', name: 'Kitchen', description: 'A new or refitted kitchen.', costDrivers: ['Moving the sink, cooktop or dishwasher — the plumbing and gas move with them', 'Benchtop material and cabinet quality', 'Appliances: supplied by you or by the builder', 'Opening up the floor or walls'], trades: ['builder', 'cabinet_maker', 'plumber', 'electrician', 'gas_fitter', 'tiler'], triggers: t('plumbing', 'electrical', 'gas', 'wet_area') },
  { key: 'bathroom', group: 'Rooms', name: 'Bathroom', description: 'A new or refitted bathroom, ensuite or toilet.', costDrivers: ['Moving the shower, toilet or basin', 'Waterproofing and tiling area', 'Fixtures and fittings chosen', 'Whether the floor needs rebuilding'], trades: ['builder', 'plumber', 'electrician', 'tiler'], triggers: t('wet_area', 'plumbing', 'electrical') },
  { key: 'laundry', group: 'Rooms', name: 'Laundry', description: 'A new or relocated laundry.', costDrivers: ['Moving the taps and drainage', 'Cabinetry and benchtop', 'Ventilation'], trades: ['builder', 'plumber', 'electrician', 'cabinet_maker'], triggers: t('wet_area', 'plumbing', 'electrical') },
  { key: 'remove_wall', group: 'Structure', name: 'Removing a wall', description: 'Taking out a wall to open rooms up.', costDrivers: ['Whether the wall is load-bearing — the biggest single factor', 'Power, plumbing or gas inside the wall to reroute', 'Making good the floor, ceiling and walls where it stood'], trades: ['builder', 'structural_engineer', 'building_surveyor', 'electrician', 'plasterer'], triggers: t('structural', 'electrical') },
  { key: 'extension', group: 'Structure', name: 'Extension', description: 'Adding rooms or floor area at ground level.', costDrivers: ['Floor area added', 'Footings and the slope of the site', 'How it joins the existing roof', 'Rooms inside it: a wet area costs more than a living room'], trades: ['builder', 'structural_engineer', 'building_surveyor', 'electrician', 'plumber', 'roofer'], triggers: t('structural', 'new_floor_area', 'roof_work', 'boundary', 'electrical', 'plumbing') },
  { key: 'second_storey', group: 'Structure', name: 'Second storey', description: 'Building up: a new level on the house.', costDrivers: ['Floor area added', 'Whether the existing structure can carry it', 'Stairs and where they land', 'Living elsewhere during the work'], trades: ['builder', 'structural_engineer', 'building_surveyor', 'electrician', 'plumber', 'roofer'], triggers: t('structural', 'new_floor_area', 'roof_work', 'electrical', 'plumbing') },
  { key: 'restumping', group: 'Structure', name: 'Restumping or reblocking', description: 'Replacing the stumps under a raised floor.', costDrivers: ['How many stumps, and how many need replacing', 'Access under the floor', 'Cracks to repair once the house is level'], trades: ['restumper', 'builder', 'building_surveyor'], triggers: t('structural') },
  { key: 'deck', group: 'Outside', name: 'Deck', description: 'A new, larger or replacement deck.', costDrivers: ['Size and height above the ground', 'Timber or composite boards', 'A roof over it, or not', 'Footings and the slope of the yard'], trades: ['carpenter', 'builder', 'building_surveyor'], triggers: t('deck_or_raised_structure', 'boundary') },
  { key: 'pergola_or_carport', group: 'Outside', name: 'Pergola or carport', description: 'A roofed outdoor structure or carport.', costDrivers: ['Size and roofing material', 'Attached to the house or freestanding', 'Distance from the boundary'], trades: ['carpenter', 'builder', 'building_surveyor'], triggers: t('deck_or_raised_structure', 'roof_work', 'boundary') },
  { key: 'landscaping', group: 'Outside', name: 'Landscaping', description: 'Garden beds, lawn, retaining walls and paths.', costDrivers: ['Area and slope', 'Retaining walls and their height', 'Plants, soil and irrigation'], trades: ['landscaper', 'concreter'], triggers: t('boundary', 'plumbing') },
  { key: 'fencing', group: 'Outside', name: 'Fencing', description: 'A new or replacement fence.', costDrivers: ['Length and height', 'Material', 'Sharing the cost with a neighbour on a boundary fence'], trades: ['fencer'], triggers: t('boundary') },
  { key: 'driveway_paving', group: 'Outside', name: 'Driveway and paving', description: 'A driveway, path or paved area.', costDrivers: ['Area', 'Concrete, pavers or asphalt', 'Drainage and the slope'], trades: ['concreter', 'landscaper'], triggers: t('plumbing') },
  { key: 'pool', group: 'Outside', name: 'Pool or spa', description: 'A new pool or spa, or its fence.', costDrivers: ['In-ground or above-ground', 'Size and the shape of the site', 'Access for machinery', 'The safety barrier'], trades: ['pool_builder', 'fencer', 'electrician', 'plumber', 'building_surveyor'], triggers: t('pool_or_spa', 'electrical', 'plumbing', 'boundary') },
  { key: 'flooring', group: 'Inside', name: 'Flooring', description: 'New floors: timber, hybrid, carpet or tiles.', costDrivers: ['Floor area', 'The material chosen', 'Removing the old floor and levelling'], trades: ['flooring_installer', 'tiler', 'carpenter'], triggers: COMMON },
  { key: 'painting', group: 'Inside', name: 'Painting', description: 'Painting inside or outside.', costDrivers: ['Area and ceiling height', 'Preparation and repairs first', 'Inside, outside or both'], trades: ['painter'], triggers: COMMON },
  { key: 'plastering', group: 'Inside', name: 'Plastering and ceilings', description: 'Patching, replacing walls or ceilings.', costDrivers: ['Area', 'Patching or full replacement', 'Cornices and finishes'], trades: ['plasterer'], triggers: COMMON },
  { key: 'windows_and_doors', group: 'Inside', name: 'Windows and doors', description: 'New or bigger windows and doors.', costDrivers: ['Number and size', 'Glazing: single or double', 'Making an opening larger — it may be structural'], trades: ['glazier', 'carpenter', 'builder'], triggers: t('structural') },
  { key: 'insulation', group: 'Inside', name: 'Insulation', description: 'Insulating the ceiling, walls or floor.', costDrivers: ['Area and access to the roof space or under the floor', 'The material and its rating', 'Removing old insulation'], trades: ['builder', 'electrician'], triggers: t('electrical') },
  { key: 'reroof', group: 'Services', name: 'Re-roofing', description: 'Replacing or restoring the roof.', costDrivers: ['Roof area and pitch', 'Tiles or metal', 'Timber framing to repair'], trades: ['roofer', 'plumber', 'builder'], triggers: t('roof_work', 'structural') },
  { key: 'guttering', group: 'Services', name: 'Gutters and downpipes', description: 'New gutters, downpipes or stormwater.', costDrivers: ['Length', 'Material', 'Connecting to the stormwater'], trades: ['roofer', 'plumber'], triggers: t('roof_work', 'plumbing') },
  { key: 'electrical_upgrade', group: 'Services', name: 'Electrical upgrade', description: 'Rewiring, a new switchboard or more power points.', costDrivers: ['How much of the house is rewired', 'The switchboard', 'Access in the walls and ceiling'], trades: ['electrician'], triggers: t('electrical') },
  { key: 'lighting', group: 'Services', name: 'Lighting', description: 'New or moved lights.', costDrivers: ['Number of lights', 'Access in the ceiling', 'Fittings chosen'], trades: ['electrician'], triggers: t('electrical') },
  { key: 'heating_cooling', group: 'Services', name: 'Heating and cooling', description: 'Split systems, ducted heating or cooling.', costDrivers: ['Split systems or ducted', 'Number of rooms or zones', 'Power and gas available'], trades: ['hvac_technician', 'electrician', 'gas_fitter'], triggers: t('electrical', 'gas') },
  { key: 'solar', group: 'Services', name: 'Solar and batteries', description: 'Solar panels, a battery or a hot water system.', costDrivers: ['System size', 'Roof orientation and shading', 'A battery or not'], trades: ['solar_installer', 'electrician'], triggers: t('electrical', 'roof_work') },
  { key: 'plumbing', group: 'Services', name: 'Plumbing and hot water', description: 'Pipes, hot water or drainage.', costDrivers: ['Moving fixtures or replacing pipes', 'Hot water system type', 'Access under the floor'], trades: ['plumber', 'gas_fitter'], triggers: t('plumbing', 'gas') },
] satisfies RenovationCategory[]);

const BY_KEY = new Map(RENOVATION_CATEGORIES.map((c) => [c.key, c]));

export function renovationCategory(key: RenovationCategoryKey): RenovationCategory {
  return BY_KEY.get(key)!;
}

export function isRenovationCategoryKey(value: unknown): value is RenovationCategoryKey {
  return typeof value === 'string' && BY_KEY.has(value as RenovationCategoryKey);
}
