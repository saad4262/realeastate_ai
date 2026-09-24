import type { Metadata } from 'next';
import '@repo/ui/styles.css';

export const metadata: Metadata = {
  title: 'Property Platform — Sydney / NSW',
  description: 'AI-driven property platform for Sydney and NSW.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Source+Sans+3:wght@400;600&display=swap"
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
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
