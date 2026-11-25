import type { Metadata } from 'next';
import { DataExportPage } from '@/components/exports/data-export-page';
import { requireConsoleAccess } from '../../../lib/require-console-access';

export const metadata: Metadata = { title: 'Download your data' };

/** ADR 0101 phase 3: an agent's full export — their own book, as their screens show it. */
export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { actor } = await requireConsoleAccess('agent');
  const { error } = await searchParams;
  return <DataExportPage actor={actor} page="/my-data" {...(error ? { error } : {})} />;
}
