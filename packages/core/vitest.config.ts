import { defineConfig } from 'vitest/config';

/**
 * Unit tests run offline. See @repo/config/test-offline for why —
 * in short, a convention that tests do not call the network is a thing the
 * next test forgets, and the failure mode is a silent bill.
 */
export default defineConfig({
  test: {
    setupFiles: ['@repo/config/test-offline'],
  },
});
