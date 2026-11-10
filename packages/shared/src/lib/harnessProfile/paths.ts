import { HIDDEN_CHARACTERS } from '../skillSource/display.js';

/** Longest path segment and whole path, in UTF-8 bytes (a common filesystem name limit; sizes the snapshot bound). */
export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_BYTES = 1024;

/**
 * Why a path from a profile folder cannot be stored, as a fixed string; null when it is fine.
 * `rel` is relative to the profile folder. A path is refused, never repaired: a repaired path
 * would name a different file than the one the admin reviewed.
 */
export function unsafeProfilePath(rel: string): string | null {
  if (rel === '') {
    return 'empty path';
  }
  if (rel.startsWith('/')) {
    return 'absolute path';
  }
  if (rel.includes('\\')) {
    return 'backslash in path';
  }
  if (rel.replace(HIDDEN_CHARACTERS, '?') !== rel) {
    return 'control or invisible characters in path';
  }
  if (Buffer.byteLength(rel, 'utf8') > MAX_PATH_BYTES) {
    return `path longer than ${MAX_PATH_BYTES} bytes`;
  }
  const segments = rel.split('/');
  if (segments.some((s) => Buffer.byteLength(s, 'utf8') > MAX_SEGMENT_BYTES)) {
    return `path segment longer than ${MAX_SEGMENT_BYTES} bytes`;
  }
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return "empty, '.' or '..' segment in path";
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    return "'.git' segment in path";
  }
  return null;
}

/** The key two paths collide on: Unicode-normalised and case-folded, as a case-insensitive filesystem sees them. */
export const collisionKey = (rel: string): string => rel.normalize('NFC').toLowerCase();
