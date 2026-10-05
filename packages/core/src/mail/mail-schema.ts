import { z } from 'zod';

/**
 * The contracts for email conversations (docs/adr/0016).
 *
 * Kept free of node imports so the console's composer can import the reply
 * schema and refuse an empty message before it costs a round trip.
 */

/** Longest reply the composer accepts. A long email, not a document. */
export const MAX_REPLY_LENGTH = 20_000;

export const replyInputSchema = z.object({
  body: z
    .string()
    .transform((value) => value.replace(/\r\n?/g, '\n').trim())
    .pipe(
      z
        .string()
        .min(1, 'Write a message first')
        .max(MAX_REPLY_LENGTH, `Keep it under ${MAX_REPLY_LENGTH.toLocaleString('en-AU')} characters`),
    ),
});

export type ReplyInput = z.infer<typeof replyInputSchema>;

/** The inbox folders. In the URL as `?folder=`; anything else is `all`. */
export const MAIL_FOLDERS = ['all', 'unread', 'mine', 'offers', 'general'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export function parseMailFolder(raw: string | string[] | undefined): MailFolder {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (MAIL_FOLDERS as readonly string[]).includes(value ?? '') ? (value as MailFolder) : 'all';
}

/**
 * Resend's `email.received` event. Only what routing needs is required; the
 * body is fetched separately (the event does not carry it).
 */
export const receivedEventSchema = z.object({
  type: z.string(),
  data: z
    .object({
      email_id: z.string().min(1),
    })
    .passthrough(),
});

const addressList = z
  .union([z.array(z.string()), z.string(), z.null()])
  .optional()
  .transform((value) => (value == null ? [] : Array.isArray(value) ? value : [value]));

/**
 * `GET /emails/receiving/{id}`.
 *
 * Lenient where Resend's own example is: `text` and `html` may each be null,
 * `headers` is a lower-cased map, `authentication` reports SPF/DKIM/DMARC.
 */
export const receivedEmailSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: addressList,
    cc: addressList,
    received_for: addressList,
    subject: z.string().nullish(),
    html: z.string().nullish(),
    text: z.string().nullish(),
    headers: z.record(z.unknown()).nullish(),
    message_id: z.string().nullish(),
    authentication: z
      .object({
        spf: z.string().nullish(),
        dkim: z.string().nullish(),
        dmarc: z.string().nullish(),
      })
      .partial()
      .nullish(),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().nullish(),
            content_type: z.string().nullish(),
            size: z.number().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

export type ReceivedEmail = z.infer<typeof receivedEmailSchema>;

/** What `mail_message.attachments` holds. */
export type AttachmentNote = { filename: string; contentType: string | null; size: number | null };
