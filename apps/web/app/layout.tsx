import type { Metadata } from 'next';
import { Fraunces, Source_Sans_3 } from 'next/font/google';
import '@repo/ui/styles.css';

/**
 * Self-hosted, so the critical path holds no third-party round trip.
 *
 * These were two render-blocking <link>s to fonts.googleapis.com: a DNS lookup,
 * a TLS handshake and a CSS round trip to another origin before the page could
 * paint any text — on the consumer site, where that is the first impression and
 * the Core Web Vitals. next/font downloads them at build time, serves them from
 * this origin and emits the @font-face itself. The size-adjusted fallback it
 * generates is what stops the headline moving when the real face lands.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['600'],
  display: 'swap',
  variable: '--font-fraunces',
});

const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '600'],
  display: 'swap',
  variable: '--font-source-sans',
});

export const metadata: Metadata = {
  title: 'Property Platform — Sydney / NSW',
  description: 'AI-driven property platform for Sydney and NSW.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`${fraunces.variable} ${sourceSans.variable}`}>
      {/*
        Extensions (password managers, ColorZilla, Grammarly) write attributes
        onto <body> before React hydrates, which reads as a server/client
        mismatch that no code change can prevent. This silences the attribute
        diff on this one element only — children are still checked normally, so
        a real mismatch inside the app still surfaces.
      */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
