import { describe, expect, it } from 'vitest';
import {
  contactPropertyRelationEnum,
  contactRoleKindEnum,
  contactSourceEnum,
} from '@repo/db/schema';
import {
  CONTACT_PROPERTY_RELATIONS,
  CONTACT_ROLES,
  CONTACT_SOURCES,
  contactListQuerySchema,
  createContactSchema,
} from './contact-schema';

describe('the contact vocabularies match the database enums', () => {
  it('roles', () => expect([...CONTACT_ROLES]).toEqual([...contactRoleKindEnum.enumValues]));
  it('sources', () => expect([...CONTACT_SOURCES]).toEqual([...contactSourceEnum.enumValues]));
  it('property relations', () =>
    expect([...CONTACT_PROPERTY_RELATIONS]).toEqual([...contactPropertyRelationEnum.enumValues]));
});

describe('a new contact', () => {
  it('lower-cases the email, because that is how people are matched', () => {
    const parsed = createContactSchema.parse({ name: 'Tom', email: ' Tom@Example.COM ' });
    expect(parsed.email).toBe('tom@example.com');
  });

  it('needs some way to reach them', () => {
    expect(createContactSchema.safeParse({ name: 'Tom' }).success).toBe(false);
    expect(createContactSchema.safeParse({ name: 'Tom', phone: '0412 345 678' }).success).toBe(true);
  });

  it('turns blanks into nothing rather than empty strings', () => {
    const parsed = createContactSchema.parse({ name: 'Tom', email: 'tom@example.com', phone: '  ', nextAction: '' });
    expect(parsed.phone).toBeUndefined();
    expect(parsed.nextAction).toBeUndefined();
  });

  it('never assumes marketing consent', () => {
    expect(createContactSchema.parse({ name: 'Tom', email: 'tom@example.com' }).marketingConsent).toBe(false);
  });
});

describe('the directory filters', () => {
  it('drops what it does not recognise instead of failing the page', () => {
    expect(contactListQuerySchema.parse({ role: 'astronaut', page: '-3', assigned: 'bob' })).toEqual({
      role: undefined,
      assigned: undefined,
      q: undefined,
      source: undefined,
      page: 1,
    });
  });
});
