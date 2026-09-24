import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

function create(connectionString: string) {
  const client = postgres(connectionString, { prepare: false, max: 10 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof create>;

/**
 * A database handle that may or may not be inside a transaction.
 *
 * Derived from Db rather than written out, so it cannot drift from whatever
 * Drizzle hands the transaction callback. Helpers that write take this: a
 * function that only accepts Db is a function that cannot be made atomic
 * without rewriting it, which is how half-written rows get into a database.
 */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * One pool per connection string, per process.
 *
 * Every getDb() used to open a fresh pool, so a single page load paid two to
 * four TCP+TLS handshakes to the database region — measured at ~1.3s cold
 * against ~0.2s on a warm pool. Nothing closed them either, so the pools piled
 * up until the server was restarted.
 *
 * Held on globalThis because Next's dev server re-evaluates modules on every
 * hot reload; a module-level Map alone would leak a pool per edit.
 */
const GLOBAL_KEY = Symbol.for('@repo/db.pools');

type PoolRegistry = Map<string, Db>;

function registry(): PoolRegistry {
  const g = globalThis as unknown as Record<symbol, PoolRegistry | undefined>;
  return (g[GLOBAL_KEY] ??= new Map());
}

/**
 * App DB client via transaction pooler.
 * prepare: false is required for Supabase transaction-mode pooler.
 */
export function getDb(connectionString: string): Db {
  const pools = registry();
  const existing = pools.get(connectionString);
  if (existing) return existing;

  const db = create(connectionString);
  pools.set(connectionString, db);
  return db;
}
