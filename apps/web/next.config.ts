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
   * How long a visited page stays usable in the client router cache.
   *
   * 30 seconds, and the number is derived rather than chosen: it is the TTL of
   * cachedSearch in lib/cached.ts. The invariant is
   *
   *     router cache window <= Data Cache TTL of the data on that page
   *
   * which makes a router-cache hit provably no staler than a fresh server
   * render would have been. The client cache can no longer be the reason
   * somebody sees something out of date; only the data cache can, and that is
   * a window every visitor already lives with.
   *
   * This was 120s once and that was wrong: an agent published a listing, went
   * to check the public site, and the same search URL replayed the old answer
   * for two minutes. The fix at the time was 0, which closed the hole by
   * refetching the entire page on every Back — and browse → open → back → open
   * is the single most repeated act on a property portal, so every visitor paid
   * for one agent's confusion. The hole itself belongs to the data cache, and
   * revalidateTag closes it within a second of a publish for everyone.
   */
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },
};

export default nextConfig;
