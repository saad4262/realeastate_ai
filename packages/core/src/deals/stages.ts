/**
 * The deal pipeline's fixed parts (ADR 0063). Pure, so the board, the Deal tab, the sync and the tests read
 * one list. The order is the database enum's (`deal_stage`).
 */

export const DEAL_STAGES = ['appraisal', 'listing', 'marketing', 'offers', 'negotiation', 'contract', 'settlement'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  appraisal: 'Appraisal',
  listing: 'Listing',
  marketing: 'Marketing',
  offers: 'Offers',
  negotiation: 'Negotiation',
  contract: 'Contract',
  settlement: 'Settlement',
};

export const DEAL_STATUSES = ['open', 'settled', 'withdrawn'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export function stageIndex(s: DealStage): number {
  return DEAL_STAGES.indexOf(s);
}

/**
 * The stage a listing's own facts put a deal at, or null when they say nothing (withdrawn). The sync only
 * ever moves a deal forward to this. Pure.
 */
export function stageForListing(status: string, hasOffer: boolean): DealStage | null {
  switch (status) {
    case 'draft':
    case 'pending':
      return 'listing';
    case 'live':
      return hasOffer ? 'offers' : 'marketing';
    case 'under_offer':
      return 'negotiation';
    case 'sold':
      return 'contract';
    default:
      return null;
  }
}

/** Why the sync moved a deal to a stage — one line on its history. */
export const AUTO_NOTES: Record<DealStage, string> = {
  appraisal: 'An appraisal was booked',
  listing: 'A listing was drafted',
  marketing: 'The listing went live',
  offers: 'An offer was received',
  negotiation: 'The listing went under offer',
  contract: 'The listing was marked sold',
  settlement: 'Moved to settlement',
};

/** The conditions every contract gets (ADR 0063 §3); the agent adds any others. */
export const STANDARD_CONDITIONS = [
  { kind: 'cooling_off', label: 'Cooling-off ends' },
  { kind: 'finance', label: 'Finance approval' },
  { kind: 'building_pest', label: 'Building & pest' },
  { kind: 'unconditional', label: 'Unconditional' },
] as const;
export type ConditionKind = (typeof STANDARD_CONDITIONS)[number]['kind'] | 'custom';

/** Reminders go this many days before a condition's due date and the settlement date. */
export const DEAL_REMINDER_DAYS = 2;
