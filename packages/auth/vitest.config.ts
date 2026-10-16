import { defineConfig } from 'vitest/config';

/** Unit tests run offline (@repo/config/test-offline). Supabase is a fake here, never the real one. */
export default defineConfig({
  test: {
    setupFiles: ['@repo/config/test-offline'],
  },
});
