import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Integration tokens at rest (ADR 0020): AES-256-GCM, a fresh 96-bit IV per
 * value, and `<row id>:<column>` as additional authenticated data — so a
 * ciphertext copied into another row or column does not decrypt.
 *
 * The key is `INTEGRATION_TOKEN_KEY` (32 bytes, base64) — never stored in the
 * database, never logged. `INTEGRATION_TOKEN_KEY_PREVIOUS` still decrypts
 * during a rotation. Errors here never carry a value: "could not decrypt" is
 * the whole message, whatever went wrong.
 *
 * Stored form: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url), where keyId is
 * a short hash of the key, so a rotation can tell which key wrote a value.
 */

export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenKeyError';
  }
}

type Key = { id: string; bytes: Buffer };

function parseKey(raw: string | undefined): Key | null {
  if (!raw?.trim()) return null;
  const bytes = Buffer.from(raw.trim(), 'base64');
  if (bytes.length !== 32) throw new TokenKeyError('INTEGRATION_TOKEN_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return { id: createHash('sha256').update(bytes).digest('base64url').slice(0, 8), bytes };
}

export type TokenKeys = { current: Key; previous: Key | null };

/** The keys, or null when integrations are not configured on this server. */
export function tokenKeysFromEnv(env: NodeJS.ProcessEnv = process.env): TokenKeys | null {
  const current = parseKey(env.INTEGRATION_TOKEN_KEY);
  if (!current) return null;
  return { current, previous: parseKey(env.INTEGRATION_TOKEN_KEY_PREVIOUS) };
}

/** A separate key for signing OAuth state, derived — so one secret to set, two keys in use. */
export function stateKey(keys: TokenKeys): Buffer {
  return Buffer.from(hkdfSync('sha256', keys.current.bytes, Buffer.alloc(0), 'oauth-state-v1', 32));
}

/** `twilio_api_secret`: an agency's own Twilio API key secret on `phone_account` (ADR 0070). */
export type TokenSlot = { rowId: string; column: 'access_token' | 'refresh_token' | 'twilio_api_secret' | 'sip_password' };

const aad = (slot: TokenSlot) => Buffer.from(`${slot.rowId}:${slot.column}`, 'utf8');

export function encryptToken(plain: string, slot: TokenSlot, keys: TokenKeys): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.current.bytes, iv);
  cipher.setAAD(aad(slot));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', keys.current.id, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptToken(stored: string, slot: TokenSlot, keys: TokenKeys): string {
  const parts = stored.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new TokenKeyError('Could not decrypt a stored token');
  const [, keyId, iv, tag, body] = parts as [string, string, string, string, string];
  const key = [keys.current, keys.previous].find((k) => k && k.id === keyId);
  if (!key) throw new TokenKeyError('Could not decrypt a stored token (it was written with a key this server does not have)');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(slot));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Never the value, never the cause's text.
    throw new TokenKeyError('Could not decrypt a stored token');
  }
}
