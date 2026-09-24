import { and, eq, like } from 'drizzle-orm';
import { agency, membership, office, type Db } from '@repo/db';
import { ensureAppUser } from '../identity/ensure-app-user';
import {
  registerAgencySchema,
  slugifyAgency,
  type RegisterAgencyInput,
} from './register-schema';

/** The signed-in Supabase account. Never accepted from a client argument (ADR 0006). */
export type RegisteringAccount = {
  userId: string;
  email: string;
};

export type RegisterAgencyResult = {
  agencyId: string;
  officeId: string;
  membershipId: string;
  slug: string;
};

export class AlreadyMemberError extends Error {
  constructor() {
    super('This account already belongs to an agency');
    this.name = 'AlreadyMemberError';
  }
}

/** Pick a free slug. The unique constraint on agency.slug is still the real guard. */
async function allocateSlug(db: Db, name: string): Promise<string> {
  const base = slugifyAgency(name);
  const taken = await db
    .select({ slug: agency.slug })
    .from(agency)
    .where(like(agency.slug, `${base}%`));

  const used = new Set(taken.map((r) => r.slug));
  if (!used.has(base)) return base;

  for (let n = 2; n < 200; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate an agency slug');
}

/**
 * Create an agency and make the signed-in account its owner, in one transaction:
 * agency + office + user mirror + membership(owner, active).
 *
 * No can() check — the caller has no membership yet, which is the point.
 * Authorization for everything afterwards flows from the owner membership this writes.
 */
export async function registerAgency(
  db: Db,
  account: RegisteringAccount,
  raw: unknown,
): Promise<RegisterAgencyResult> {
  const input: RegisterAgencyInput = registerAgencySchema.parse(raw);

  const existing = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.userId, account.userId),
        eq(membership.status, 'active'),
      ),
    )
    .limit(1);

  if (existing[0]) {
    throw new AlreadyMemberError();
  }

  const slug = await allocateSlug(db, input.agencyName);

  return db.transaction(async (tx) => {
    await ensureAppUser(tx as unknown as Db, {
      id: account.userId,
      email: account.email,
      name: input.ownerName,
      phone: input.phone,
    });

    const [ag] = await tx
      .insert(agency)
      .values({
        name: input.agencyName,
        slug,
        abn: input.abn,
        plan: 'trial',
        status: 'trial',
      })
      .returning({ id: agency.id });

    if (!ag) throw new Error('Failed to create agency');

    const [off] = await tx
      .insert(office)
      .values({
        agencyId: ag.id,
        name: input.officeName,
        slug: slugifyAgency(input.officeName),
        address: input.officeAddress,
        phone: input.phone,
      })
      .returning({ id: office.id });

    if (!off) throw new Error('Failed to create office');

    const [mem] = await tx
      .insert(membership)
      .values({
        userId: account.userId,
        agencyId: ag.id,
        officeId: off.id,
        role: 'owner',
        status: 'active',
      })
      .returning({ id: membership.id });

    if (!mem) throw new Error('Failed to create owner membership');

    return { agencyId: ag.id, officeId: off.id, membershipId: mem.id, slug };
  });
}
