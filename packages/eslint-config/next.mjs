import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

/**
 * Shared Next.js + TypeScript lint rules for every app in the monorepo.
 * Apps re-export this rather than keeping their own copy, so the two
 * Next apps cannot drift apart.
 *
 * baseDirectory is this package, so `next/*` resolves through this
 * package's own eslint-config-next rather than each app's.
 *
 * Pinned to ESLint 9: eslint-config-next@15.5 peers on
 * `^7.23.0 || ^8.0.0 || ^9.0.0`, so ESLint 10 is not an option until Next
 * ships a config that supports it. 9.x is npm's `maintenance` line.
 */
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

// eslint-config-next 15.5 still ships eslintrc-style configs only, so the
// shareable configs are bridged into flat config with FlatCompat.
const config = [
  {
    // NEXT_DIST_DIR puts throwaway dev/build output in sibling .next-* folders;
    // none of it is source, and linting it buries real findings.
    ignores: ['.next/**', '.next-*/**', 'next-env.d.ts', 'node_modules/**'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  // PLATFORM-PLAN 4.5: the whole recommended accessibility set, not only the six rules Next turns on.
  ...compat.extends('plugin:jsx-a11y/recommended'),
  {
    rules: {
      // Pages Router rule: it looks for font links outside pages/_document.js.
      // These apps are App Router only, where a <link> in the root layout is
      // the documented placement. (next/font is the real upgrade, not
      // _document.)
      '@next/next/no-page-custom-font': 'off',
      // Autofocus is used where the person just opened the field (a dialog, an inline editor, the help window) and on
      // sign-in forms whose one job is that field; nowhere does it move focus on its own.
      'jsx-a11y/no-autofocus': 'off',
      // A checkbox's label text sits a span or two inside the <label> that wraps the input.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
      // Unused args are allowed when prefixed with _, matching the repo's
      // tsconfig-strict style rather than fighting it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];

export default config;
