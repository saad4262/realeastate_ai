'use server';

import { PropertySummaryError, summarizeProperty, type CheckedPoint } from '@repo/core/properties';
import { propertySummarizerFromEnv } from '@repo/ai/property-summary';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * A property's summary (ADR 0065), on a button. The actor is rebuilt from the session; core checks the
 * address, the Property summaries switch and the budget, then every point. Nothing is saved.
 */

export type PropertySummaryResult = { ok: true; points: CheckedPoint[]; recordCount: number } | { ok: false; error: string };

export async function summarizePropertyAction(propertyId: string): Promise<PropertySummaryResult> {
  const userId = await requireActionUserId();
  const actor = await loadListingActor(userId);
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    const db = getConsoleDb();
    const r = await summarizeProperty(db, actor, String(propertyId), propertySummarizerFromEnv(db));
    return { ok: true, points: r.points, recordCount: r.recordCount };
  } catch (err) {
    if (err instanceof PropertySummaryError) return { ok: false, error: err.message };
    console.error('[property] summary action failed', err instanceof Error ? err.message : err);
    return { ok: false, error: 'The summary could not be written. Try again.' };
  }
}
