-- ADR 0069: a platform skill with no skill_switch row is now OFF (it was on). Data only, no schema change.
-- A workflow that already sends template emails was approved by its owner, so it keeps running: its
-- owner's holder gets "Workflow emails" switched on — the agency's switch for an owner or admin, the
-- person's own for anyone else. Every other skill starts off until someone switches it on.
INSERT INTO "skill_switch" ("agency_id", "user_id", "skill_key", "enabled", "changed_by")
SELECT DISTINCT
	w."agency_id",
	CASE WHEN m."role" IN ('owner', 'admin') THEN NULL ELSE w."owner_id" END,
	'workflow_emails',
	true,
	NULL::uuid
FROM "workflow" w
JOIN "membership" m ON m."user_id" = w."owner_id" AND m."agency_id" = w."agency_id" AND m."status" = 'active'
WHERE w."status" = 'active'
	AND jsonb_path_exists(w."spec", '$.** ? (@.type == "send_template_email")')
ON CONFLICT ("agency_id", coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid), "skill_key") DO NOTHING;
