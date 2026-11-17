import { defineConfig } from 'vitest/config';

/** Unit tests run offline (@repo/config/test-offline). */
export default defineConfig({
  test: {
    setupFiles: ['@repo/config/test-offline'],
  },
});
