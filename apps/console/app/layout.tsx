import type { Metadata } from 'next';
import '@repo/ui/styles.css';
import './globals.css';
import { ToastProvider } from '../components/toast';

export const metadata: Metadata = {
  title: 'Console',
  description: 'Agent and agency console',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
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
