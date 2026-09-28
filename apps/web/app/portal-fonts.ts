import { Inter, Plus_Jakarta_Sans } from 'next/font/google';

/**
 * The two families the Stitch mock is set in.
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
 * Weights are only the ones the mock's own config declares: Inter 400/500/600/
 * 700, Jakarta 600/700. `display: 'swap'` and next/font's size-adjusted
 * fallback are what stop the headline moving when the real face lands.
 */
export const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

export const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['600', '700'],
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
