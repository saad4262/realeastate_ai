import { NextResponse, type NextRequest } from 'next/server';
import { ExportError, signExportPart } from '@repo/core/exports';
import { apiError } from '@repo/core/http/api-error';
import { getConsoleDb } from '../../../../../../lib/db';
import { loadActor } from '../../../../../../lib/load-actor';
import { actionUserId } from '../../../../../../lib/auth-account';

/** One part of a full export (ADR 0101 phase 3): core checks it is this member's, ready and kept, then signs 60 s. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; part: string }> }) {
  const userId = await actionUserId();
  const actor = userId ? await loadActor(userId) : null;
  if (!actor?.agencyId) return apiError(401, 'Not signed in');
  const { id, part } = await params;
  try {
    const url = await signExportPart(getConsoleDb(), actor, id, decodeURIComponent(part));
    return NextResponse.redirect(url, { status: 303, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof ExportError) return apiError(404, err.message);
    throw err;
  }
}
