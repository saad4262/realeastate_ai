import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, tokenKeysFromEnv } from './crypto';
import { signState, verifyState } from './state';
import { missingScopes } from './providers';

const key = () => randomBytes(32).toString('base64');
const keys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: key() } as NodeJS.ProcessEnv)!;
const slot = { rowId: '11111111-1111-1111-1111-111111111111', column: 'access_token' as const };

describe('token encryption', () => {
  it('round-trips, and never stores the plain text', () => {
    const stored = encryptToken('ya29.secret-token', slot, keys);
    expect(stored).not.toContain('secret-token');
    expect(stored.startsWith('v1.')).toBe(true);
    expect(decryptToken(stored, slot, keys)).toBe('ya29.secret-token');
  });

  it('uses a fresh IV every time', () => {
    expect(encryptToken('same', slot, keys)).not.toBe(encryptToken('same', slot, keys));
  });

  it('will not decrypt a value moved to another row or column', () => {
    const stored = encryptToken('ya29.secret', slot, keys);
    expect(() => decryptToken(stored, { ...slot, rowId: '22222222-2222-2222-2222-222222222222' }, keys)).toThrow();
    expect(() => decryptToken(stored, { ...slot, column: 'refresh_token' }, keys)).toThrow();
  });

  it('refuses a tampered value, and says nothing about it', () => {
    const stored = encryptToken('ya29.secret', slot, keys);
    const tampered = stored.slice(0, -2) + (stored.endsWith('A') ? 'BB' : 'AA');
    try {
      decryptToken(tampered, slot, keys);
      throw new Error('decrypted');
    } catch (err) {
      expect((err as Error).message).toBe('Could not decrypt a stored token');
      expect((err as Error).message).not.toContain('secret');
    }
  });

  it('still reads values written with the previous key during a rotation', () => {
    const old = key();
    const before = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: old } as NodeJS.ProcessEnv)!;
    const stored = encryptToken('ya29.old', slot, before);
    const after = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: key(), INTEGRATION_TOKEN_KEY_PREVIOUS: old } as NodeJS.ProcessEnv)!;
    expect(decryptToken(stored, slot, after)).toBe('ya29.old');
    const without = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: key() } as NodeJS.ProcessEnv)!;
    expect(() => decryptToken(stored, slot, without)).toThrow();
  });

  it('refuses a key of the wrong length, and treats none as "not configured"', () => {
    expect(() => tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: 'short' } as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
    expect(tokenKeysFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('OAuth state', () => {
  const input = {
    provider: 'zoom' as const,
    ownerType: 'user' as const,
    ownerId: '33333333-3333-3333-3333-333333333333',
    agencyId: '44444444-4444-4444-4444-444444444444',
    userId: '33333333-3333-3333-3333-333333333333',
    surface: 'agent' as const,
  };

  it('verifies what it signed', () => {
    expect(verifyState(signState(input, keys), keys)).toMatchObject(input);
  });

  it('refuses a forged, edited, foreign-key or expired state', () => {
    const token = signState(input, keys);
    const [body, sig] = token.split('.') as [string, string];
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), userId: input.agencyId })).toString('base64url');
    expect(verifyState(`${edited}.${sig}`, keys)).toBeNull();
    const otherKeys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: key() } as NodeJS.ProcessEnv)!;
    expect(verifyState(token, otherKeys)).toBeNull();
    expect(verifyState(signState(input, keys, Date.now() - 11 * 60 * 1000), keys)).toBeNull();
    expect(verifyState('garbage', keys)).toBeNull();
  });
});

describe('scope re-check', () => {
  it('names what a person unticked on the consent screen', () => {
    expect(missingScopes('zoom', ['user:read:user'])).toEqual(['meeting:write:meeting']);
    expect(missingScopes('google_calendar', ['https://www.googleapis.com/auth/calendar.events', 'openid', 'email'])).toEqual([]);
  });
});
