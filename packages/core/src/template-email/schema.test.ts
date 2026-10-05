import { describe, expect, it } from 'vitest';
import { emailBatchStatusEnum, emailRecipientStatusEnum, emailTemplateStatusEnum } from '@repo/db/schema';
import { renderMerge, templateInputSchema, unknownMergeFields, BATCH_STATUS_LABELS, TEMPLATE_STATUS_LABELS } from './schema';

const values = { first_name: 'Tom', full_name: 'Tom Smith', agent_name: 'Sara', agency_name: 'Alpha' };

describe('merge fields', () => {
  it('fills the four it knows, from SQL values', () => {
    expect(renderMerge('Hi {{first_name}}, from {{ agent_name }} at {{agency_name}}', values)).toBe('Hi Tom, from Sara at Alpha');
  });
  it('refuses a template with a field that does not exist or a stray brace', () => {
    expect(unknownMergeFields('Hi {{suburb}}')).toEqual(['suburb']);
    expect(unknownMergeFields('Hi {{first_name}')).toEqual(['an unclosed {{ or }}']);
    expect(templateInputSchema.safeParse({ name: 'X1', subject: 'Hi {{nmae}}', body: 'b' }).success).toBe(false);
    expect(templateInputSchema.safeParse({ name: 'X1', subject: 'Hi {{first_name}}', body: 'Body' }).success).toBe(true);
  });
  it('matches the database vocabularies', () => {
    expect(Object.keys(TEMPLATE_STATUS_LABELS)).toEqual([...emailTemplateStatusEnum.enumValues]);
    expect(Object.keys(BATCH_STATUS_LABELS)).toEqual([...emailBatchStatusEnum.enumValues]);
    expect(emailRecipientStatusEnum.enumValues).toContain('sending');
  });
});
