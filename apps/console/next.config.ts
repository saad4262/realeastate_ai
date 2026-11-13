import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';
import { securityHeaders } from '@repo/core/http/security-headers';

const nextConfig: NextConfig = {
  /**
   * A second `next dev` on another port still writes to the same .next as the
   * one already running, which clobbers its manifests and leaves the live app
   * serving 404s for its own CSS. Throwaway servers set NEXT_DIST_DIR so they
   * build somewhere else entirely and never touch the running one.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  /** Clickjacking, sniffing, referrer, HSTS and a report-only CSP on every response (packages/core/src/http/security-headers.ts). */
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders('console') }];
  },
  transpilePackages: ['@repo/ui', '@repo/auth', '@repo/core', '@repo/db', '@repo/config', '@repo/ai'],
  /**
   * The Postgres parser behind open questions (ADR 0042 L1) is WebAssembly that reads its .wasm
   * from beside itself at run time — bundling would lose the file, so it stays a plain require,
   * and the file is traced into every server function explicitly.
   */
  serverExternalPackages: ['libpg-query'],
  outputFileTracingIncludes: { '/**': ['../../node_modules/.pnpm/libpg-query@*/node_modules/libpg-query/wasm/*'] },
  /**
   * How long a visited segment stays usable in the client router cache.
   *
   * At the 30s this used to be, clicking Team → Listings → Team refetched the
   * whole of Team again, one round trip to the database region per click. Two
   * minutes covers a normal stretch of clicking around, and every mutation
   * already calls router.refresh(), which clears the cache outright — so your
   * own changes are never the thing going stale. What can lag by up to two
   * minutes is a change made by SOMEONE ELSE in the agency.
   */
  experimental: {
    /**
     * Uploads (the listing import's CSV / Excel file) go through a Server Action, whose body is
     * 1 MB by default — so the screen's "up to 10 MB" was really 1 MB. Vercel takes at most 4.5 MB
     * in one request, so 4.4 MB is the most an upload can be; a bigger list comes in by Google
     * Sheets (read server-side, no upload) or split into files.
     */
    serverActions: {
      bodySizeLimit: '4.4mb',
    },
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
  },
};

/**
 * ADR 0082. Readable stack traces need SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT at build time; without them the build is
 * unchanged apart from the SDK. The maps are uploaded and then deleted, so they are never served.
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, deleteSourcemapsAfterUpload: true },
  bundleSizeOptimizations: { excludeDebugStatements: true, excludeTracing: true, excludeReplayIframe: true, excludeReplayShadowDom: true, excludeReplayWorker: true },
});
