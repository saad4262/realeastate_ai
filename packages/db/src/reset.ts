import { config } from 'dotenv';
import { resolve } from 'node:path';
import { getDb } from './client';
import {
  agency,
  agentInvite,
  agentProfile,
  aiRun,
  event,
  inspection,
  lead,
  listing,
  listingAgent,
  media,
  membership,
  office,
  property,
  chatMessage,
  chatThread,
  scheduleRun,
  searchSchedule,
  shortlist,
  team,
  teamMember,
  user,
} from './schema';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Wipes every application row in `public`. Supabase `auth.users` is NOT touched —
 * accounts survive, they just stop belonging to an agency until they register one.
 *
 * Guarded: run as `CONFIRM_RESET=yes pnpm db:reset`.
 */
async function main() {
  if (process.env.CONFIRM_RESET !== 'yes') {
    console.error('Refusing to wipe. Re-run as: CONFIRM_RESET=yes pnpm db:reset');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.includes('YOUR_PASSWORD')) {
    console.error('Set DATABASE_URL with the real password in .env.local first.');
    process.exit(1);
  }

  const db = getDb(databaseUrl);

  // Children before parents — FK order, not alphabetical.
  const tables = [
    ['listing_agent', listingAgent],
    ['media', media],
    ['inspection', inspection],
    ['lead', lead],
    ['shortlist', shortlist],
    ['chat_message', chatMessage],
    ['chat_thread', chatThread],
    // schedule_run before search_schedule — FK order, not alphabetical.
    ['schedule_run', scheduleRun],
    ['search_schedule', searchSchedule],
    ['event', event],
    ['ai_run', aiRun],
    ['listing', listing],
    ['property', property],
    ['agent_invite', agentInvite],
    ['agent_profile', agentProfile],
    ['team_member', teamMember],
    ['team', team],
    ['membership', membership],
    ['office', office],
    ['agency', agency],
    ['user', user],
  ] as const;

  await db.transaction(async (tx) => {
    for (const [name, table] of tables) {
      await tx.delete(table);
      console.log(`cleared ${name}`);
    }
  });

  console.log('\nDone. auth.users untouched — sign in and register an agency at /get-started.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
