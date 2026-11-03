/**
 * Inspection photos' bytes (ADR 0080, C6 decision 8). Pure.
 *
 * The browser shrinks a photo before sending it (and re-drawing it on a canvas drops its metadata), but the server
 * never trusts that: every upload is identified by its own bytes, not its claimed type, and stripped again here —
 * JPEG APP1 (Exif, where a phone writes GPS, and XMP), APP13 (IPTC) and comments; PNG eXIf and text chunks. What is
 * kept is what draws the picture: JFIF (APP0), the colour profile (APP2), Adobe's colour transform (APP14).
 */

/** After the browser's resize; under the 4.5 MB a serverless request may carry. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
/** What the browser accepts from the camera before resizing it. */
export const MAX_CAMERA_BYTES = 10 * 1024 * 1024;
/** The long edge the browser resizes to. */
export const PHOTO_LONG_EDGE = 2048;

export type PhotoType = { contentType: 'image/jpeg'; ext: 'jpg' } | { contentType: 'image/png'; ext: 'png' };

export class PhotoBytesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoBytesError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** By the bytes, never the name or the claimed type. Null for anything else. */
export function photoType(bytes: Uint8Array): PhotoType | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return { contentType: 'image/png', ext: 'png' };
  return null;
}

/** APP0 JFIF, APP2 ICC profile, APP14 Adobe. Every other APPn and COM goes. */
const KEEP_JPEG_APP = new Set([0xe0, 0xe2, 0xee]);

function stripJpeg(src: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [src.subarray(0, 2)];
  let i = 2;
  while (i < src.length) {
    if (src[i] !== 0xff) throw new PhotoBytesError('That photo could not be read.');
    let marker = src[i + 1]!;
    // Fill bytes: any number of 0xFF before a marker.
    while (marker === 0xff && i + 2 < src.length) {
      i += 1;
      marker = src[i + 1]!;
    }
    if (marker === 0xda || marker === 0xd9) {
      // Start of scan (or an early end): the picture itself, copied as it is.
      out.push(src.subarray(i));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(src.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > src.length) throw new PhotoBytesError('That photo could not be read.');
    const length = (src[i + 2]! << 8) | src[i + 3]!;
    if (length < 2 || i + 2 + length > src.length) throw new PhotoBytesError('That photo could not be read.');
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!(isApp && !KEEP_JPEG_APP.has(marker)) && marker !== 0xfe) out.push(src.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  return concat(out);
}

const DROP_PNG_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(src: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [src.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= src.length) {
    const length = ((src[i]! << 24) >>> 0) + (src[i + 1]! << 16) + (src[i + 2]! << 8) + src[i + 3]!;
    const type = String.fromCharCode(src[i + 4]!, src[i + 5]!, src[i + 6]!, src[i + 7]!);
    const end = i + 12 + length;
    if (end > src.length) throw new PhotoBytesError('That photo could not be read.');
    if (!DROP_PNG_CHUNKS.has(type)) out.push(src.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return concat(out);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The photo without its metadata, and what it is. Throws for anything that is not a JPEG or PNG we can read. */
export function stripPhotoMetadata(bytes: Uint8Array): { bytes: Uint8Array; type: PhotoType } {
  const type = photoType(bytes);
  if (!type) throw new PhotoBytesError('Photos must be JPEG or PNG.');
  if (bytes.length > MAX_PHOTO_BYTES) throw new PhotoBytesError('That photo is too large.');
  return { bytes: type.ext === 'jpg' ? stripJpeg(bytes) : stripPng(bytes), type };
}

/** Whether a JPEG still carries an Exif block (the tests' and the smoke check's question). Pure. */
export function hasExif(bytes: Uint8Array): boolean {
  const sig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  for (let i = 0; i + sig.length <= bytes.length; i++) if (sig.every((b, j) => bytes[i + j] === b)) return true;
  return false;
}
