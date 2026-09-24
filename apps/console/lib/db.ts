import { getDb, type Db } from '@repo/db';

export function getConsoleDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('YOUR_PASSWORD')) {
    throw new Error(
      'DATABASE_URL is not configured. Set the real Supabase DB password in .env.local.',
    );
  }
  return getDb(url);
}
