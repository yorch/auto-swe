import {
  type ProfileFile,
  type ProfileScanners,
  readProfileFolder,
  scanProfile,
  type ValidatedProfile,
  validateProfile,
  warningsHash,
} from '@auto-swe/shared/lib/harnessProfile';
import {
  normaliseLocation,
  type SkillSourceDeps,
  type SourceLocation,
} from '@auto-swe/shared/lib/skillSource';
import type {
  HarnessProfileFileEntry,
  HarnessProfileManifestDto,
  HarnessProfilePreview,
  HarnessProfileVersionDto,
} from '@auto-swe/shared/types/api';

/** The folder cannot be a profile; `errors` are fixed sentences that name display-safe paths. */
export class HarnessProfileInvalid extends Error {
  constructor(readonly errors: string[]) {
    super('the folder is not a valid harness profile');
    this.name = 'HarnessProfileInvalid';
  }
}

export interface ReadProfile {
  location: SourceLocation;
  sha: string;
  files: ProfileFile[];
  validated: ValidatedProfile;
  /** Structure warnings, then scanner findings. */
  warnings: string[];
}

/** Test seams: the fetch machinery and the scanners. Production passes neither. */
export interface ProfileReadDeps {
  source?: SkillSourceDeps;
  scanners?: ProfileScanners;
}

/**
 * Read a profile folder at an exact commit, validate it and scan it. Nothing is executed and
 * nothing is stored. Throws {@link HarnessProfileInvalid} for a folder that breaks the contract and
 * a `SkillSourceError` for anything the fetch refuses (host policy, limits, a moved ref).
 */
export async function readAndCheckProfile(
  input: SourceLocation,
  opts: { expectSha?: string; atSha?: string },
  deps: ProfileReadDeps = {}
): Promise<ReadProfile> {
  const location = normaliseLocation(input);
  const read = await readProfileFolder(location, opts, deps.source);
  if (read.problems.length > 0) {
    throw new HarnessProfileInvalid(read.problems);
  }
  const validation = validateProfile(read.files);
  if (!validation.ok) {
    throw new HarnessProfileInvalid(validation.errors);
  }
  const scan = await scanProfile(
    read.files,
    validation.manifest,
    validation.pluginDirs,
    deps.scanners
  );
  return {
    files: read.files,
    location,
    sha: read.sha,
    validated: validation,
    warnings: [...validation.warnings, ...scan],
  };
}

/**
 * One file of a profile folder for review, downloading that blob and no other (the listing is
 * still checked in full). Null when the folder holds no such file. Does not validate or scan the
 * profile: the reviewed bytes are the same git object the full read would verify.
 */
export async function readFileForReview(
  input: SourceLocation,
  opts: { atSha: string },
  path: string,
  deps: ProfileReadDeps = {}
): Promise<ReviewedFile | null> {
  const read = await readProfileFolder(
    normaliseLocation(input),
    { ...opts, onlyPath: path },
    deps.source
  );
  if (read.problems.length > 0) {
    throw new HarnessProfileInvalid(read.problems);
  }
  return reviewFile(read.files, path);
}

export function previewOf(
  read: ReadProfile,
  extra: Pick<HarnessProfilePreview, 'conflicts' | 'matchesVersion'>
): HarnessProfilePreview {
  const { host, owner, path, ref, repo } = read.location;
  return {
    ...extra,
    contentHash: read.validated.contentHash,
    files: read.validated.fileIndex,
    manifest: read.validated.manifest as HarnessProfileManifestDto,
    sha: read.sha,
    source: { host, owner, path, ref, repo },
    totalBytes: read.validated.totalBytes,
    warnings: read.warnings,
    warningsHash: warningsHash(read.warnings),
  };
}

/** The largest file text returned for review. */
export const MAX_REVIEW_TEXT_CHARS = 200_000;

export interface ReviewedFile {
  path: string;
  size: number;
  mode: string;
  /** True when the file is not text (invalid UTF-8 or a NUL byte); `text` is then null. */
  binary: boolean;
  text: string | null;
  /** True when `text` was cut at {@link MAX_REVIEW_TEXT_CHARS}. */
  truncated: boolean;
}

/** One file of a read profile as an admin reviews it. */
export function reviewFile(files: ProfileFile[], path: string): ReviewedFile | null {
  const f = files.find((x) => x.path === path);
  if (!f) {
    return null;
  }
  let text: string | null = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(f.bytes);
  } catch {
    text = null;
  }
  if (text?.includes('\0')) {
    text = null;
  }
  const truncated = text !== null && text.length > MAX_REVIEW_TEXT_CHARS;
  return {
    binary: text === null,
    mode: f.mode,
    path: f.path,
    size: f.bytes.length,
    text: text === null ? null : truncated ? text.slice(0, MAX_REVIEW_TEXT_CHARS) : text,
    truncated,
  };
}

interface VersionRow {
  version: number;
  commitSha: string;
  contentHash: string;
  manifest: unknown;
  fileIndex: unknown;
  fileCount: number;
  totalBytes: number;
  scanWarnings: unknown;
  approvedById: string | null;
  createdAt: Date;
}

/** Columns of a version row that never include the file blob. */
export const VERSION_SELECT = {
  approvedById: true,
  commitSha: true,
  contentHash: true,
  createdAt: true,
  fileCount: true,
  fileIndex: true,
  manifest: true,
  scanWarnings: true,
  totalBytes: true,
  version: true,
} as const;

export function versionDto(row: VersionRow): HarnessProfileVersionDto {
  return {
    approvedById: row.approvedById,
    commitSha: row.commitSha,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    fileCount: row.fileCount,
    files: row.fileIndex as HarnessProfileFileEntry[],
    manifest: row.manifest as HarnessProfileManifestDto,
    totalBytes: row.totalBytes,
    version: row.version,
    warnings: row.scanWarnings as string[],
  };
}
