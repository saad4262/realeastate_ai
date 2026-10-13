import { ImportDetail } from '@/components/imports/import-detail';
import { requireConsoleAccess } from '../../../../../lib/require-console-access';

/** One contacts import (ADR 0029 amendment): its data is loaded by core, as this person. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireConsoleAccess('agency');
  const { id } = await params;
  return <ImportDetail id={id} listingsHref="/customers" />;
}
