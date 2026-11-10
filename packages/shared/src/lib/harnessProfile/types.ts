/** What one profile folder may hold. */
export const PROFILE_LIMITS = {
  maxFileBytes: 1_000_000,
  maxFiles: 500,
  maxTotalBytes: 5_000_000,
} as const;

/** Largest INSTRUCTIONS file: it is appended to a system prompt on every harness turn. */
export const MAX_INSTRUCTIONS_BYTES = 100_000;

/** The Git modes a stored file can have; every other mode is refused or normalised before this. */
export type ProfileFileMode = '100644' | '100755';

/** One file of a profile folder, path relative to the folder. */
export interface ProfileFile {
  path: string;
  mode: ProfileFileMode;
  bytes: Buffer;
}

/** A file as listed to an admin or stored beside a version: no content. */
export type ProfileFileEntry = {
  path: string;
  size: number;
  mode: ProfileFileMode;
};
