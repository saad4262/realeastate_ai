import type { OpportunityKind } from './detectors';

/**
 * Every sentence an opportunity shows (ADR 0054 §3): a template over the facts SQL returned —
 * no model writes or rewords anything. `ask` is the question typed into the assistant's box when
 * the person presses "Ask the assistant"; it is theirs to edit and send, and it never carries text
 * someone else wrote (an email's subject stays out of it — a prompt is not the place for it).
 */

export type OpportunityText = { title: string; detail: string; ask: string };

export const OPPORTUNITY_KIND_LABELS: Record<OpportunityKind, string> = {
  sale_anniversary: 'Sale anniversary',
  cold_contact: 'Gone quiet',
  unanswered_mail: 'Waiting for a reply',
  appraisal_follow_up: 'Appraisal follow-up',
  repeat_interest: 'Actively looking',
  buyer_match: 'New listing match',
};

type Facts = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export function formatDay(isoValue: unknown, timeZone: string): string {
  const s = str(isoValue);
  if (!s) return 'a while ago';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return 'a while ago';
  return new Intl.DateTimeFormat('en-AU', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/** A sold price as SQL stored it (`812000.00`) → `$812,000`. Formatting, not arithmetic. */
export function formatPrice(value: unknown): string | null {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);
}

export function describeOpportunity(kind: string, facts: Facts, timeZone = 'Australia/Sydney'): OpportunityText {
  const name = str(facts.contactName) ?? 'This contact';
  switch (kind as OpportunityKind) {
    case 'sale_anniversary': {
      const years = num(facts.years) ?? 5;
      const address = str(facts.address) ?? 'their property';
      const price = formatPrice(facts.soldPrice);
      const who = facts.relation === 'vendor' ? 'the vendor' : 'the owner';
      return {
        title: `${years} years since ${address} sold`,
        detail: `${name} (${who}) — sold ${formatDay(facts.soldDate, timeZone)}${price ? ` for ${price}` : ''}. A good time to check in about an appraisal.`,
        ask: `It is ${years} years since ${address} sold. Draft a short, friendly check-in email to this contact offering a free appraisal.`,
      };
    }
    case 'cold_contact': {
      const since = formatDay(facts.lastTouch, timeZone);
      return {
        title: `${name} has gone quiet`,
        detail: `Nothing with them since ${since}. A quick call or email keeps the relationship warm.`,
        ask: `I haven't been in touch with this contact since ${since}. Summarise what we know about them and suggest a next step.`,
      };
    }
    case 'unanswered_mail':
      return {
        title: `${str(facts.contactName) ?? 'An email'} is waiting for a reply`,
        detail: `${str(facts.subject) ? `“${str(facts.subject)}” — ` : ''}received ${formatDay(facts.receivedAt, timeZone)}, nothing sent since.`,
        ask: 'Summarise the latest email from this contact and suggest a reply.',
      };
    case 'appraisal_follow_up':
      return {
        title: `Follow up the appraisal with ${name}`,
        detail: `${str(facts.title) ? `“${str(facts.title)}” on ` : 'On '}${formatDay(facts.endedAt, timeZone)} — no note, email or next appointment since.`,
        ask: 'Draft a short follow-up email to this contact after their appraisal, and suggest a next step.',
      };
    case 'repeat_interest': {
      const n = num(facts.enquiries) ?? 3;
      return {
        title: `${name} is actively looking`,
        detail: `${n} enquiries in the last 30 days, the latest on ${formatDay(facts.latestAt, timeZone)}.`,
        ask: `This contact made ${n} enquiries in the last 30 days. Summarise what they asked about and suggest a next step.`,
      };
    }
    case 'buyer_match': {
      const address = str(facts.address) ?? 'A new listing';
      const beds = num(facts.bedrooms);
      const baths = num(facts.bathrooms);
      const type = str(facts.propertyType);
      const what = [
        str(facts.priceDisplay) ?? 'No price shown',
        beds !== null ? `${beds} bed` : null,
        baths !== null ? `${baths} bath` : null,
        type ? type.charAt(0).toUpperCase() + type.slice(1) : null,
      ].filter(Boolean);
      return {
        title: `${address} fits what ${name} is looking for`,
        detail: `${what.join(' · ')} — live ${formatDay(facts.publishedAt, timeZone)}.${str(facts.brief) ? ` Their brief: ${str(facts.brief)}.` : ''}`,
        // The address is the agency's own record; the headline and the price wording stay out of the prompt.
        ask: `A new listing at ${address} matches what this contact is looking for. Draft a short email telling them about it and offering an inspection.`,
      };
    }
    default:
      return { title: 'Something to look at', detail: '', ask: 'What should I do next with this contact?' };
  }
}
