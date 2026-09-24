import type { Metadata } from 'next';
import { AppShell } from '@repo/ui';
import { ChatView } from './chat-view';
import { cachedFilterOptions } from '../../lib/cached';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Property guide — Property Platform',
  description: 'Tell us what you are looking for and search the live listings in conversation.',
};

/**
 * The conversational way into the same search.
 *
 * The cached read is shared with the home and search pages, so it is one call
 * and almost always warm. Only the first suburb crosses to the client, though:
 * all it does is write a placeholder a visitor can copy, and shipping every
 * live suburb to pick one of them put the whole list in this page's payload.
 */
export default async function ChatPage() {
  const { suburbs } = await cachedFilterOptions();

  return (
    <AppShell surface="web">
      <ChatView exampleSuburb={suburbs[0] ?? null} />
    </AppShell>
  );
}
