import { NextResponse, type NextRequest } from 'next/server';
import { contactListQuerySchema } from '@repo/core/contacts';
import { ExportError, QUICK_DATASETS, startQuickExport, type QuickDataset } from '@repo/core/exports';
import { getConsoleDb } from '../../../../lib/db';
import { loadActor } from '../../../../lib/load-actor';
import { actionUserId } from '../../../../lib/auth-account';
import { apiError } from '@repo/core/http/api-error';

/** Quick export as a CSV download (ADR 0101). Who gets which rows is core's: can() and the screens' scope helpers. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ dataset: string }> }) {
  const userId = await actionUserId();
  const actor = userId ? await loadActor(userId) : null;
  if (!actor?.agencyId) return apiError(401, 'Not signed in');
  const { dataset } = await params;
  if (!(QUICK_DATASETS as readonly string[]).includes(dataset)) return apiError(404, 'Not found');
  const sp = request.nextUrl.searchParams;
  // The directory's own filters, parsed by its own schema; anything unrecognised is dropped.
  const query = contactListQuerySchema.parse({
    q: sp.get('q') ?? undefined,
    role: sp.get('role') || undefined,
    source: sp.get('source') || undefined,
    assigned: sp.get('assigned') || undefined,
    archived: sp.get('archived') || undefined,
  });
  try {
    const { filename, chunks } = await startQuickExport(getConsoleDb(), actor, dataset as QuickDataset, query);
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const next = await chunks.next();
        if (next.done) c.close();
        else c.enqueue(enc.encode(next.value));
      },
      // A cut download still finishes the generator, so its audit row gets the count.
      async cancel() {
        await chunks.return(undefined);
      },
    });
    return new NextResponse(body, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof ExportError) return apiError(403, err.message);
    throw err;
  }
}
