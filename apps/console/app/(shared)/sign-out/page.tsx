import { createServerSupabaseClient } from '@repo/auth/server';
import { redirect } from 'next/navigation';

export default async function SignOutPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  // Relative only — ?next= is user input, and an absolute value here would
  // turn sign-out into an open redirect.
  const next = params.next && params.next.startsWith('/') && !params.next.startsWith('//')
    ? params.next
    : '/login';

  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect(next);
}
