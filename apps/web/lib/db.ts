import { getDb, type Db } from '@repo/db';

/**
 * Database access for the public site.
 *
 * It was read-only until consumer accounts arrived, and the comment said so.
 * It no longer is: `ensureConsumerAccount` upserts a `user` row and saved
 * searches are written from here. Listings are still only ever read on this
 * side — the console owns those.
 *
 * getDb memoises one pool per connection string, so calling this per request
 * costs nothing after the first.
 */
export function getWebDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('YOUR_PASSWORD')) {
    throw new Error('DATABASE_URL is not configured.');
  }
  return getDb(url);
}
