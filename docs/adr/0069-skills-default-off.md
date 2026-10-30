# 0069 — Every skill is off until it is switched on; automations that reach a customer live in Skills

**Status:** accepted, 2026-10-29 (the client's instruction, the user's three decisions). Amends ADR 0058.
Migration 0070 (data only). Mocks: `skills-control-centre.html`, `missed-calls.html`, `twilio-setup.html`.

**Context.** The client: every automated feature (AI calling, automated SMS, automated email) sits in
Skills with its own ON/OFF switch, and runs ONLY when someone explicitly switched it on. ADR 0058 built
the switches but stored them as exceptions with no row = on, and a workflow's "send template email"
step was gated by no switch at all.

**Decision.**
1. **No row = OFF, for every platform skill** (the user's decision 1: all skills, not only the ones that
   reach customers). `isSkillOn`, `listSkillSwitches`, `skillsOffFor` (the hourly scan) and
   `skillsOffForActor` (the assistant) all read the switched-ON rows; the pure `skillsOffOf` says what is
   off. The agency-only skills still never gate an agent. The Skills page says "Off until you switch it on".
2. **A new skill, `workflow_emails`** (Communication, runs by itself): a workflow sends an approved
   template to a contact. `SKILL_OF_WORKFLOW_STEP` maps each step that reaches a contact to its skill
   (`send_template_email` → Workflow emails, `draft_email` → AI email drafts). Checked when the run is
   made (the run is skipped, saying which switch) **and again when the step runs** (`runScheduledActions`
   fails it), so a switch turned off during a `wait` still stops it. Fixes ADR 0058's "not re-checked".
3. **Workflows already sending templates keep running** (the user's decision 3): migration 0070 switches
   Workflow emails on for the holder of each active workflow owner whose spec has that step. Every other
   skill of every existing agency starts off; owners and agents switch on what they use.
4. **Phone & SMS skills need two switches** (the user's decision 2), built with Phase 3: `missed_call_text`
   and `ai_callback` run for an agent only when the agency's switch AND that agent's own are on (the agency
   pays Twilio; the agent's name is on the text). Connecting Twilio sets up phones only; nothing is texted
   or called until both are on. Every other skill keeps ADR 0058's independent switches.

**Consequences.** After 0070, an existing agency's assistant refuses dashboards, documents, team answers
etc. with "switched off in Skills" and offers to switch it on (`switch_skill`, an approval card); the
opportunity scan finds nothing for anyone with the detector off. Smoke fixtures switch every skill on; a
new smoke check covers the default. Prompt unchanged (it already offers to switch a skill on).

**Not done.** A "switch on all" per group; the two-switch rule in code (lands with the Phone & SMS skills);
moving the Bulk email page's gate from `apps/console/lib/template-email-actions.ts` into core.
