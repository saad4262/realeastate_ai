/**
 * Scripts refuse the production database unless it is named on the command line (PRODUCTION-PLAN 0.2).
 *
 * Matched by Supabase project ref, not host: dev and production share the pooler host
 * (aws-0-ap-southeast-2.pooler.supabase.com) and differ only in the user `postgres.<ref>`.
 * PRODUCTION_DB_REFS lists production refs, comma-separated. It defaults to the live project, whose
 * ref is public anyway (it is in NEXT_PUBLIC_SUPABASE_URL), so a laptop that never set it is safe too.
 * The apps never call this: only one-off scripts, migrations and smoke.
 */
const LIVE_REF = 'xjklpoyxcvnlhjlxasmv';

export function productionRefusal(url: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const refs = (env.PRODUCTION_DB_REFS ?? LIVE_REF).split(',').map((r) => r.trim()).filter(Boolean);
  const ref = url ? refs.find((r) => url.includes(r)) : undefined;
  if (!ref || env.CONFIRM_PRODUCTION?.trim() === ref) return null;
  return `Refusing: this is the PRODUCTION database (${ref}). If you mean it, re-run with CONFIRM_PRODUCTION=${ref}`;
}

export function assertNotProduction(url: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const refusal = productionRefusal(url, env);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
