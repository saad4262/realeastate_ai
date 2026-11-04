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
// ADR 0080, C9 Immersive: floorplans, and video and tour links as `provider:id` on an allowlist.
export {
  FLOORPLAN_FEATURE,
  LINK_PROVIDERS,
  MAX_FLOORPLANS,
  MAX_TOURS,
  MAX_VIDEOS,
  PROVIDER_NAME,
  ROOM_LABEL,
  addListingFloorplan,
  addListingLink,
  editableExtras,
  embedUrl,
  floorplanRoomsSchema,
  floorplanToolResult,
  linkKey,
  listingExtras,
  parseMediaLink,
  readFloorplanBatch,
  readLinkKey,
  removeListingExtra,
  roomNames,
  unreadFloorplans,
  type FloorplanReader,
  type FloorplanRooms,
  type ListingExtras,
  type LinkProvider,
  type MediaLink,
} from './extras';
