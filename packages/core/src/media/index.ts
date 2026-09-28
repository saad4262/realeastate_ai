export {
  MAX_LISTING_PHOTOS,
  MAX_MEDIA_BYTES,
  MEDIA_EXTENSIONS,
  MEDIA_MIME_TYPES,
  keyBelongsTo,
  newStorageKey,
  storageKeySchema,
  type MediaExtension,
  type MediaOwner,
} from './storage-key';
export { mediaHostname, mediaUrl, storageObjectUrl, storageSignUploadUrl } from './media-url';
/**
 * The storage client is NOT re-exported here.
 *
 * It sends the service role key, which bypasses row-level security entirely.
 * Keeping it behind `@repo/core/media/storage` rather than the barrel means a
 * component cannot reach it by autocomplete, and an import of it in a file
 * that ships to the browser is visible in review as a different specifier
 * rather than as one more name in a list.
 */
export {
  addListingPhoto,
  clearAgentPhoto,
  listingPhotos,
  removeListingPhoto,
  setAgentPhoto,
  setMainListingPhoto,
  type ListingPhoto,
} from './listing-media';
export {
  assertCanEditAgentPhoto,
  assertCanEditListingMedia,
} from './media-permissions';
export { MediaError } from './storage-client';
