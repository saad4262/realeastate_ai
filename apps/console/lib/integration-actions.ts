'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  disconnectIntegration,
  IntegrationError,
  isIntegrationProvider,
  startConnect,
  tokenKeysFromEnv,
} from '@repo/core/integrations';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Connect / Disconnect (docs/adr/0020). The actor is rebuilt from the session;
 * can() decides inside packages/core. Connect leaves the console for the
 * provider (the stub consent page in dev) with a state signed for THIS user.
 * No action here ever returns a token.
 */

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadActor(userId);
  if (!loaded) throw new IntegrationError('forbidden', 'Database is not configured.');
  return loaded;
}

async function settingsPath(): Promise<{ path: string; surface: 'agency' | 'agent' }> {
  const surface = (await headers()).get('x-console-surface') === 'agency' ? 'agency' : 'agent';
  return { surface, path: surface === 'agency' ? '/settings/integrations' : '/my-integrations' };
}

function parse(formData: FormData) {
  const provider = formData.get('provider');
  const ownerType = formData.get('ownerType');
  if (!isIntegrationProvider(provider) || (ownerType !== 'user' && ownerType !== 'agency')) {
    throw new IntegrationError('invalid', 'Unknown integration');
  }
  return { provider, ownerType } as const;
}

/** Form action: go to the provider. Errors come back to the Integrations page as ?error=. */
export async function connectIntegrationAction(formData: FormData): Promise<void> {
  const who = await actor();
  const { path, surface } = await settingsPath();
  let url: string;
  try {
    const keys = tokenKeysFromEnv();
    if (!keys) throw new IntegrationError('unavailable', 'Integrations are not set up on this server (INTEGRATION_TOKEN_KEY).');
    url = startConnect(who, keys, { ...parse(formData), surface });
  } catch (err) {
    const message = err instanceof IntegrationError ? err.message : 'Could not start connecting';
    redirect(`${path}?error=${encodeURIComponent(message)}`);
  }
  redirect(url);
}

/** Form action: delete the connection and every token it held. */
export async function disconnectIntegrationAction(formData: FormData): Promise<void> {
  const who = await actor();
  const { path } = await settingsPath();
  let message: string;
  try {
    const { provider, ownerType } = parse(formData);
    const { removed } = await disconnectIntegration(getConsoleDb(), who, { provider, ownerType });
    message = removed ? `disconnected=${provider}` : `error=${encodeURIComponent('It was already disconnected')}`;
  } catch (err) {
    message = `error=${encodeURIComponent(err instanceof IntegrationError ? err.message : 'Could not disconnect')}`;
  }
  revalidatePath('/settings/integrations');
  revalidatePath('/my-integrations');
  redirect(`${path}?${message}`);
}
