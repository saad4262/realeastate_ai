/**
 * Tailwind runs here, and only here.
 *
 * apps/console and packages/ui stay on CSS Modules — see ARCHITECTURE.md § 2
 * for which system is used for what. Adding this file to another app is a
 * decision, not a convenience.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
