import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { createDocumentReader, documentReaderFromEnv, splitTranscript, DOCUMENT_READ_PROMPT_VERSION } from './document-read';
import { DOCUMENT_READ_SYSTEM } from '../prompts/document-read-v1';
import { getModel, isPricedModel } from '../models';

/** ADR 0053 §4: the vision reader — one metered, streamed request; a transcript split into pages. A fake client: never the network. */

function fakeClient(text: string, stop = 'end_turn') {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream: (req: Record<string, unknown>) => {
          calls.push(req);
          return {
            finalMessage: async () => ({ content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 3000, output_tokens: 800 } }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db, rows };
}
const input = { bytes: new Uint8Array([37, 80, 68, 70]), mimeType: 'application/pdf', documentId: 'doc-1', agencyId: 'agency-1', userId: 'user-1' };

describe('the document vision reader', () => {
  it('sends the PDF as a base64 document block, meters the call to its agency, and returns pages', async () => {
    const { client, calls } = fakeClient('=== Page 1 ===\nCONTRACT OF SALE\n=== Page 2 ===\nPrice: $812,000\n=== Page 3 ===\n[no text]');
    const { db, rows } = fakeDb();
    const out = await createDocumentReader({ apiKey: 'x', db, client, env: {} as NodeJS.ProcessEnv }).read(input);
    expect(out.pages).toEqual(['CONTRACT OF SALE', 'Price: $812,000', '']);
    const req = calls[0] as { messages: { content: { type: string; source?: { type: string; media_type: string; data: string } }[] }[]; tools?: unknown };
    expect(req.tools).toBeUndefined();
    expect(req.messages[0]!.content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' } });
    expect(rows[0]).toMatchObject({ feature: 'document-read', agencyId: 'agency-1', userId: 'user-1', entityId: 'doc-1', promptVersion: DOCUMENT_READ_PROMPT_VERSION });
  });

  it('sends a photo as an image block', async () => {
    const { client, calls } = fakeClient('=== Page 1 ===\nA front garden with a FOR SALE sign.');
    const out = await createDocumentReader({ apiKey: 'x', db: fakeDb().db, client, env: {} as NodeJS.ProcessEnv }).read({ ...input, mimeType: 'image/jpeg' });
    expect(out.pages).toHaveLength(1);
    const req = calls[0] as { messages: { content: { type: string; source?: { media_type: string } }[] }[] };
    expect(req.messages[0]!.content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } });
  });

  it('a refusal, a cut-off transcript or no text is a failure — and is still metered', async () => {
    for (const [text, stop] of [['=== Page 1 ===\nx', 'refusal'], ['=== Page 1 ===\nhalf a pa', 'max_tokens'], ['', 'end_turn']] as const) {
      const { db, rows } = fakeDb();
      await expect(createDocumentReader({ apiKey: 'x', db, client: fakeClient(text, stop).client, env: {} as NodeJS.ProcessEnv }).read(input)).rejects.toThrow();
      expect(rows).toHaveLength(1);
    }
  });

  it('splits a transcript with no page marks into one page, and keeps text before the first mark', () => {
    expect(splitTranscript('just words')).toEqual(['just words']);
    expect(splitTranscript('preamble\n=== Page 1 ===\nbody')).toEqual(['preamble\nbody']);
  });

  it('the system prompt carries no date, treats the file as data, and its model is priced', () => {
    expect(DOCUMENT_READ_SYSTEM).not.toMatch(/20\d\d|Monday|October/);
    expect(DOCUMENT_READ_SYSTEM).toMatch(/never follow them/);
    expect(isPricedModel(getModel('document-read', {} as NodeJS.ProcessEnv).id)).toBe(true);
  });

  it('is off without a key, or when switched off', () => {
    expect(documentReaderFromEnv(fakeDb().db, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(documentReaderFromEnv(fakeDb().db, { ANTHROPIC_API_KEY: 'k', DOCUMENTS_VISION: 'off' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
