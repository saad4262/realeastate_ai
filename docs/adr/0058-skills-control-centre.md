# 0058 — The Skills Control Centre: every built capability has an on/off switch

**Status:** accepted, 2026-10-27 (the user approved `docs/mocks/skills-control-centre.html` and decided
the three open points). ROADMAP Phase 1.2. Migration 0065.

**Context.** The brief wants the assistant to do the agency's work, with the agency choosing what it may
do. Until now only the three scheduled AI skills (ADR 0021) could be switched on or off. Bulk email,
drafts, dashboards, the opportunity detectors (ADR 0054), buyer matching (ADR 0055) and AI import help
(ADR 0056) were always on for everyone.

**Decision.**
1. **A fixed catalog in code** (`packages/core/src/skill-switches/catalog.ts`): 16 platform skills in the
   mock's six groups (Communication, Listings, CRM & matching, Opportunities, Insights, Knowledge & team).
   Each has a key, a name, a line on what it does, a scope (`both`, or `agency` for the three that read the
   whole agency: agency performance answers, team activity, team management by the assistant), a level
   shown as a tag ("Runs by itself" or "Needs your approval"), and the connector it needs, if any. A new
   skill is a catalog entry plus its gate, both reviewed. It is never data.
2. **Two kinds of switch, independent of each other (the user's decision 1).** The agency's switch belongs
   to the agency and is used by its owners and admins; any of them may flip it. Every other member has
   their own. Neither overrides the other: an agency turning a skill off does not turn it off for an
   agent, and the other way round. Agents never see `agency` skills. Each skill still works only on what
   that person may see (`can()` as before), so a switch can narrow what someone does, never widen it.
3. **Stored as exceptions.** `skill_switch(agency_id, user_id null = the agency's, skill_key, enabled,
   changed_by)`, unique on (agency, coalesce(user, 0), key). No row means on, so every agency keeps working
   exactly as today after the migration.
4. **Off means off where it runs**, checked in core:
   - assistant tools are refused at run time with "“X” is off in Skills" (the tool list stays two frozen
     lists, so the prompt cache is unchanged);
   - the hourly opportunity scan drops a person's detections for skills they have off;
   - a workflow step that drafts an email is not run while its owner has AI email drafts off;
   - AI import help is not asked while the uploader has it off;
   - a bulk email cannot be prepared or sent while the person has Bulk email off.
5. **The assistant can flip a switch** with a new tool, `switch_skill`. It makes a card ("Turn off “Cold
   contact alerts” · For the agency"), and nothing changes until the person approves it.
   `find_skills` now also lists the platform skills with their state. Prompt v26.
6. **One Skills page with three tabs** (the user, 2026-10-27): Platform skills (cards in a grid, the
   user's decision 3), AI skills (ADR 0021, unchanged), Automations (the Workflows page moves in).
   `/workflows` and `/my-workflows` redirect to the tab. The sidebar's Automation group lists only Skills.

**Not done.** An agency switch that also forces agents (the user: revisit later); a per-agent allow list;
switches for features that are not built yet (SMS and missed calls get theirs when they land); re-checking a
switch when an already-made card is approved.
