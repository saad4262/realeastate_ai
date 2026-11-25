import type { Metadata } from 'next';
import { DataExportPage } from '@/components/exports/data-export-page';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

export const metadata: Metadata = { title: 'Download your data' };

/** ADR 0101 phase 3: an owner's or admin's full export — the whole agency, as their screens show it. */
export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { actor } = await requireConsoleAccess('agency');
  const { error } = await searchParams;
  return <DataExportPage actor={actor} page="/settings/data" {...(error ? { error } : {})} />;
}
