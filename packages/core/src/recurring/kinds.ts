import { z } from 'zod';

/**
 * What a repeating automation can be (ADR 0089). One engine; each skill plugs in a kind. No database here: the browser
 * and the chat tools read it. A new kind is an entry here, a runner in `runners.ts` and a chat that can make it.
 */

export const AUTOMATION_KINDS = ['bulk_email'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export const AUTOMATION_LIMITS = { peoplePerRun: 1000, failuresBeforePause: 3, leaseMinutes: 5 } as const;

/** The names are copied in when it is made, so a list of automations asks nothing per row. */
export const bulkEmailSpecSchema = z
  .object({
    templateId: z.string().uuid(),
    templateName: z.string().min(1).max(200),
    filterId: z.string().uuid(),
    listName: z.string().min(1).max(200),
  })
  .strict();
export type BulkEmailSpec = z.infer<typeof bulkEmailSpecSchema>;

export const AUTOMATION_SPECS = { bulk_email: bulkEmailSpecSchema } as const satisfies Record<AutomationKind, z.ZodTypeAny>;

/** The skill each kind comes from: its name on screen, and the switch every run needs on. */
export const AUTOMATION_SKILL: Readonly<Record<AutomationKind, { key: string; name: string; icon: string }>> = Object.freeze({
  bulk_email: { key: 'bulk_email', name: 'Bulk email', icon: 'forward_to_inbox' },
});

/** What it does, in words, from its own spec. */
export function automationWords(kind: string, spec: unknown): string {
  if (kind === 'bulk_email') {
    const s = bulkEmailSpecSchema.safeParse(spec);
    return s.success ? `Sends “${s.data.templateName}” to everyone on “${s.data.listName}” who may receive it` : 'Sends a bulk email';
  }
  return 'Runs a skill';
}

export type AutomationSchedule = { cadence: 'daily' | 'weekly' | 'interval'; sendAtMinute: number; sendOnWeekday: number | null; intervalMinutes: number | null; timezone: string };

export type AutomationDraft = AutomationSchedule & {
  kind: AutomationKind;
  name: string;
  spec: unknown;
  conversationId: string | null;
};
