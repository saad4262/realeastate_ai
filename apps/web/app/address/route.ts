import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auStateSchema } from '@repo/core/listings/schema';
import { findPublicPropertyAt } from '@repo/core/listings';
import { getWebDb } from '../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * The home page's Address tab lands here (ADR 0099).
 *
 * The address we have records for opens its property page (which itself
 * forwards to the live ad when there is one). Anything else — an address we
 * have never seen, a station, a geocoder outage — becomes homes for sale
 * within 2 km of the point, so the visitor always lands on something.
 */
const addressSchema = z.object({
  unit: z.string().trim().max(20).optional(),
  number: z.string().trim().max(20).optional(),
  street: z.string().trim().max(120).optional(),
  suburb: z.string().trim().min(1).max(120).optional(),
  state: auStateSchema.optional(),
  postcode: z.string().trim().regex(/^\d{3,4}$/).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

export async function GET(request: NextRequest) {
  const raw = Object.fromEntries(
    [...request.nextUrl.searchParams].filter(([, v]) => v.trim() !== ''),
  );
  const parsed = addressSchema.safeParse({ ...raw, state: raw.state?.toUpperCase() });
  const a = parsed.success ? parsed.data : {};
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);

  if (a.number && a.street && a.suburb && a.state && a.postcode) {
    try {
      const id = await findPublicPropertyAt(getWebDb(), {
        unit: a.unit,
        streetNumber: a.number,
        street: a.street,
        suburb: a.suburb,
        state: a.state,
        postcode: a.postcode,
      });
      if (id) return to(`/property/${id}`);
    } catch {
      // The database is down: the radius search below still has a page to show.
    }
  }

  if (a.lat !== undefined && a.lng !== undefined) {
    const params = new URLSearchParams({
      channel: 'sale',
      lat: a.lat.toFixed(6),
      lng: a.lng.toFixed(6),
      radius: '2',
    });
    return to(`/search?${params}`);
  }
  return to('/');
}
