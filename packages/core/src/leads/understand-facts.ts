import { z } from 'zod';
import { PROPERTY_TYPES, type PropertyType } from '../listings/listing-schema';
import { figuresIn } from '../assistant/write-tools';
import type { BuyerRequirementInput } from '../contacts/contact-schema';

/**
 * "AI understands" (ADR 0078): what the model may say about an enquiry, and the check that keeps only what is
 * really in it. Pure — the job, the card and the tests share it.
 *
 * Non-negotiable 4: the model never produces a number. It returns each fact WITH the words it read it from;
 * a fact survives only when those words are in the enquiry AND the value can be read back out of those words by
 * code ("$750k" → 750000, "3 or 4 bedrooms" → 3). Everything else is dropped and listed, so the screen can say
 * "left out". A summary or a reason that carries a figure the enquiry does not is not kept either.
 */

export const LEAD_INTENTS = ['buyer', 'seller', 'landlord', 'tenant', 'investor', 'general', 'not_sure'] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];
export const LEAD_URGENCIES = ['high', 'normal'] as const;
export type LeadUrgency = (typeof LEAD_URGENCIES)[number];
export const FACT_FIELDS = ['price_from', 'price_to', 'bedrooms', 'bathrooms', 'suburbs', 'property_type', 'timeline', 'own_address', 'own_when'] as const;
export type FactField = (typeof FACT_FIELDS)[number];

const text = (max: number) => z.string().trim().max(max).catch('');

/** What the model hands back (packages/ai validates against this too). Anything malformed degrades, never throws. */
export const rawUnderstandingSchema = z.object({
  intent: z.enum(LEAD_INTENTS).catch('not_sure'),
  intent_why: text(300),
  urgency: z.enum(LEAD_URGENCIES).catch('normal'),
  urgency_why: text(300),
  summary: text(400),
  facts: z
    .array(
      z.object({
        field: z.enum(FACT_FIELDS),
        value: z.union([z.number(), z.string().max(200), z.array(z.string().max(80)).max(8)]),
        quote: z.string().max(200),
      }),
    )
    .max(12)
    .catch([]),
});
export type RawUnderstanding = z.infer<typeof rawUnderstandingSchema>;

export type KeptFact =
  | { field: 'price_from' | 'price_to' | 'bedrooms' | 'bathrooms'; value: number; quote: string }
  | { field: 'suburbs'; value: string[]; quote: string }
  | { field: 'property_type'; value: PropertyType; quote: string }
  | { field: 'timeline' | 'own_address' | 'own_when'; value: string; quote: string };
export type DroppedFact = { field: string; value: string; why: 'not_in_enquiry' | 'not_in_quote' | 'not_a_known_value' };

export type Understanding = {
  intent: LeadIntent;
  intentWhy: string | null;
  urgency: LeadUrgency;
  urgencyWhy: string | null;
  summary: string | null;
  facts: KeptFact[];
  dropped: DroppedFact[];
};

/** Lower case, one kind of quote mark and dash, single spaces — so "Officer’s" and "Officer's" are the same words. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Every amount written in a phrase, as dollars: "$750k" 750000, "$1.2m" 1200000, "$820,000" 820000, "750 thousand". */
export function amountsIn(phrase: string): number[] {
  const out: number[] = [];
  for (const m of norm(phrase).matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mil|million|thousand)?\b/g)) {
    const n = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const unit = m[2];
    const mult = unit === 'k' || unit === 'thousand' ? 1_000 : unit === 'm' || unit === 'mil' || unit === 'million' ? 1_000_000 : 1;
    out.push(Math.round(n * mult));
  }
  return out;
}

/** Every small whole number written in a phrase, in digits or words: "3 or 4" → [3, 4], "three" → [3]. */
export function countsIn(phrase: string): number[] {
  const p = norm(phrase);
  const digits = [...p.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]));
  const words = [...p.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g)].map((m) => WORDS[m[1]!]!);
  return [...digits, ...words];
}

const TYPE_WORDS: Record<PropertyType, string[]> = {
  house: ['house'],
  apartment: ['apartment', 'flat'],
  unit: ['unit'],
  townhouse: ['townhouse', 'town house'],
  villa: ['villa'],
  duplex: ['duplex'],
  studio: ['studio'],
  acreage: ['acreage', 'acres'],
  land: ['land', 'vacant block', 'block of land'],
  rural: ['rural', 'farm'],
  other: [],
};

/** True when every figure in `said` is also a figure in `source` — the model may repeat numbers, never make them. */
export function figuresFrom(said: string, source: string): boolean {
  const have = new Set(figuresIn(source).map((f) => f.replace(/[$,\s]/g, '').toLowerCase()));
  return figuresIn(said).every((f) => have.has(f.replace(/[$,\s]/g, '').toLowerCase()));
}

