import { describe, expect, it } from 'vitest';
import { auPhoneKey } from './phone';

describe('the phone key', () => {
  it('gives every way of writing one mobile the same key', () => {
    for (const shape of ['0412 345 678', '+61 412 345 678', '+61 (0)412 345 678', '412345678', '0412-345-678']) {
      expect(auPhoneKey(shape)).toBe('61412345678');
    }
  });

  it('handles a landline with an area code', () => {
    expect(auPhoneKey('(03) 9555 1234')).toBe('61395551234');
  });

  it('leaves a foreign number as its digits', () => {
    expect(auPhoneKey('+44 20 7946 0958')).toBe('442079460958');
  });

  it('refuses something too short to match anybody on', () => {
    expect(auPhoneKey('123')).toBeNull();
    expect(auPhoneKey('')).toBeNull();
    expect(auPhoneKey(null)).toBeNull();
  });
});
