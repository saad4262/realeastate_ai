import { createHmac, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';

/**
 * A proposal the guide made and the buyer has not agreed to yet (ADR 0080, C8 decision 12) — a task, an automation, or
 * the listing a drafted message is for. The schedule draft's reasoning (schedules/draft.ts) applies unchanged: nothing
 * is written until the buyer presses Accept or Send, and the card carries the whole proposal, signed, so a browser can
 * read it and cannot change it. The token names its KIND and an expiry, so one kind can never be redeemed as another
 * and an old card stops working. No user id inside: the session decides whose it becomes.
 */

export type ProposalKind = 'task' | 'automation' | 'message';

const b64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Sorted keys, so the same proposal always signs to the same bytes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sign = (kind: ProposalKind, body: string, secret: string) => b64(createHmac('sha256', secret).update(`proposal:${kind}:${body}`).digest());

export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signProposal<T>(kind: ProposalKind, payload: T, secret: string, opts: { now?: Date; ttlMs?: number } = {}): string {
  const exp = (opts.now ?? new Date()).getTime() + (opts.ttlMs ?? PROPOSAL_TTL_MS);
  const body = canonical({ exp, payload });
  return `${kind}.${b64(Buffer.from(body, 'utf8'))}.${sign(kind, body, secret)}`;
}

/** The payload, when the token is this kind, unexpired, unaltered and the right shape; else null. */
export function readProposal<S extends z.ZodTypeAny>(kind: ProposalKind, token: string, schema: S, secret: string, opts: { now?: Date } = {}): z.infer<S> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== kind) return null;
  let body: string;
  try {
    body = unb64(parts[1]!).toString('utf8');
  } catch {
    return null;
  }
  const want = Buffer.from(sign(kind, body, secret));
  const got = Buffer.from(parts[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let parsed: { exp?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(body) as { exp?: unknown; payload?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.exp !== 'number' || parsed.exp < (opts.now ?? new Date()).getTime()) return null;
  const shaped = schema.safeParse(parsed.payload);
  return shaped.success ? shaped.data : null;
}
