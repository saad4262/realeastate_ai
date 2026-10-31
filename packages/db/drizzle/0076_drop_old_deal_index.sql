-- ADR 0075, step 2 of 2: the old "one open deal per address" index goes, so a second agency's deal on the same
-- address can open. Apply ONLY after the code from 0075 is deployed (its ON CONFLICT names the per-agency index;
-- the previous code's ON CONFLICT names this one). Idempotent.
DROP INDEX IF EXISTS "deal_open_property_idx";
