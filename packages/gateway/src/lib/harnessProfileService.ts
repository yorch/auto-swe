import type { PrismaClient } from '@auto-swe/shared';
import {
  type ProfileFile,
  type ProfileScanners,
  type ProjectPluginSkillsInput,
  type ProjectPluginSkillsResult,
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
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type {
  HarnessProfileBoundAgent,
  HarnessProfileFileEntry,
  HarnessProfileManifestDto,
  HarnessProfilePreview,
  HarnessProfileProjectionWarnings,
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

/** The seam for skill projection: production passes `projectPluginSkills`. */
export type ProjectPluginSkills = (
  db: PrismaClient,
  input: ProjectPluginSkillsInput
) => Promise<ProjectPluginSkillsResult>;

/**
 * Project a profile version's skills for runtimes other than `claude-code`. The approval has
 * already happened, so a failure here never throws: it is logged by name only (never the error's
 * text) and comes back as `failed: true`, and anything the projection refused is returned as it
 * is so the admin sees it.
 */
export async function projectProfileSkills(
  project: ProjectPluginSkills,
  db: PrismaClient,
  input: ProjectPluginSkillsInput,
  log: { warn: (obj: object, msg: string) => void }
): Promise<HarnessProfileProjectionWarnings> {
  try {
    const result = await project(db, input);
    return {
      created: result.created,
      failed: false,
      refused: result.refused,
      updated: result.updated,
    };
  } catch (err) {
    log.warn(
      { errorName: err instanceof Error ? err.name : 'Error', profile: input.profileName },
      'plugin skill projection failed; the approval stands'
    );
    return { created: [], failed: true, refused: [], updated: [] };
  }
}

const MAX_BOUND_AGENT_LINEAGES = 500;

/**
 * The agents (the newest version of each lineage) that name a profile, across every scope, with
 * whether a TEAM agent is stranded: its team has no enablement, so its new runs fail closed.
 * Admin-wide on purpose, so both reads state their reach.
 */
export async function boundAgentsForProfile(
  prisma: PrismaClient,
  profile: { id: string; name: string },
  opts: { teamId?: string } = {}
): Promise<HarnessProfileBoundAgent[]> {
  const rows = await runUnscoped(
    'admin lists the agents bound to a plugin at every scope',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        orderBy: { version: 'desc' },
        select: {
          channelId: true,
          key: true,
          orgId: true,
          scope: true,
          teamId: true,
          version: true,
          workflowTemplateId: true,
        },
        take: MAX_BOUND_AGENT_LINEAGES * 4,
        where: {
          harnessProfiles: { has: profile.name },
          isActive: true,
          ...(opts.teamId ? { scope: 'TEAM' as const, teamId: opts.teamId } : {}),
        },
      })
  );
  // The highest version of each lineage that names the profile.
  const lineages = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const id = [r.key, r.scope, r.teamId, r.orgId, r.channelId, r.workflowTemplateId].join(':');
    if (!lineages.has(id)) {
      lineages.set(id, r);
    }
  }
  const candidates = [...lineages.values()].slice(0, MAX_BOUND_AGENT_LINEAGES);
  if (candidates.length === 0) {
    return [];
  }
  // A lineage with a newer version than the one that names the profile has moved on from it.
  const newer = await runUnscoped(
    'admin checks whether a bound agent lineage has a newer version',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        select: {
          channelId: true,
          key: true,
          orgId: true,
          scope: true,
          teamId: true,
          workflowTemplateId: true,
        },
        where: {
          OR: candidates.map((c) => ({
            channelId: c.channelId,
            key: c.key,
            orgId: c.orgId,
            scope: c.scope,
            teamId: c.teamId,
            version: { gt: c.version },
            workflowTemplateId: c.workflowTemplateId,
          })),
        },
      })
  );
  const moved = new Set(
    newer.map((r) =>
      [r.key, r.scope, r.teamId, r.orgId, r.channelId, r.workflowTemplateId].join(':')
    )
  );
  const current = candidates.filter(
    (c) =>
      !moved.has([c.key, c.scope, c.teamId, c.orgId, c.channelId, c.workflowTemplateId].join(':'))
  );
  const enabledTeams = new Set(
    (
      await runUnscoped('admin lists the teams that enabled a plugin', ['PluginEnablement'], () =>
        prisma.pluginEnablement.findMany({
          select: { teamId: true },
          where: { profileId: profile.id },
        })
      )
    ).map((e) => e.teamId)
  );
  return current
    .map((c) => ({
      key: c.key,
      scope: c.scope,
      stranded: c.scope === 'TEAM' && (c.teamId === null || !enabledTeams.has(c.teamId)),
      teamId: c.teamId,
      version: c.version,
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.scope.localeCompare(b.scope));
}
