import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@repo/ui/styles.css';
import './globals.css';
import { ToastProvider } from '../components/toast';

/**
 * Self-hosted, so the critical path holds no third-party round trip, and the build fetches nothing: the files
 * are in ./fonts (Google's latin variable cuts; OFL, Apache 2.0 for the icons). next/font/google downloaded them
 * at build time, and a slow answer from Google failed the Vercel build. next/font/local still emits the
 * @font-face and a size-adjusted fallback, so `display: swap` does not move the layout.
 */
const inter = localFont({
  src: './fonts/inter-latin-var.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-inter',
});

const jakarta = localFont({
  src: './fonts/plus-jakarta-sans-latin-var.woff2',
  weight: '500 800',
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
