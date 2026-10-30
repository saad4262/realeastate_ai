'use server';

import { revalidatePath } from 'next/cache';
import {
  connectTwilio,
  disconnectTwilio,
  getMyPhone,
  getNumberForAgent,
  markMissedCallHandled,
  PhoneError,
  saveMissedCallSettings,
  setUpAiCalls,
  voiceFromEnv,
  type MissedCallSettingsInput,
  phoneDepsFromEnv,
  refreshCallerId,
  refreshKyc,
  releaseAgentNumber,
  sendSms,
  smsLimitFromEnv,
  startCallerIdCheck,
  startForwardingTest,
  type ConnectTwilioInput,
} from '@repo/core/phone';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Phone & SMS actions (docs/adr/0070). The actor is rebuilt from the session; every decision is
 * can()'s inside packages/core, and every Twilio call is core's too. A refusal comes back as words.
 */

export type PhoneActionResult =
  | { ok: true; code?: string | null; verified?: boolean; status?: string; id?: string }
  | { ok: false; error: string };

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadActor(userId);
  if (!loaded) throw new PhoneError('forbidden', 'Database is not configured.');
  return loaded;
}

function refresh() {
  for (const p of ['/settings/phone', '/my-phone', '/inbox/texts', '/my-inbox/texts']) revalidatePath(p);
}

function failure(err: unknown, fallback: string): PhoneActionResult {
  if (err instanceof PhoneError) return { ok: false, error: err.message };
  console.error('[phone] action failed', err instanceof Error ? err.message : err);
  return { ok: false, error: fallback };
}

export async function connectTwilioAction(input: ConnectTwilioInput): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const { kycStatus } = await connectTwilio(getConsoleDb(), who, input, phoneDepsFromEnv());
    refresh();
    return { ok: true, status: kycStatus };
  } catch (err) {
    return failure(err, 'Could not connect Twilio');
  }
}

export async function disconnectTwilioAction(): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    await disconnectTwilio(getConsoleDb(), who);
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err, 'Could not disconnect Twilio');
  }
}

export async function refreshKycAction(): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const { kycStatus } = await refreshKyc(getConsoleDb(), who, phoneDepsFromEnv());
    refresh();
    return { ok: true, status: kycStatus };
  } catch (err) {
    return failure(err, 'Could not check with Twilio');
  }
}

export async function getNumberAction(agentUserId: string): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const n = await getNumberForAgent(getConsoleDb(), who, agentUserId, phoneDepsFromEnv());
    refresh();
    return { ok: true, id: n.id, status: n.display };
  } catch (err) {
    return failure(err, 'Could not get a number');
  }
}

export async function releaseNumberAction(numberId: string): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    await releaseAgentNumber(getConsoleDb(), who, numberId, phoneDepsFromEnv());
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err, 'Could not release the number');
  }
}

export async function startCallerIdAction(mobile: string): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const r = await startCallerIdCheck(getConsoleDb(), who, mobile, phoneDepsFromEnv());
    refresh();
    return { ok: true, code: r.code, verified: r.verified };
  } catch (err) {
    return failure(err, 'Could not start the check');
  }
}

export async function refreshCallerIdAction(): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const r = await refreshCallerId(getConsoleDb(), who, phoneDepsFromEnv());
    if (r.status === 'verified') refresh();
    return { ok: true, status: r.status };
  } catch (err) {
    return failure(err, 'Could not check with Twilio');
  }
}

export async function startForwardingTestAction(): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const r = await startForwardingTest(getConsoleDb(), who, phoneDepsFromEnv());
    refresh();
    return { ok: true, status: r.status };
  } catch (err) {
    return failure(err, 'Could not start the test call');
  }
}

/** The page polls this while a test call rings. */
export async function forwardingTestStatusAction(): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const me = await getMyPhone(getConsoleDb(), who, phoneDepsFromEnv());
    const status = me.lastTest?.status ?? 'none';
    if (status === 'passed') refresh();
    return { ok: true, status };
  } catch (err) {
    return failure(err, 'Could not read the test');
  }
}

export async function setUpAiCallsAction(): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const r = await setUpAiCalls(getConsoleDb(), who, phoneDepsFromEnv(), voiceFromEnv().voice);
    refresh();
    return { ok: true, status: r.failed ? `${r.registered} ready, ${r.failed} refused` : `${r.registered} numbers ready` };
  } catch (err) {
    return failure(err, 'Could not set up AI calls');
  }
}

export async function saveMissedCallSettingsAction(input: MissedCallSettingsInput): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    await saveMissedCallSettings(getConsoleDb(), who, input);
    revalidatePath('/missed-calls/settings');
    return { ok: true };
  } catch (err) {
    return failure(err, 'Could not save the settings');
  }
}

export async function markMissedCallHandledAction(callId: string, handled: boolean): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    await markMissedCallHandled(getConsoleDb(), who, callId, handled);
    for (const p of ['/missed-calls', '/my-missed-calls']) revalidatePath(p);
    return { ok: true };
  } catch (err) {
    return failure(err, 'Could not change it');
  }
}

export async function sendSmsAction(to: string, body: string): Promise<PhoneActionResult> {
  const who = await actor();
  try {
    const { id } = await sendSms(getConsoleDb(), who, { to, body }, { ...phoneDepsFromEnv(), limitPerDay: smsLimitFromEnv() });
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not send the text');
  }
}
