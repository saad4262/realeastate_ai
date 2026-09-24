import { z } from 'zod';

/** Self-serve agency registration payload (ADR 0006). */
export const registerAgencySchema = z.object({
  agencyName: z.string().trim().min(2).max(160),
  abn: z
    .union([z.string().trim().regex(/^\d{11}$/, 'ABN must be 11 digits'), z.literal('')])
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  ownerName: z.string().trim().min(2).max(160),
  phone: z
    .union([z.string().trim().min(8).max(32), z.literal('')])
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  officeName: z.string().trim().min(2).max(160).default('Head Office'),
  officeAddress: z
    .union([z.string().trim().max(400), z.literal('')])
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
});

export type RegisterAgencyInput = z.infer<typeof registerAgencySchema>;

export function slugifyAgency(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100) || 'agency'
  );
}
