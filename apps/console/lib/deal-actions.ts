'use server';

import { revalidatePath } from 'next/cache';
import {
  addDealCondition,
  DealError,
  markCommissionPaid,
  setDealCommission,
  type CommissionInput,
  moveDealStage,
  removeDealCondition,
  settleDeal,
  updateDealCondition,
  updateDealDetails,
  type DealDetailsInput,
  type DealStage,
  type SettleInput,
} from '@repo/core/deals';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The Deal tab's actions (ADR 0063). The actor is rebuilt from the session with the listings it is named
 * on, because `listing:edit` decides who may change a deal; core asks again on every call.
 */

export type DealActionResult = { ok: true; tagged?: number } | { ok: false; error: string };

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadListingActor(userId);
  if (!loaded) throw new DealError('forbidden', 'Database is not configured.');
  return loaded;
}

function refresh() {
  revalidatePath('/pipeline');
  revalidatePath('/my-pipeline');
  revalidatePath('/live-listings', 'layout');
  revalidatePath('/listings', 'layout');
}

async function run(fn: () => Promise<DealActionResult>, fallback: string): Promise<DealActionResult> {
  try {
    const r = await fn();
    refresh();
    return r;
  } catch (err) {
    if (err instanceof DealError) return { ok: false, error: err.message };
    if (err && typeof err === 'object' && 'issues' in err) return { ok: false, error: 'Check the fields — one of them is not valid.' };
    console.error('[deals] action failed', err instanceof Error ? err.message : err);
    return { ok: false, error: fallback };
  }
}

export async function updateDealAction(dealId: string, input: DealDetailsInput): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => (await updateDealDetails(getConsoleDb(), who, String(dealId), input), { ok: true }), 'Could not save the sale details');
}

export async function moveDealStageAction(dealId: string, to: DealStage): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => (await moveDealStage(getConsoleDb(), who, String(dealId), to), { ok: true }), 'Could not move the deal');
}

export async function settleDealAction(dealId: string, input: SettleInput): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => ({ ok: true, tagged: (await settleDeal(getConsoleDb(), who, String(dealId), input)).tagged }), 'Could not settle the deal');
}

export async function addDealConditionAction(dealId: string, label: string, dueOn: string | null): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => (await addDealCondition(getConsoleDb(), who, String(dealId), { label, dueOn }), { ok: true }), 'Could not add the condition');
}

export async function updateDealConditionAction(conditionId: string, input: { dueOn?: string | null; done?: boolean }): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => (await updateDealCondition(getConsoleDb(), who, String(conditionId), input), { ok: true }), 'Could not change the condition');
}

export async function removeDealConditionAction(conditionId: string): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => (await removeDealCondition(getConsoleDb(), who, String(conditionId)), { ok: true }), 'Could not remove the condition');
}

/** ADR 0064: the agency sets the commission (owners and admins; core asks `deal:commission` again). */
export async function setCommissionAction(dealId: string, input: CommissionInput): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => {
    await setDealCommission(getConsoleDb(), who, String(dealId), input);
    revalidatePath('/finance');
    revalidatePath('/my-commission');
    return { ok: true };
  }, 'Could not save the commission');
}

export async function markCommissionPaidAction(dealId: string, paidOn: string | null): Promise<DealActionResult> {
  const who = await actor();
  return run(async () => {
    await markCommissionPaid(getConsoleDb(), who, String(dealId), paidOn);
    revalidatePath('/finance');
    revalidatePath('/my-commission');
    return { ok: true };
  }, 'Could not mark it paid');
}
