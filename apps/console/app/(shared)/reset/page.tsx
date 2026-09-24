import type { Metadata } from 'next';
import { Suspense } from 'react';
import { surfaceCopy } from '../../../lib/surface';
import { ResetPasswordScreen } from './reset-screen';

export const metadata: Metadata = {
  title: 'Reset Access — LocalAgentHub OS',
};

/**
 * Server wrapper so the copy can follow the host surface — the screen itself
 * needs the client for the Supabase call and the query string.
 */
export default async function ResetPasswordPage() {
  const copy = await surfaceCopy();
  return (
    <Suspense fallback={null}>
      <ResetPasswordScreen subtitle={copy.resetSubtitle} />
    </Suspense>
  );
}
