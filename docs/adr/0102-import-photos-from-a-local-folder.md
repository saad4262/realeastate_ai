# 0102 — Listing import: photos from a folder on the agent's computer

**Status:** ACCEPTED, 2026-11-25 (the user). **Built** 2026-11-25 (core and screens, Claude Code on the user's instruction), branch `feat/import-photo-folder`; see "As built". Amends ADR 0029 §8 (the zip option is replaced by this).

**Context.** The CSV import (ADR 0029) takes photos only as links (`photo_urls`). That covers an
agency whose photos already sit online (an old CRM, portal or website export). It does not cover
the common small-agency case: the photos are only on a computer, one folder per property, usually
named by address (`14 Henry Street Pakenham/`), sometimes nested
(`2026 Listings/Pakenham/14 Henry Street Pakenham/Photos/1.jpg`). Listing 1,000 properties
must not mean 1,000 manual uploads, renaming folders, or putting links in a spreadsheet.

Research (2026-11-25): every bulk tool on the market does the same thing: a data file plus a
photo folder or zip, matched by name (Shopify image apps by SKU in the file name, Ecwid's zip plus
CSV, Easy Property Listings' REAXML plus zip). Browsers can read a whole folder natively
(`<input webkitdirectory>` and folder drag-and-drop), so no extension or zip is needed. A zip of
1,000 listings is many GB and cannot pass through Vercel (4.5 MB a request) or be unpacked in a
serverless function. Uploading from the browser straight to Storage avoids both limits.

## Decision

1. **One extra, optional step on the import screen: "Add photos from a folder".** It is offered
   after the dry run (rows are validated and geocoded, so their addresses are known) and before
   Import. The person drops the folder, or picks it with the button (the button works in every
   browser, while drag-and-drop of folders needs checking in Safari, see Tests). Nothing is
   uploaded at this point: the browser sends only the **folder paths, each file's name and
   size**, never the files.

2. **Matching is a pure function in `packages/core/src/imports/folder-match.ts`**, run on the
   server and tested without a database. For each file, walk its folders **from the deepest
   up**, and stop at the first folder that matches a row:
   - **Address match:** the folder name is normalised with the same rules as `addressKey`
     (`squash`, `normaliseStreet`, unit prefixes, "2/6E", "2-6E" and "Unit 2 6E" read as unit 2
     of 6E). It matches a row when its unit, number and street equal the row's, and any words
     left over are only the row's suburb, state or postcode. "14 Henry St", "14 Henry Street
     Pakenham" and "14 henry street pakenham vic 3810" all match the same row.
   - **ID match:** the folder name equals the row's `external_id` (case-insensitive).
   - **Never guessed (ADR 0013's rule):** if a folder matches two rows (for example "14 Henry
     Street" with no suburb, and the file has that street in two suburbs), the folder is
     reported as ambiguous and gets nothing. One wrong photo on one vendor's ad is worse than a
     missing one.
   - Folders that are not addresses (`Photos`, `2026 Listings`, `Pakenham`) simply do not match,
     and the walk continues upward. This is what lets an agency drop its existing folder tree as
     it is.
   - Ignored without a report: hidden files, `.DS_Store`, `Thumbs.db`, and anything that is not
     `jpg`, `jpeg`, `png`, `webp` or `avif`. Reported: `heic` ("convert to JPEG; Chrome cannot
     read iPhone photos"), and a file over 40 MB before resizing.

3. **Order and kind.** Within a listing, files are in natural name order (`2.jpg` before
   `10.jpg`), and the first one is the main photo. A file or folder whose name contains
   "floorplan" or "floor plan" becomes a floorplan (`MAX_FLOORPLANS`). After
   `MAX_LISTING_PHOTOS` (20), the rest are listed as "not used: a listing carries 20 photos".
   A row that already has `photo_urls` in the CSV keeps its links, and a folder that also
   matches it is reported and not used. The file is the stronger statement.

4. **No migration.** The plan is stored in the row's existing `listing_import_row.photos` jsonb,
   as entries `{ path, size, kind?, status: 'local' }`. The existing link worker selects only
   `status = 'pending'`, so it never tries to fetch a local file. `local` becomes `done` or
   `failed` (with why), the same as a link. The counts query gains `photosLocal`. A new dry run
   (mapping changed) clears the plan, the same as everything else the dry run wrote.

5. **Upload happens from the browser, after Import has created the listings** (a storage key is
   `listings/<listingId>/<uuid>.<ext>`, so the listing must exist first):
   - **Resize first, in the browser,** with the listing page's own `prepareImage` (PLATFORM-PLAN
     5.8): longest side 2,560 px for a photo and 3,000 for a floorplan, JPEG 0.85 (a PNG stays
     PNG). This turns a ~3 MB original into a few hundred KB, so 20,000 photos are a few GB, not
     ~60 GB. It also drops EXIF, including GPS, before a photo becomes public.
   - **Signed URLs in batches:** `signImportPhotos(db, actor, importId, rowPhotoRefs[])` takes at
     most 50 photos at a time. It checks `listing_import:run` on the import once, checks that
     every row belongs to that import and has a `listingId`, and returns one `signUpload` per
     photo (a key under that listing). The browser never names a listing.
   - **4 uploads at a time** with `PUT`, then **confirm in batches:**
     `confirmImportPhotos(db, actor, importId, done[])` checks each object with `describeObject`
     (outside any transaction, as `addListingPhoto` does), then writes the batch's `media` rows
     and the row statuses in **one transaction**, never one transaction per photo. A photo that
     is missing or the wrong type becomes `failed` with the reason. The rest of the batch goes
     in.
   - **Resume:** the browser keeps the `File` objects only in memory. After a reload, closed tab
     or sleep, the import page says "N photos still on your computer: drop the same folder to
     carry on". Re-dropping matches by `path + size` and uploads only what is not `done`.
     The cron tick cannot do this part, because the files are on the person's computer. The
     page says so while it runs: "Keep this tab open".

6. **Who can do it.** Exactly the import's own rules (ADR 0029): only the person running the
   import can attach and upload, and an agent's import still makes `pending` listings whose
   photos an admin sees on approval. No new permission action. Each sign and confirm
   re-derives the listing from the import row, never from the request.

## Screens (Cursor, `apps/console/components/imports/`)

- **Dry run page:** an "Add photos from a folder" card (drop zone and button). After the drop,
  a summary: "812 listings matched · 15,904 photos · 188 listings without photos · 6 folders not
  matched · 2 ambiguous", with each list expandable and downloadable. The row report gains a
  Photos column ("18 from folder" / "from links" / "none").
- **After Import:** a Photos progress bar (uploaded / left / failed, speed, time left), Pause,
  and Retry failed. When the tab is reloaded: the "drop the same folder" prompt.
- No new page. The listing page's own uploader is unchanged.

## Tests

- Unit `folder-match.test.ts`: nested paths match at any level, and the deepest match wins.
  "14 Henry St" = "14 Henry Street Pakenham VIC 3810". "2-6E Main St", "2/6E" and "Unit 2 6E"
  are the same unit. "6 Main St" ≠ "6E Main St". An ambiguous folder gets nothing. `Photos`
  and `2026 Listings` never match. External id match. Natural order. Floorplan by name.
  The 21st photo is reported. CSV links win.
- Unit: the link worker never picks a `local` entry. A re-drop skips `done` by path and size.
- Permission tests: another member (and an admin who is not the uploader) cannot sign or
  confirm. A row from another import is refused. A key for another listing is refused by
  `keyBelongsTo`.
- `confirmImportPhotos` with 50 photos opens one transaction for the batch (not one per photo).
- **Break-tests (each must go red):** match the shallowest folder instead of the deepest. Let
  an ambiguous folder take the first row. Let the worker fetch `local`. Take the listing id
  from the request. Confirm without `describeObject`.
- TEST-PLAN rows (needs a browser): a real 30-listing nested folder on Chrome, Edge, Safari and
  Firefox (both the button and drag-and-drop). Close the tab halfway and resume. Upload time for
  500 photos on a home connection, from which the 1,000-listing estimate is projected. Do not
  load thousands of photos into dev Storage.

## Not in this ADR (later, if customers ask)

- Dropbox or Google Drive folders: they need a server (Uppy Companion) or a wider Drive scope,
  which ADR 0029 refused.
- Matching by file-name prefix (`AG-1001_1.jpg`): the folder rules cover how agencies store
  photos today.
- HEIC conversion in Chrome, and uploads that continue after the tab closes.

## Open questions (recommended answer first)

1. **Resize** — *yes*, decided: the same sizes as the listing page's uploader (2,560 / 3,000 px).
2. **A folder that matches a listing already imported earlier** (a second import, the same
   addresses) — *only rows of this import*, so a re-drop can never add photos to a listing that
   already has them.

## Added by the user, 2026-11-25: every listing says what photos it got

Links or folder, the person must see per property: "14 Henry St: 18 in", "9 Stranger St: no photos",
"3 Golden Wattle Ct: 1 failed (why)". Built as:
- `importReport(...).photoSummary` per row: `{ source: links | folder | none, total, done, waiting, failed }`;
  `importReport(..., { photos: 'missing' })` lists the listings with no photo or a failed one.
- `getImport().counts`: `listingsWithPhotos`, `listingsWithoutPhotos`, `listingsWithFailedPhotos`, `photosLocal`.
- The downloadable CSV report: `address, photos_from, photos_in, photos_waiting, photos_failed` and each failed
  photo's link or path with the reason.

## As built (core, 2026-11-25)

- `imports/folder-match.ts` (pure) and `imports/folder-photos.ts`: `attachPhotoFolder`, `signImportPhotos`,
  `confirmImportPhotos`, exported from `@repo/core/imports`. `PHOTO_BATCH` = 50, `MAX_FOLDER_FILES` = 30,000.
- **The dry run now writes each row's link entries** (`pending`), so the report says what every listing will get
  before Import. A duplicate row gets none (an "Update from file" takes its links at Import, as before). The worker
  still fetches only rows that are `imported`/`updated`. Import keeps a row's folder plan when the file gave it no
  links, and the file's links win when it did.
- **A folder can be dropped after the dry run, during the import, or after it is done**: a forgotten folder is
  not a new import. Dropping again resumes: `done` (same path and size) stays, the rest waits again, so a re-drop
  is also "Retry failed". Rows the drop does not reach keep what they had, so two folders add up.
- `signImportPhotos` also signs a `failed` entry (retry without a re-drop). Keys are always `.jpg`: the browser
  sends the shrunk JPEG, never the original.
- `confirmImportPhotos` locks the batch's rows (`FOR UPDATE`) in its one transaction, so a second tab confirming
  the same photo waits and then sees it `done`: recorded once (smoke-checked). Photos are recorded through
  `recordListingPhoto` / `recordListingFloorplan`, the row halves split out of `addListingPhoto` /
  `addListingFloorplan` (same rules: key belongs to the listing, the 20-photo and 4-floorplan limits, first photo main).
- Smoke group **"Listing import: photos from a folder"** (2 checks, dev, in rollback): passed. Unit
  `folder-match.test.ts` (10). Break-tests red: deepest→shallowest folder, ambiguous takes the first row, any
  trailing words accepted (unit); the import overwriting the folder plan, confirm without the storage check, signing
  a path outside the plan (smoke).

### Screens as built (2026-11-25)

`components/imports/folder-photos.tsx` (`FolderPhotos`, `PhotoReport`), shown on the import page after the dry run;
actions in `lib/import-actions.ts`. The upload starts by itself once every listing of the file is in; Pause, "Carry on",
"Try the failed photos again", and after a reload "N photos are still on your computer: drop or choose the same folder".
`waitingFolderPhotos` (core) lists what is left. The sign call carries each prepared file's type (a PNG floorplan keeps
a `.png` key); confirm carries its width and height.

**Browser run (Playwright, local console on dev, 2026-11-25):** Chromium and WebKit, the folder button: Y18, Y19, Y21,
Y22 (reload mid-upload, re-drop: 24 of 24, nothing doubled), Y23 and Y24 all pass; in the database 1 + 3 photos and a
floorplan + 20, one main each, 2560 px, in folder order (1, 10, 20 checked by eye). **Not run:** Firefox (Playwright's
Firefox will not start on this macOS), Edge (not installed; same engine as Chromium), dragging a folder (a real drag cannot
be scripted; the button path is the same after the file list), Y25 timing (locally every action crosses to Sydney: 2–4 s,
and a confirm of 24 photos 40–50 s; on Vercel `syd1` beside the database those round trips are ~1 ms, so time it live).

**Found, not this ADR's:** the dry run accepted Google's nearest match for made-up addresses (the template's
"2/6E Main Street, Officer" became "34 Station St, Officer"; "3 Golden Wattle Court, Berwick" became "43 Golden Wattle Ct,
Cranbourne"). The folder matching uses the file's own address, so photos still went to the right rows, but the pin and
formatted address are Google's. ADR 0029 says such an address should be ✗ "Check the address".

### For the screens (written before they were built; kept for the record)

1. Server actions in the import route that call `attachPhotoFolder(db, actor, id, files)`,
   `signImportPhotos(db, actor, id, refs)` and `confirmImportPhotos(db, actor, id, { uploaded, failed })`,
   mapping `ImportError` like the other import actions. A 30,000-path drop is ~2 MB, under the 4.4 MB action limit.
2. The folder card (after the dry run, and on a done import): `<input type="file" webkitdirectory multiple>` plus
   a drop zone. Send `{ path: file.webkitRelativePath || entry path, size: file.size }` only; keep the `File`s in a
   `Map` by path. Show the `FolderReport`: listings, photos, without photos, unmatched folders, ambiguous, skipped,
   links win.
3. Upload loop while `counts.photosLocal > 0`: take up to 50 `local` entries from `importReport` rows, sign, shrink
   each (`createImageBitmap` → `OffscreenCanvas`, longest side 2048, `convertToBlob({ type: 'image/jpeg', quality:
   0.85 })`), PUT to the signed URL with `x-upsert: false` and the token, 4 at a time, then confirm the batch
   (`failed` for any the browser could not read or send). A file not in the `Map` (page reloaded) → the "drop the
   same folder to carry on" prompt.
4. The report table: a Photos column from `photoSummary` ("18 in", "3 waiting", "1 failed", "none"), a
   "Listings without photos" filter (`photos: 'missing'`), and the counts line.
