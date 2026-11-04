import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Automation's unsubscribe links (ADR 0080, C8 decision 10), on the same /unsubscribe route and secret as the others,
 * each its own token kind so none can be read as another: `a.` pauses ONE automation (signed over its id and its
 * owner), `m.` switches the buyer's Automation skill off (the email's one-click List-Unsubscribe).
 */

const b64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sig = (what: string, secret: string) => b64(createHmac('sha256', secret).update(what).digest());
const UUID = /^[0-9a-f-]{36}$/i;
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function signAutomationUnsubscribe(automationId: string, userId: string, secret: string): string {
  return `a.${b64(Buffer.from(`${automationId}:${userId}`, 'utf8'))}.${sig(`automation-optout:${automationId}:${userId}`, secret)}`;
}

export function verifyAutomationUnsubscribe(token: string, secret: string): { ok: true; automationId: string; userId: string } | { ok: false } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'a') return { ok: false };
  const [automationId, userId] = unb64(parts[1]!).toString('utf8').split(':');
  if (!automationId || !userId || !UUID.test(automationId) || !UUID.test(userId)) return { ok: false };
  return same(sig(`automation-optout:${automationId}:${userId}`, secret), parts[2]!) ? { ok: true, automationId, userId } : { ok: false };
}

export function signAutomationSkillUnsubscribe(userId: string, secret: string): string {
  return `m.${b64(Buffer.from(userId, 'utf8'))}.${sig(`automation-skill-optout:${userId}`, secret)}`;
}

export function verifyAutomationSkillUnsubscribe(token: string, secret: string): { ok: true; userId: string } | { ok: false } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'm') return { ok: false };
  const userId = unb64(parts[1]!).toString('utf8');
  if (!UUID.test(userId)) return { ok: false };
  return same(sig(`automation-skill-optout:${userId}`, secret), parts[2]!) ? { ok: true, userId } : { ok: false };
}

const link = (base: string, token: string) => `${base.replace(/\/$/, '')}/unsubscribe?t=${encodeURIComponent(token)}`;
export const automationUnsubscribeUrl = (base: string, automationId: string, userId: string, secret: string) => link(base, signAutomationUnsubscribe(automationId, userId, secret));
export const automationSkillUnsubscribeUrl = (base: string, userId: string, secret: string) => link(base, signAutomationSkillUnsubscribe(userId, secret));
