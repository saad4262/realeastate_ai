import { FinancePage, financeParams } from '@/components/deals/finance-page';

/** Finance — commission earned, expected and paid out (ADR 0064). Shared by both consoles; the period and grouping are in the URL. */
export default async function Page({ searchParams }: { searchParams: Promise<{ period?: string; by?: string }> }) {
  return <FinancePage surface="agent" {...financeParams(await searchParams)} />;
}
