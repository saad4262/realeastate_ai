import { getDb, getHealthDb, type Db } from '@repo/db';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('YOUR_PASSWORD')) {
    throw new Error(
      'DATABASE_URL is not configured. Set the real Supabase DB password in .env.local.',
    );
  }
  return url;
}

export function getConsoleDb(): Db {
  return getDb(databaseUrl());
}

/** For /api/health only: its own connection, so a busy console is never reported down. */
export function getConsoleHealthDb(): Db {
  return getHealthDb(databaseUrl());
}
