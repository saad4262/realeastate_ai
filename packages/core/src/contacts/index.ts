export {
  listContacts,
  ContactError,
  CONTACT_NOT_FOUND,
  type ContactPage,
  type ContactRow,
} from './list-contacts';
export { getContact, type ContactView, type DuplicateSuggestion } from './get-contact';
export {
  createContact,
  updateContact,
  assignContact,
  listContactAssignees,
  type ContactAssignee,
} from './write-contacts';
export { mergeContacts } from './merge-contacts';
export { backfillContacts, type BackfillReport } from './backfill';
export {
  visibleContactIdsSql,
  narrowedContactIdsSql,
  contactAccessColumns,
  contactResource,
  mayReadContact,
  idArray,
  type ContactAccessFacts,
} from './visibility';
export { auPhoneKey, PHONE_KEY_SAMPLES } from './phone';
export * from './contact-schema';
