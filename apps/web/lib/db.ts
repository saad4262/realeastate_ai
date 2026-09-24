import { getDb, type Db } from '@repo/db';

/**
 * Read-only database access for the public site.
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
