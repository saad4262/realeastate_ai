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
  /**
   * Model overrides, read by getModel in packages/ai/src/models.ts. No default
   * here on purpose: the fallback is DEFAULT_CHAT_MODEL in that file, and a
   * second default in this schema had already drifted from it.
   */
  ANTHROPIC_CHAT_MODEL: z.string().optional(),
  /** The saved-search digest's summary paragraph. Falls back like the chat's. */
  ANTHROPIC_ALERT_MODEL: z.string().optional(),
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
   * R2 was the original plan for media and may still be where this ends up —
   * see docs/adr/0009. Nothing reads these today. These stay declared and optional so the move is a change of
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
  /**
   * Daily caps on email the PLATFORM composes and sends for somebody — an
   * appointment invitation now, a skill's template email later (CRM plan).
   * A person's own reply in a conversation never counts. Read in
   * packages/core/src/email/limits.ts; adjustable per deployment until an
   * admin setting replaces them (Phase 5).
   */
  /**
   * Integrations (docs/adr/0020). INTEGRATION_TOKEN_KEY: 32 bytes, base64
   * (`openssl rand -base64 32`) — encrypts stored OAuth tokens and, through a
   * derived key, signs the OAuth state. Never in the database, never logged.
   * _PREVIOUS still decrypts during a rotation. Unset: integrations cannot be
   * connected. INTEGRATION_OAUTH_RETURN_BASE: where providers send people back
   * (dev: http://localhost:3001); unset = the agency console URL.
   * INTEGRATIONS_STUB=1: a local pretend provider, never in production.
   */
  /** Skill model per tier (docs/adr/0021). Unset = the defaults in packages/ai/src/models.ts. */
  ANTHROPIC_SKILL_SUMMARY_MODEL: z.string().optional(),
  ANTHROPIC_SKILL_AGENT_MODEL: z.string().optional(),
  ANTHROPIC_SKILL_HARD_MODEL: z.string().optional(),
  INTEGRATION_TOKEN_KEY: z.string().optional(),
  INTEGRATION_TOKEN_KEY_PREVIOUS: z.string().optional(),
  INTEGRATION_OAUTH_RETURN_BASE: z.string().url().optional(),
  INTEGRATIONS_STUB: z.string().optional(),
  /**
   * Real providers (Phase 3b). A provider with both its id and secret set is
   * connected for real; otherwise the stub (dev) or nothing. Server-only.
   * ZOOM_OAUTH_RETURN_BASE: Zoom's own return base (dev: an https tunnel —
   * Zoom refuses localhost); unset = INTEGRATION_OAUTH_RETURN_BASE.
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  ZOOM_OAUTH_CLIENT_ID: z.string().optional(),
  ZOOM_OAUTH_CLIENT_SECRET: z.string().optional(),
  ZOOM_OAUTH_RETURN_BASE: z.string().url().optional(),
  /**
   * Template email (docs/adr/0022). EMAIL_DEV_ALLOWLIST: outside production,
   * only these addresses / @domains receive bulk email; unset = nobody.
   * Ignored in production. The rest are limits with the agreed defaults.
   */
  EMAIL_DEV_ALLOWLIST: z.string().optional(),
  EMAIL_LIMIT_PER_BATCH: z.coerce.number().int().positive().default(20),
  EMAIL_REPEAT_DAYS: z.coerce.number().int().positive().default(7),
  EMAIL_SEND_DELAY_MS: z.coerce.number().int().min(0).default(500),
  EMAIL_LIMIT_PER_AGENT_DAY: z.coerce.number().int().positive().default(50),
  EMAIL_LIMIT_PER_AGENCY_DAY: z.coerce.number().int().positive().default(200),
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
   * Email conversations in the app (docs/adr/0016).
   *
   * MAIL_INBOUND_DOMAIN is the domain Resend receives on — its MX points at
   * Resend — e.g. `reply.example.com.au`. Every email sent from a conversation
   * carries a Reply-To on it, so a reply from Gmail lands back in the thread.
   * MAIL_REPLY_SECRET signs those addresses; no default, a default is a
   * forgeable address. Both unset: sending still works and replies go to the
   * agent's own email, the way they did before.
   *
   * RESEND_WEBHOOK_SECRET (`whsec_…`) verifies /api/mail/inbound. Unset means
   * the endpoint refuses everything, like CRON_SECRET.
   */
  MAIL_INBOUND_DOMAIN: z.string().optional(),
  MAIL_REPLY_SECRET: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),

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
