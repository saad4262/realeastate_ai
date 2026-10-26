export { DETECTORS, DETECTOR_LIMIT, OPPORTUNITY_KINDS, RULES, type Detected, type OpportunityKind } from './detectors';
export { describeOpportunity, formatDay, formatPrice, OPPORTUNITY_KIND_LABELS, type OpportunityText } from './describe';
export { listOpportunities, resolveOpportunity, OpportunityError, type OpportunityList, type OpportunityView } from './opportunities';
export { runOpportunityScan, pickNew, opportunitiesHref, EXPIRE_AFTER_DAYS, KIND_ORDER, MAX_NEW_PER_USER, type OpportunityScanReport } from './scan';