/** Keep only what the enquiry says. Pure. */
export function verifyUnderstanding(raw: RawUnderstanding, source: string): Understanding {
  const src = norm(source);
  const kept: KeptFact[] = [];
  const dropped: DroppedFact[] = [];
  const drop = (field: string, value: unknown, why: DroppedFact['why']) => dropped.push({ field, value: Array.isArray(value) ? value.join(', ') : String(value).slice(0, 80), why });

  for (const f of raw.facts) {
    const quote = f.quote.trim();
    const q = norm(quote);
    if (q.length < 2 || !src.includes(q)) {
      drop(f.field, f.value, 'not_in_enquiry');
      continue;
    }
    switch (f.field) {
      case 'price_from':
      case 'price_to': {
        const v = typeof f.value === 'number' ? f.value : Number(String(f.value).replace(/[^\d.]/g, ''));
        if (Number.isFinite(v) && v > 0 && amountsIn(quote).some((a) => Math.abs(a - v) < 1)) kept.push({ field: f.field, value: Math.round(v), quote });
        else drop(f.field, f.value, 'not_in_quote');
        break;
      }
      case 'bedrooms':
      case 'bathrooms': {
        const v = typeof f.value === 'number' ? f.value : Number(f.value);
        const word = f.field === 'bedrooms' ? /\bbed|\bbr\b/ : /\bbath/;
        if (Number.isInteger(v) && v > 0 && v <= 20 && word.test(q) && countsIn(quote).includes(v)) kept.push({ field: f.field, value: v, quote });
        else drop(f.field, f.value, 'not_in_quote');
        break;
      }
      case 'suburbs': {
        const list = (Array.isArray(f.value) ? f.value : [String(f.value)]).map((s) => s.trim()).filter(Boolean);
        const ok = list.filter((s) => s.length >= 2 && s.length <= 80 && q.includes(norm(s)));
        for (const s of list) if (!ok.includes(s)) drop('suburbs', s, 'not_in_quote');
        if (ok.length) kept.push({ field: 'suburbs', value: [...new Set(ok)], quote });
        break;
      }
      case 'property_type': {
        const v = norm(String(f.value)) as PropertyType;
        if (!(PROPERTY_TYPES as readonly string[]).includes(v) || v === 'other') drop(f.field, f.value, 'not_a_known_value');
        else if (TYPE_WORDS[v].some((w) => q.includes(w))) kept.push({ field: 'property_type', value: v, quote });
        else drop(f.field, f.value, 'not_in_quote');
        break;
      }
      case 'timeline':
      case 'own_when':
      case 'own_address': {
        const v = String(f.value).trim().slice(0, 200);
        // Words, kept as words. An address must be written in the enquiry; any figure must be in the quote.
        const fine = v.length >= 2 && (f.field === 'own_address' ? q.includes(norm(v)) : figuresFrom(v, quote));
        if (fine) kept.push({ field: f.field, value: v, quote });
        else drop(f.field, f.value, 'not_in_quote');
        break;
      }
    }
  }

  const said = (s: string) => (s && figuresFrom(s, source) ? s : null);
  return {
    intent: raw.intent,
    intentWhy: said(raw.intent_why),
    urgency: raw.urgency,
    urgencyWhy: said(raw.urgency_why),
    summary: said(raw.summary),
    facts: kept,
    dropped,
  };
}

/** The buyer brief the kept facts make, for the approval card — or null when they say nothing a brief can hold. */
export function briefFrom(u: Pick<Understanding, 'intent' | 'facts'>): BuyerRequirementInput | null {
  const one = <F extends KeptFact['field']>(field: F) => u.facts.find((f) => f.field === field) as Extract<KeptFact, { field: F }> | undefined;
  const brief: BuyerRequirementInput = {
    channel: u.intent === 'tenant' ? 'rent' : 'sale',
    ...(one('price_from') ? { priceMin: one('price_from')!.value } : {}),
    ...(one('price_to') ? { priceMax: one('price_to')!.value } : {}),
    ...(one('bedrooms') ? { minBedrooms: one('bedrooms')!.value } : {}),
    ...(one('bathrooms') ? { minBathrooms: one('bathrooms')!.value } : {}),
    ...(one('suburbs') ? { suburbs: one('suburbs')!.value } : {}),
    ...(one('property_type') ? { propertyTypes: [one('property_type')!.value] } : {}),
  };
  const says = Object.keys(brief).some((k) => k !== 'channel');
  return says ? brief : null;
}
