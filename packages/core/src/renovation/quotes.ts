import { z } from 'zod';
import { RENOVATION_CATEGORY_KEYS, renovationCategory, type RenovationCategoryKey } from './categories';

/**
 * The buyer's own quotes, compared (ADR 0080, C3 decision 4) — the only figures Renovation AI shows, and every
 * one of them typed by the buyer. All arithmetic is here, in whole cents: no float ever carries money, and the
 * model never adds, compares or rounds anything (#4). The AI may only describe what one quote INCLUDES that
 * another does not, from the buyer's own words.
 */

/** Good practice for any building work, and the page says why: a single quote has nothing to compare it with. */
export const MIN_QUOTES = 3;
export const MAX_QUOTES = 60;
/** Ten million dollars in cents — above any home renovation, below anything a typo could make dangerous. */
const MAX_CENTS = 1_000_000_000;

/** "$38,500", "38500", "38,500.50" → cents. Anything else → null. Never parses "38.5k": a quote is written out. */
export function readDollarsToCents(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : null;
  const s = (raw ?? '').trim().replace(/[$,\s]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents > 0 && cents <= MAX_CENTS ? cents : null;
}

export const quoteSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    category: z.enum(RENOVATION_CATEGORY_KEYS),
    trade: z.string().trim().min(1).max(80),
    amountCents: z.number().int().positive().max(MAX_CENTS),
    /** What the quote covers, in the buyer's words (or the quote's). */
    includes: z.string().trim().max(500).default(''),
  })
  .strict();
export type Quote = z.infer<typeof quoteSchema>;

export const quotesSchema = z
  .array(quoteSchema)
  .max(MAX_QUOTES)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, { message: 'Each quote needs its own id' });

export type QuoteGroup = {
  category: RenovationCategoryKey;
  name: string;
  quotes: Quote[];
  lowest: Quote;
  highest: Quote;
  /** Highest minus lowest, in cents; 0 with one quote. */
  spreadCents: number;
  /** Fewer than MIN_QUOTES for this work. */
  needMoreQuotes: boolean;
};

export type QuoteComparison = {
  groups: QuoteGroup[];
  /** The cheapest quote for each piece of work, added up. */
  lowestTotalCents: number;
  /** The dearest quote for each piece of work, added up. */
  highestTotalCents: number;
  /** Pieces of work with fewer than MIN_QUOTES. */
  needMoreQuotes: RenovationCategoryKey[];
};

/**
 * Group by kind of work (in the catalog's order), cheapest first within each; ties broken by id so the order
 * never depends on how they were typed. Pure.
 */
export function compareQuotes(input: readonly Quote[]): QuoteComparison {
  const quotes = quotesSchema.parse(input);
  const groups: QuoteGroup[] = [];
  for (const category of RENOVATION_CATEGORY_KEYS) {
    const own = quotes.filter((q) => q.category === category).sort((a, b) => a.amountCents - b.amountCents || a.id.localeCompare(b.id));
    if (!own.length) continue;
    const lowest = own[0]!;
    const highest = own[own.length - 1]!;
    groups.push({ category, name: renovationCategory(category).name, quotes: own, lowest, highest, spreadCents: highest.amountCents - lowest.amountCents, needMoreQuotes: own.length < MIN_QUOTES });
  }
  return {
    groups,
    lowestTotalCents: groups.reduce((sum, g) => sum + g.lowest.amountCents, 0),
    highestTotalCents: groups.reduce((sum, g) => sum + g.highest.amountCents, 0),
    needMoreQuotes: groups.filter((g) => g.needMoreQuotes).map((g) => g.category),
  };
}

/** Cents as Australian dollars: whole dollars unless there are cents. Display only. */
export function formatCents(cents: number): string {
  const whole = cents % 100 === 0;
  return (cents / 100).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
}
