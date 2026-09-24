import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * A second `next dev` on another port still writes to the same .next as the
   * one already running, which clobbers its manifests and leaves the live app
   * serving 404s for its own CSS. Throwaway servers set NEXT_DIST_DIR so they
   * build somewhere else entirely and never touch the running one.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  /**
   * @repo/ai is here so the chat route can import it, which also means a stray
   * *value* import in a client component would pull the Anthropic SDK and the
   * database driver into the browser bundle. The client may only touch
   * @repo/ai/chat-events, which imports neither, and only with `import type`.
   */
  transpilePackages: ['@repo/ui', '@repo/core', '@repo/db', '@repo/config', '@repo/ai'],
  /**
   * Search results are never served from the client router cache.
   *
   * This was 120s, on the reasoning that listings do not change by the second
   * and going back to a result should not refetch. That reasoning was wrong for
   * this page. The cache key is the URL, so searching the same suburb and radius
   * twice replays the first answer — and the gap between those two searches is
   * exactly when an agent publishes a listing and then goes to check that it
   * appeared. It did not, for two minutes, with no way to tell why.
   *
   * A property portal that shows a buyer a listing that has just sold, or hides
   * one that has just come up, is wrong in the way that matters most. Static
   * pages keep their cache; dynamic ones are re-fetched.
   */
  experimental: {
    staleTimes: {
      dynamic: 0,
      static: 300,
    },
  },
};

export default nextConfig;
