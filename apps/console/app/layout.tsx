import type { Metadata } from 'next';
import { Inter, Plus_Jakarta_Sans } from 'next/font/google';
import '@repo/ui/styles.css';
import './globals.css';
import { ToastProvider } from '../components/toast';

/**
 * Self-hosted, so the critical path holds no third-party round trip.
 *
 * These were two render-blocking <link>s to fonts.googleapis.com, which meant a
 * DNS lookup, a TLS handshake and a CSS round trip to another origin before the
 * console could paint any text. next/font downloads them at build time, serves
 * them from this origin and emits the @font-face itself, so there is nothing to
 * block on. `display: swap` plus the size-adjusted fallback it generates is
 * also what removes the layout shift when the real face arrives.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-jakarta',
});

export const metadata: Metadata = {
  title: 'Console',
  description: 'Agent and agency console',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${inter.variable} ${jakarta.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/*
          Material Symbols, with its axes pinned to the ones this app actually
          uses.

          The request used to ask for the full variable space —
          opsz 20..48, wght 100..700, FILL 0..1, GRAD -50..200 — and every
          font-variation-settings rule in this codebase sets wght 400, GRAD 0
          and an opsz of 16, 20 or 24. We were paying for a range of weights and
          grades nothing renders.

              full axes   4,001,724 bytes
              pinned      1,107,100 bytes   (-72%)

          Measured by fetching both stylesheets and the woff2 each points at.
          It is still the heaviest asset here, and the next step would be
          &icon_names= to ship only the glyphs used — deliberately not taken,
          because a missed name renders as the literal word and this list is
          spread across every module in the console.

          Not next/font: its axes support does not cover an icon font's FILL
          range cleanly, and getting that wrong is a page full of words.
        */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..24,400,0..1,0&display=swap"
          rel="stylesheet"
        />
      </head>
      {/*
        Extensions (password managers, ColorZilla, Grammarly) write attributes
        onto <body> before React hydrates, which reads as a server/client
        mismatch that no code change can prevent. This silences the attribute
        diff on this one element only — children are still checked normally, so
        a real mismatch inside the app still surfaces.
      */}
      <body suppressHydrationWarning>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
