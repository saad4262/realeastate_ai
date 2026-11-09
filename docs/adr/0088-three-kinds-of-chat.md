# 0088 — Three kinds of chat, and a skill chat cannot reach another skill

**Status:** accepted, 2026-11-09 (the user's decisions below). Built in phases on `feat/three-chats`. Migration 0093 (additive).

**Context.** The console has one assistant with every tool in one list. A switch in Skills can only refuse a tool; nothing keeps a
conversation to one job. The user wants an Overview chat for talking and looking things up, one chat per skill that can do only that
skill, and a small help bot. Usage and limits must be countable per kind of chat.

**The user's decisions (2026-11-09).**
1. Overview only reads. Notes, lead status, reminders and appointments move to a separate Daily work chat.
2. Email automations and SMS automations are separate chats. Neither can add the other's send step.
3. The Activity panel shows an agent their own automations; an owner or admin the agency's, each row saying whose.

**Decision.**
1. **A fixed registry in code** (`packages/core/src/assistant/chat-scopes.ts`): each scope, its tools, and its limits on input. Never data.
2. **`assistant_conversation.chat_scope`**, written once when the chat is made, read by the server, never taken from the browser on a
   later turn. Null is a chat from before this ADR and keeps every tool until Overview is narrowed. A value the code does not know
   fails closed to `general`, the fewest tools.
3. **Three locks, none of them the prompt:** the model is shown only the scope's frozen list; `runAssistantTool` refuses anything else
   and checks the input (a plan's steps, a workflow's send steps); Approve checks the card's tool against its chat. `list_templates`
   takes its channel from the scope, not the model.
4. **A guard test:** every action tool belongs to exactly one scope, except `create_template`, `create_workflow` and `change_workflow`,
   which are named as shared and limited by input. Overview has no action tool. `switch_skill` stays on the Skills page.
5. **Metering:** `ai_run.feature` does not change, so the budgets and the AI cost page keep working. `ai_run.chat_scope` says which
   chat; `cache_read_tokens` and `cache_write_tokens` are recorded. Limits on the model are in dollars, because a cached token costs a
   tenth. Limits on sends count the rows the sends already write.

**Order.** Foundation (nothing visible) → metrics → Activity panel → help bot → Bulk email chat → the other skill chats → Overview
read-only behind an env flag → per-chat limits. Removing tools from Overview is last, so nothing is taken away before its replacement works.

**Alternatives.** A prompt that says "only do bulk email" (a note in a contact's record can talk a model out of it). `feature` values
like `assistant:bulk_email` (the budget sums `feature = 'assistant'`, so those chats would escape it). Separate pipelines per chat
(one loop, one set of checks is what keeps them the same).

**Added while building.** `send_template_sms` is a tool only the Bulk SMS chat has: a chat from before this ADR keeps the tool list it had, so it is left out of that list and refused at run time. A saved list longer than one batch becomes a `plan_task` card, so the Bulk email chat may approve that card even though it does not have the tool. The Daily work and AI skills chats have no switch of their own and start from the Skills page.

**Overview read-only.** Off until `ASSISTANT_OVERVIEW_READ_ONLY=1`, so it is turned on and back off without changing code. With it on, a new Overview chat is saved as `general`, and a chat from before this ADR is treated as one for that turn while its row stays null, so its old cards still approve. `open_chat` is Overview's way out: a button into the right chat, with the person's words typed in and not sent.

**The top bar has two panels (the user, 2026-11-09).** Skills are the platform's ready-made templates; automations are what an agent or agency sets up. Skills lists what is on, with its switch and chat. Automations lists what is running and how far it has got, what failed, the workflows and scheduled AI skills that are on, with Pause, Off and Stop. A bulk email of a saved list goes in parts of 20, one a day, so it is counted in people, not steps. Stopping one cancels its later parts, under the rule the chat's cancel uses; a part that is sending finishes.

**Done before the automations chats opened.** `change_workflow` and `create_workflow`'s `replaces` act on a stored workflow, so the
input check cannot see its steps: they check the stored spec, and `find_workflows` shows only that chat's kind. A workflow
holding both kinds of send keeps running and is changed on the Workflows page.

**Consequences.** Apply 0093 before deploying this code: every `ai_run` insert names the new columns. Each scope is its own cached prefix.
