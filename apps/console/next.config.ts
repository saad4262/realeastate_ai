import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * A second `next dev` on another port still writes to the same .next as the
   * one already running, which clobbers its manifests and leaves the live app
   * serving 404s for its own CSS. Throwaway servers set NEXT_DIST_DIR so they
   * build somewhere else entirely and never touch the running one.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: ['@repo/ui', '@repo/auth', '@repo/core', '@repo/db', '@repo/config'],
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
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
  },
};

export default nextConfig;
