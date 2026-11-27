# 0104 — The AI Assistant builds and runs workflows, email and text in one

**Status:** accepted, 2026-11-27 (the user: "Overview wala AI agent sab control kare"; steps 2 and 3 of the plan after ADR 0103). Amends ADR 0089's final shape and ADR 0088's "no overlap". No migration.

**Context.** A workflow could email (Email chat) or text (SMS chat), never both: each chat refused the other channel's step. Overview's AI Assistant could only list workflows and send the person to a chat. The user wants one assistant that sets up "new lead → email → 2 hours → text", reports how automations are doing, and pauses them. The engine already ran mixed steps and checked each step's switch at run time (ADR 0069).

**Decision.**
1. Overview's AI Assistant holds `create_workflow` and `change_workflow` (pause, resume, archive). It refuses no channel: one workflow may email and text. The Email and SMS chats are unchanged: each still builds only its own channel.
2. A proposed workflow needs every step's switch on (`workflowStepSkills`: Workflow emails, Workflow texts, AI email drafts, AI understands enquiries), in any chat, when the card is made — the same switches its runs ask again. A pair switch (Workflow texts) needs the agency's and the person's.
3. `find_workflows` reports each workflow's latest run in words (running now / finished every step / stopped: why / failed: why / did not run: why), read in the list's one statement with `workflow_run_recent_idx`, never one query per workflow.
4. Prompt `chat-scope@v2`: Overview builds and manages workflows itself; a send now, a send on a clock, a new template, listings, dashboards and AI skills still go to their chats.

**Not in this step.** Pausing a workflow stops new runs; a run already part-way carries on (or stops on a reply, ADR 0103). Stopping one run in flight from the chat is not built.

**Alternatives.** Let the Email chat take text steps (keeps two places that build mixed workflows, and breaks ADR 0089's one-channel chats). One assistant with every tool (80+ tools: wrong picks and cost; Salesforce caps a supervisor at ~7 specialists).
