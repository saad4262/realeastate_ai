import { defineConfig } from 'vitest/config';

/** Unit tests run offline (@repo/config/test-offline), as in every package. */
export default defineConfig({
  test: {
    setupFiles: ['@repo/config/test-offline'],
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next*/**'],
  },
});
