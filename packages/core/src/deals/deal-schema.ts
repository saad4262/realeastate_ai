import { z } from 'zod';
import { DEAL_STAGES } from './stages';

/** The Deal tab's contracts (ADR 0063). Pure: the console's forms use the same checks the server does. */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)');
const dollars = z.coerce.number().min(0).max(1_000_000_000);
const uuid = z.string().uuid();

/** The sale's details. Each field optional; null clears it. */
export const dealDetailsSchema = z
  .object({
    salePrice: dollars.nullable().optional(),
    buyerContactId: uuid.nullable().optional(),
    contractDate: day.nullable().optional(),
    depositAmount: dollars.nullable().optional(),
    depositPaidOn: day.nullable().optional(),
    settlementDate: day.nullable().optional(),
    buyerSolicitor: z.string().trim().max(160).nullable().optional(),
  })
  .strict();
export type DealDetailsInput = z.infer<typeof dealDetailsSchema>;

export const moveStageSchema = z.object({ to: z.enum(DEAL_STAGES) }).strict();

export const settleSchema = z
  .object({
    settledOn: day,
    finalPrice: dollars.nullable().optional(),
    /** Tag the buyer and the vendor as Past clients (ADR 0061). */
    tagPastClients: z.boolean().default(true),
  })
  .strict();
export type SettleInput = z.input<typeof settleSchema>;

export const addConditionSchema = z.object({ label: z.string().trim().min(2, 'Name the condition').max(80), dueOn: day.nullable().optional() }).strict();
export const updateConditionSchema = z.object({ dueOn: day.nullable().optional(), done: z.boolean().optional() }).strict();
