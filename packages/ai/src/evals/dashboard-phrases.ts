/**
 * What people ask for, and what the assistant should build (ADR 0036 Phase 3).
 * A golden set: `pnpm test` checks every expected answer is something core
 * accepts (offline, free); `pnpm smoke:ai` sends the phrases to the real model
 * and compares — that one spends, and runs only when asked for.
 *
 * `fixed` is a widget from the registry; `custom` a spec from the catalog;
 * `missing` a figure the catalog cannot make (the gap log, never an estimate).
 */
export type DashboardEval =
  | { phrase: string; expect: { kind: 'fixed'; widget: string; range?: string } }
  | { phrase: string; expect: { kind: 'custom'; spec: Record<string, unknown>; /** The keys the model must match; others may differ. */ match: string[] } }
  | { phrase: string; expect: { kind: 'missing' } };

export const DASHBOARD_EVALS: DashboardEval[] = [
  { phrase: 'Create a dashboard with all agents and the emails they received today', expect: { kind: 'fixed', widget: 'agent_activity', range: 'today' } },
  { phrase: 'Show me sold value for the last 7 days', expect: { kind: 'fixed', widget: 'sold_value', range: '7d' } },
  { phrase: 'How many active listings do we have?', expect: { kind: 'fixed', widget: 'listings_by_status' } },
  {
    phrase: 'Sales by suburb last month',
    expect: { kind: 'custom', spec: { dataset: 'sales', measures: ['sold_value', 'count'], groupBy: ['suburb'], range: 'last_month' }, match: ['dataset', 'groupBy', 'range'] },
  },
  {
    phrase: 'Leads per week this year',
    expect: { kind: 'custom', spec: { dataset: 'leads', measures: ['count'], groupBy: ['week'], range: 'this_year' }, match: ['dataset', 'measures', 'groupBy', 'range'] },
  },
  {
    phrase: 'How many active listings does each agent have?',
    expect: { kind: 'custom', spec: { dataset: 'listings', measures: ['active'], groupBy: ['agent'] }, match: ['dataset', 'measures', 'groupBy'] },
  },
  {
    phrase: 'Median sold price by property type this year',
    expect: { kind: 'custom', spec: { dataset: 'sales', measures: ['median_price'], groupBy: ['property_type'], range: 'this_year' }, match: ['dataset', 'measures', 'groupBy', 'range'] },
  },
  {
    phrase: 'Appraisals booked per agent this month',
    expect: {
      kind: 'custom',
      spec: { dataset: 'appointments', measures: ['active'], groupBy: ['agent'], filters: [{ dimension: 'type', op: 'eq', values: ['appraisal'] }], range: 'this_month' },
      match: ['dataset', 'groupBy', 'range'],
    },
  },
  {
    phrase: 'Emails sent and received by each agent in the last 30 days',
    expect: { kind: 'custom', spec: { dataset: 'emails', measures: ['received', 'sent'], groupBy: ['agent'], range: '30d' }, match: ['dataset', 'groupBy', 'range'] },
  },
  {
    phrase: 'Enquiries about properties in Pakenham this month, by status',
    expect: {
      kind: 'custom',
      spec: { dataset: 'leads', measures: ['count'], groupBy: ['status'], filters: [{ dimension: 'suburb', op: 'eq', values: ['Pakenham'] }], range: 'this_month' },
      match: ['dataset', 'groupBy', 'filters', 'range'],
    },
  },
  {
    phrase: 'Contacts who agreed to marketing, per agent',
    expect: { kind: 'custom', spec: { dataset: 'contacts', measures: ['with_consent'], groupBy: ['agent'], range: 'all_time' }, match: ['dataset', 'measures', 'groupBy'] },
  },
  { phrase: 'Commission earned by each agent this quarter', expect: { kind: 'missing' } },
  { phrase: 'Average time to first reply on new enquiries', expect: { kind: 'missing' } },
  { phrase: 'Marketing spend per listing', expect: { kind: 'missing' } },
];
