import localFont from 'next/font/local';

/**
 * The two families the Stitch mock is set in.
 *
 * Since 2026-11-10 the skin is site-wide and layout.tsx puts these on <html>.
 * What follows is why they were first kept OFF the root, kept as history:
 *
 * Imported HERE rather than in layout.tsx, and applied on the portal wrapper
 * rather than on <html>. next/font preloads a font on the routes whose module
 * graph reaches it, so putting these in the root layout would push both files
 * onto the critical path of `/` and `/chat` — two pages that are set in Source
 * Sans and Fraunces and would never draw a glyph from either.
 *
 * § 11 of ARCHITECTURE.md exists because the largest single performance win in
 * this repo was a font: Material Symbols, requested across its whole variable
 * axis space, 4.0 MB of render-blocking CSS for glyphs at one weight. Adding
 * families is therefore a decision, not a default. These two are the decision
 * — the mock's body copy is Inter and its headlines are Plus Jakarta Sans, and
 * setting a slate portal in a warm humanist serif is most of what made the
 * first attempt look like a different design.
 *
 * Each is one variable file (the mock uses Inter 400–700 and Jakarta 600/700;
 * the console's Jakarta 500–800 shares the file). `display: 'swap'` and next/font's size-adjusted
 * fallback are what stop the headline moving when the real face lands.
 */
// Local files (./fonts), not next/font/google: the build fetches nothing from Google (see layout.tsx).
export const inter = localFont({
  src: './fonts/inter-latin-var.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-inter',
});

export const jakarta = localFont({
  src: './fonts/plus-jakarta-sans-latin-var.woff2',
  weight: '500 800',
  display: 'swap',
  variable: '--font-jakarta',
});

/**
 * Both variables, for the element that also carries `data-skin="portal"`.
 *
 * The skin block in tailwind.css points --font-sans and --font-display at
 * these, and falls back to the site's own families if this class is ever
 * forgotten — so a missed className is a page in the wrong typeface, never a
 * page with no typeface.
 */
export const portalFonts = `${inter.variable} ${jakarta.variable}`;
