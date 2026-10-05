/**
 * The phone key: digits only, an Australian number in international form.
 *
 * The SAME rule as `public.au_phone_key` in migration 0020, which computes
 * `contact.phone_key`. This copy exists so a phone number typed into the
 * directory search finds the same key Postgres stored; `pnpm smoke` holds the
 * two to identical answers on a list of shapes. Change both or neither.
 *
 * Used for duplicate SUGGESTIONS and search only — never to merge two people
 * automatically: a family shares a landline, and two emails are two people
 * until an admin says otherwise (the user's decision, 2026-10-05).
 */
export function auPhoneKey(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  if (d.startsWith('610') && d.length === 12) return `61${d.slice(3)}`;
  if (d.startsWith('61') && d.length === 11) return d;
  if (d.startsWith('0') && d.length === 10) return `61${d.slice(1)}`;
  if (d.length === 9 && /^[23478]/.test(d)) return `61${d}`;
  return d;
}

/** The shapes the smoke suite asks both implementations about. */
export const PHONE_KEY_SAMPLES = [
  '0412 345 678',
  '+61 412 345 678',
  '+61 (0)412 345 678',
  '412345678',
  '(03) 9555 1234',
  '03 9555 1234',
  '+44 20 7946 0958',
  '123',
  '',
] as const;
