import { z } from 'zod';

/**
 * Env validation for the monorepo.
 * Apps may boot with placeholders; DATABASE_URL is required only when @repo/db connects.
 */
export const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  NEXT_PUBLIC_WEB_URL: z.string().url().default('http://web.lvh.me:3000'),
  NEXT_PUBLIC_AGENT_URL: z.string().url().default('http://agents.lvh.me:3001'),
  NEXT_PUBLIC_AGENCY_URL: z.string().url().default('http://agency.lvh.me:3001'),
  COOKIE_DOMAIN: z.string().default('.lvh.me'),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model for the consumer property chat. Overridable without a code change. */
  ANTHROPIC_CHAT_MODEL: z.string().default('claude-opus-5'),
  /**
   * Turns one process will serve in a day before /chat starts refusing.
   *
   * The per-IP limiter is a ceiling on accidental cost; this is the ceiling on
   * deliberate cost. Neither is a security control — the only real backstop is
   * a spend cap set in the Anthropic console.
   */
  AI_CHAT_DAILY_TURN_CAP: z.coerce.number().int().positive().default(2000),
  /**
   * The Supabase Storage bucket uploaded images live in.
   *
   * Public, so reads need no signature and a URL can sit in an ISR-cached page
   * and a CDN without expiring. Writes are a different story: the bucket has no
   * RLS insert policy at all, so the anon key cannot put a byte in it. Every
   * upload goes through a signed URL the server issues only after can() has
   * agreed — see packages/core/src/media.
   *
   * Public on `NEXT_PUBLIC_` is deliberate: the browser builds image URLs from
   * it. The bucket name is not a secret; the service role key is, and that
   * never leaves the server.
   */
  NEXT_PUBLIC_SUPABASE_MEDIA_BUCKET: z.string().default('media'),
  /**
   * R2 was the original plan for media and is still where this should end up —
   * see CLAUDE.md. These stay declared and optional so the move is a change of
   * one resolver rather than a change of schema: `media.storage_key` holds a
   * KEY, never a URL, precisely so the host can be swapped underneath it.
   */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  /**
   * Where uploaded media is read back from — an r2.dev subdomain or a custom
   * domain on the bucket. Separate from the S3 API endpoint, which is signed
   * and not something a browser can fetch.
   */
  NEXT_PUBLIC_R2_PUBLIC_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  /** Agent invite link lifetime. Read in packages/core/src/team/invite-agent.ts. */
  AGENT_INVITE_TTL_MINUTES: z.coerce.number().int().positive().max(20160).default(120),

  /**
   * Scheduled search alerts. See docs/adr/0010.
   *
   * The three ALERT_SENDER_* values are not decoration: the Spam Act 2003
   * requires a commercial electronic message to identify its sender and give
   * a way to reach them, so an alert email cannot legally be built without
   * them. `buildScheduleDigestEmail` throws rather than sending one that
   * cannot — an email with no sender identity is worse than no email.
   */
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_SENDER_NAME: z.string().optional(),
  ALERT_SENDER_ADDRESS: z.string().optional(),
  /** HMAC key for unsubscribe links. No default — a default is a forgeable link. */
  ALERT_UNSUBSCRIBE_SECRET: z.string().optional(),
  /** Shared secret on the cron endpoint. Unset means the endpoint refuses everything. */
  CRON_SECRET: z.string().optional(),
  /**
   * Durable spend ceilings for scheduled runs, in USD over a trailing 24h.
   *
   * The chat's existing caps are in-process Maps keyed on an IP address; a
   * cron tick has neither, so neither applies to it. These are queried from
   * `ai_run` and therefore survive a restart and are shared across processes.
   */
  AI_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(5),
  AI_DAILY_BUDGET_USD_PER_USER: z.coerce.number().nonnegative().default(0.25),
  /** Build and record every digest, send none. For a preview deployment. */
  ALERTS_DRY_RUN: z.string().optional(),

  /**
   * Was read straight from process.env in apps/web/app/api/revalidate/route.ts
   * and declared nowhere, so this schema was only ever half the story.
   */
  REVALIDATE_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

/** Fail fast when a database connection is required (M0+). */
export function requireDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const url = source.DATABASE_URL;
  if (!url || url.includes('YOUR_PASSWORD')) {
    throw new Error(
      'DATABASE_URL is required (replace YOUR_PASSWORD with the Supabase DB password)',
    );
  }
  return url;
}

export function requireDirectUrl(source: NodeJS.ProcessEnv = process.env): string {
  const url = source.DIRECT_URL;
  if (!url || url.includes('YOUR_PASSWORD')) {
    throw new Error(
      'DIRECT_URL is required (replace YOUR_PASSWORD with the Supabase DB password)',
    );
  }
  return url;
}

/**
 * The Anthropic key, when something is about to call the model.
 *
 * Deliberately not checked at module load: the consumer site must boot and
 * serve every other page with no key set. Only /chat asks, and it turns this
 * into a 503 with a readable reason rather than a stack trace.
 */
export function requireAnthropicKey(source: NodeJS.ProcessEnv = process.env): string {
  const key = source.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is required for the AI chat');
  }
  return key;
}

export function requireSupabasePublic(source: NodeJS.ProcessEnv = process.env): {
  url: string;
  publishableKey: string;
} {
  const url = source.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required');
  }
  return { url, publishableKey };
}
