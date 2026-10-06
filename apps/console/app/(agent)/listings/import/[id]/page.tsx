import { ImportDetail } from '@/components/imports/import-detail';
import { requireConsoleAccess } from '../../../../../lib/require-console-access';

/** One CSV import (docs/adr/0029): its data is loaded by core, as this person. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireConsoleAccess('agent');
  const { id } = await params;
  return <ImportDetail id={id} listingsHref="/listings" />;
}
