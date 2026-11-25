import {
  autoRunSourcesOf,
  type ProfileFile,
  packFiles,
  projectPluginSkills,
  unpackFiles,
  warningsHash,
} from '@auto-swe/shared/lib/harnessProfile';
import { readMarketplace } from '@auto-swe/shared/lib/marketplace';
import { SKILL_SOURCE_ERRORS, SkillSourceError } from '@auto-swe/shared/lib/skillSource';
import { checkHarnessProfile } from '@auto-swe/shared/lib/skillSourceSync';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type {
  HarnessProfileDetail,
  HarnessProfileHookChanges,
  HarnessProfileStatus,
  HarnessProfileSummary,
  HarnessProfileTrackStatus,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  boundAgentsForProfile,
  HarnessProfileInvalid,
  type ProfileReadDeps,
  type ProjectPluginSkills,
  previewOf,
  projectProfileSkills,
  type ReadProfile,
  readAndCheckProfile,
  readFileForReview,
  reviewFile,
  VERSION_SELECT,
  versionDto,
} from '../lib/harnessProfileService.js';
import { sendError } from '../lib/httpErrors.js';
import { synthesizeEntryProfile } from '../lib/marketplaceService.js';
import { pluginMcpDetail } from '../lib/pluginMcpMappings.js';
import { setProjectedSkillsActive } from '../lib/pluginSkillPolicy.js';
import { hasHookChanges, hookChangesBetween } from '../lib/pluginSnapshot.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { registerPluginMcpMappingRoutes } from './pluginMcpMappings.js';
import { STATUS_BY_CODE } from './skillSources.js';

/**
 * Admin API for harness profiles: folders of a GitHub / GitHub Enterprise repository (Claude Code
 * plugins, instructions) that an administrator reads at an exact commit, reviews and approves into
 * an immutable, content-hashed snapshot. ADMIN-only and GLOBAL: a profile's hooks and scripts run
 * in the run container, so who may bring one in is a platform decision. See
 * `docs/harness-profiles.md`.
 *
 *   POST  /api/v1/platform/harness-profiles/preview              Read, validate, scan; writes nothing (with `file`: one file's text)
 *   POST  /api/v1/platform/harness-profiles                      Create the profile and its first version at the previewed commit
 *   GET   /api/v1/platform/harness-profiles                      List profiles with their latest version
 *   GET   /api/v1/platform/harness-profiles/:name                One profile with all its versions
 *   POST  /api/v1/platform/harness-profiles/:name/preview-update Read the profile's ref again; writes nothing
 *   POST  /api/v1/platform/harness-profiles/:name/accept         Add a version from a previewed commit
 *   PATCH /api/v1/platform/harness-profiles/:name                Disable / re-enable, and the hook switch (`hooksEnabled`)
 *   POST  /api/v1/platform/harness-profiles/:name/check          Ask the host which commit the ref names now (what the sweep does)
 *   GET   /api/v1/platform/harness-profiles/:name/enablements    The teams that enabled the profile
 *   PUT / DELETE /:name/mcp-mappings/:serverName                 Map a declared MCP server to a Connection (pluginMcpMappings.ts)
 *
 * There is no DELETE: an Agent may reference a profile by name, so a profile is disabled, not removed.
 */

const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const NameParams = z.object({ name: z.string().min(1).max(64) });

const Location = z.object({
  host: z.string().min(1).max(253).default('github.com'),
  owner: z.string().min(1).max(100),
  path: z.string().max(1000).default(''),
  ref: z.string().min(1).max(255),
  repo: z.string().min(1).max(100),
});

const PreviewBody = Location.extend({
  /** With `file`: the commit the preview showed. The ref must still resolve to it (else 409 SHA_MOVED). */
  file: z.string().min(1).max(1000).optional(),
  sha: Sha.optional(),
}).refine((b) => b.file === undefined || b.sha !== undefined, 'file needs sha');

const Hash = z.string().regex(/^[0-9a-f]{64}$/);

const CreateBody = Location.extend({
  acknowledgeWarnings: z.boolean().default(false),
  /** `contentHash` and `warningsHash` from the preview; the server re-reads and refuses 409 PREVIEW_STALE if either differs. */
  contentHash: Hash,
  /** Required and explicit: whether the plugin's hook configs are written into the run container. */
  hooksEnabled: z.boolean(),
  /** The commit the preview showed; the ref must still resolve to it. */
  sha: Sha,
  warningsHash: Hash,
});

const UpdatePreviewBody = z
  .object({
    file: z.string().min(1).max(1000).optional(),
    /** Read exactly this commit instead of resolving the profile's ref. */
    sha: Sha.optional(),
  })
  .refine((b) => b.file === undefined || b.sha !== undefined, 'file needs sha');

const AcceptBody = z.object({
  /** Needed when the profile has hooks on and the update changes its hook files. */
  acknowledgeHookChanges: z.boolean().default(false),
  acknowledgeWarnings: z.boolean().default(false),
  contentHash: Hash,
  /** The commit the update preview showed; the profile's ref must still resolve to it. */
  sha: Sha,
  warningsHash: Hash,
});

const PatchBody = z
  .object({
    /**
     * Turning hooks ON needs `expectedVersion` (the profile's latest version the admin reviewed);
     * the route answers 400 HOOKS_EXPECTED_VERSION_REQUIRED without it and 409 HOOKS_VERSION_STALE
     * when the profile has moved on.
     */
    expectedVersion: z.number().int().positive().optional(),
    hooksEnabled: z.boolean().optional(),
    status: z.enum(['DISABLED', 'OK']).optional(),
  })
  .refine((b) => b.status !== undefined || b.hooksEnabled !== undefined, 'nothing to change');

/** Thrown inside the PATCH transaction when the profile moved past the version the admin reviewed. */
class HooksVersionStale extends Error {}

const PROFILE_SELECT = {
  createdAt: true,
  description: true,
  hooksEnabled: true,
  host: true,
  id: true,
  lastCheckedAt: true,
  lastError: true,
  latestSha: true,
  latestVersion: true,
  marketplaceEntry: true,
  marketplaceSourceId: true,
  name: true,
  owner: true,
  path: true,
  ref: true,
  repo: true,
  status: true,
  trackStatus: true,
  updatedAt: true,
} as const;

interface ProfileRow {
  createdAt: Date;
  description: string;
  hooksEnabled: boolean;
  host: string;
  id: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  latestSha: string | null;
  latestVersion: number;
  marketplaceEntry: string | null;
  marketplaceSourceId: string | null;
  name: string;
  owner: string;
  path: string;
  ref: string;
  repo: string;
  status: HarnessProfileStatus;
  trackStatus: HarnessProfileTrackStatus;
  updatedAt: Date;
}

const summaryOf = (
  row: ProfileRow,
  latest: ReturnType<typeof versionDto> | null
): HarnessProfileSummary => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
  latest: latest && {
    approvedById: latest.approvedById,
    commitSha: latest.commitSha,
    contentHash: latest.contentHash,
    createdAt: latest.createdAt,
    fileCount: latest.fileCount,
    totalBytes: latest.totalBytes,
    version: latest.version,
    warnings: latest.warnings,
  },
  updatedAt: row.updatedAt.toISOString(),
});

export interface HarnessProfileRouteOptions {
  /** Test seam: replaces the fetch machinery and the scanners. */
  readDeps?: ProfileReadDeps;
  /** Test seam: replaces the skill projection. */
  projectSkills?: ProjectPluginSkills;
}

export const harnessProfileRoutes: FastifyPluginAsync<HarnessProfileRouteOptions> = async (
  fastify,
  options
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ capability: 'platform.catalog.manage' });
  const readDeps = options.readDeps ?? {};
  const projectSkills = options.projectSkills ?? (projectPluginSkills as ProjectPluginSkills);

  /**
   * The manifest a `strict: false` marketplace entry stands in for, re-derived from the CURRENT
   * catalog: the profile's marketplace source read at the source's pinned commit, the entry found
   * by name. The synthesized `plugin.json` therefore follows the marketplace pin, which moves only
   * through accept-update, so a catalog change is reviewed (and its hooks diffed) at that step,
   * while a plain re-read of an unchanged pin rebuilds byte-identical content (`matchesVersion`).
   * It is never taken from the stored version. Called only when the plugin folder has no
   * `plugin.json` of its own; a strict or missing entry, a gone or disabled source, or an
   * unreadable catalog fails closed.
   */
  const catalogPluginManifest = async (existing: ProfileRow): Promise<Record<string, unknown>> => {
    const refuse = () => new HarnessProfileInvalid(['the plugin folder has no plugin.json']);
    if (!existing.marketplaceSourceId) {
      throw refuse();
    }
    try {
      const source = await fastify.prisma.marketplaceSource.findUnique({
        select: {
          host: true,
          owner: true,
          path: true,
          pinnedSha: true,
          ref: true,
          repo: true,
          status: true,
        },
        where: { id: existing.marketplaceSourceId },
      });
      if (!source || source.status === 'DISABLED') {
        throw refuse();
      }
      const read = await readMarketplace(source, { atSha: source.pinnedSha }, readDeps.source);
      const entry = read.marketplace.entries.find((e) => e.name === existing.marketplaceEntry);
      if (entry?.installable && !entry.strict && entry.pluginManifest) {
        return entry.pluginManifest;
      }
    } catch {
      // Any failure reading the catalog is the same refusal.
    }
    throw refuse();
  };

  /**
   * Re-read a stored profile's source. A profile approved from a marketplace entry stores the
   * plugin folder itself (no profile.json), so it is wrapped exactly as approving the entry did.
   *
   * A `plugin.json` the folder has always wins (strict behaviour, nothing synthesized). When it
   * has none, the manifest is re-derived from the current catalog entry (see
   * `catalogPluginManifest`), never from the stored snapshot.
   */
  const readExisting = async (
    existing: ProfileRow,
    opts: { atSha?: string; expectSha?: string }
  ): Promise<ReadProfile> =>
    existing.marketplaceEntry
      ? synthesizeEntryProfile(existing, existing.name, existing.description, opts, readDeps, () =>
          catalogPluginManifest(existing)
        )
      : readAndCheckProfile(existing, opts, readDeps);

  /** A refused read as its fixed response; anything unexpected is rethrown to the error handler. */
  const readError = (err: unknown, reply: FastifyReply) => {
    if (err instanceof HarnessProfileInvalid) {
      return sendError(
        reply,
        422,
        'HARNESS_PROFILE_INVALID',
        'The folder is not a valid harness profile',
        { errors: err.errors }
      );
    }
    if (err instanceof SkillSourceError) {
      return sendError(
        reply,
        STATUS_BY_CODE[err.code],
        err.code === 'SHA_MOVED' ? 'SHA_MOVED' : `HARNESS_PROFILE_${err.code}`,
        SKILL_SOURCE_ERRORS[err.code]
      );
    }
    throw err;
  };

  const notFound = (reply: FastifyReply) =>
    sendError(reply, 404, 'NOT_FOUND', 'Harness profile not found');

  const unacknowledged = (reply: FastifyReply, warnings: string[]) =>
    sendError(
      reply,
      409,
      'WARNINGS_UNACKNOWLEDGED',
      'The profile has warnings; review them and send acknowledgeWarnings: true',
      { warnings }
    );

  /** What an approval names must still be what the server reads now: the content and the warnings. */
  const previewStale = (reply: FastifyReply, read: ReadProfile) =>
    sendError(
      reply,
      409,
      'PREVIEW_STALE',
      'The content or the warnings differ from the preview; review the fresh preview and approve again',
      {
        contentHash: read.validated.contentHash,
        warnings: read.warnings,
        warningsHash: warningsHash(read.warnings),
      }
    );
  const matchesPreview = (read: ReadProfile, body: { contentHash: string; warningsHash: string }) =>
    read.validated.contentHash === body.contentHash &&
    warningsHash(read.warnings) === body.warningsHash;

  /** Profiles whose name a new one would be confused with (case-insensitive). */
  const conflictsFor = async (name: string) =>
    fastify.prisma.harnessProfile.findMany({
      select: { name: true, status: true },
      where: { name: { equals: name, mode: 'insensitive' } },
    });

  /**
   * What reading `read` does to the hook files of the profile's latest stored version. When that
   * snapshot cannot be read back, nothing can be compared, so every hook source counts as added:
   * a plugin with hooks on is then never accepted without the acknowledgement.
   */
  const hookChangesFor = async (
    profile: { id: string; latestVersion: number },
    read: ReadProfile
  ): Promise<HarnessProfileHookChanges> => {
    const next = { files: read.files, manifest: read.validated.manifest };
    const prevRow = await fastify.prisma.harnessProfileVersion.findUnique({
      select: { files: true, manifest: true },
      where: { profileId_version: { profileId: profile.id, version: profile.latestVersion } },
    });
    let prev: { files: ProfileFile[]; manifest: { plugins?: string[] } } = {
      files: [],
      manifest: {},
    };
    if (prevRow) {
      try {
        prev = {
          files: unpackFiles(prevRow.files),
          manifest: prevRow.manifest as { plugins?: string[] },
        };
      } catch {
        // Unreadable: compare against nothing.
      }
    }
    return hookChangesBetween(prev, next);
  };

  // POST /harness-profiles/preview — reads, validates and scans; writes nothing.
  app.post(
    '/harness-profiles/preview',
    { onRequest: adminOnly, schema: { body: PreviewBody } },
    async (request, reply) => {
      const { file, sha, ...location } = request.body;
      try {
        if (file !== undefined) {
          const reviewed = await readFileForReview(
            location,
            { atSha: sha as string },
            file,
            readDeps
          );
          return reviewed ? { data: reviewed } : notFound(reply);
        }
        const read = await readAndCheckProfile(location, {}, readDeps);
        return {
          data: previewOf(read, {
            conflicts: await conflictsFor(read.validated.manifest.name),
            matchesVersion: null,
          }),
        };
      } catch (err) {
        return readError(err, reply);
      }
    }
  );

  // POST /harness-profiles — the profile and its first version, at the previewed commit.
  app.post(
    '/harness-profiles',
    { onRequest: adminOnly, schema: { body: CreateBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const {
        acknowledgeWarnings,
        contentHash,
        hooksEnabled,
        sha,
        warningsHash: warnedHash,
        ...location
      } = request.body;
      try {
        const read = await readAndCheckProfile(location, { expectSha: sha }, readDeps);
        if (!matchesPreview(read, { contentHash, warningsHash: warnedHash })) {
          return previewStale(reply, read);
        }
        if (read.warnings.length > 0 && !acknowledgeWarnings) {
          return unacknowledged(reply, read.warnings);
        }
        const { manifest } = read.validated;
        if ((await conflictsFor(manifest.name)).length > 0) {
          return sendError(
            reply,
            409,
            'HARNESS_PROFILE_NAME_EXISTS',
            'A harness profile with this name already exists'
          );
        }
        const created = await fastify.prisma.$transaction(async (tx) => {
          const { host, owner, path, ref, repo } = read.location;
          const profile = await tx.harnessProfile.create({
            data: {
              description: manifest.description,
              hooksEnabled,
              host,
              // The ref was just resolved to this commit, so it is also the newest one known.
              lastCheckedAt: new Date(),
              latestSha: read.sha,
              latestVersion: 1,
              name: manifest.name,
              owner,
              path,
              ref,
              repo,
              versions: {
                create: {
                  approvedById: actor.sub,
                  commitSha: read.sha,
                  contentHash: read.validated.contentHash,
                  fileCount: read.files.length,
                  fileIndex: read.validated.fileIndex,
                  files: new Uint8Array(packFiles(read.files)),
                  manifest,
                  scanWarnings: read.warnings,
                  totalBytes: read.validated.totalBytes,
                  version: 1,
                },
              },
            },
            select: { ...PROFILE_SELECT, versions: { select: VERSION_SELECT } },
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor,
            after: {
              acknowledgedWarnings: read.warnings.length,
              commitSha: read.sha,
              contentHash: read.validated.contentHash,
              fileCount: read.files.length,
              hooksEnabled,
              host,
              name: profile.name,
              owner,
              path,
              ref,
              repo,
              version: 1,
            },
            client: tx,
            entityId: profile.id,
            entityType: 'HarnessProfile',
          });
          return profile;
        });
        const { versions, ...row } = created;
        const latest = versions[0] ? versionDto(versions[0]) : null;
        const detail: HarnessProfileDetail = {
          ...summaryOf(row, latest),
          versions: latest ? [latest] : [],
        };
        // The approval stands whatever the projection does; its problems ride along.
        const projection = await projectProfileSkills(
          projectSkills,
          fastify.prisma,
          {
            commitSha: read.sha,
            createdById: actor.sub,
            files: read.files,
            manifest: manifest,
            profileId: created.id,
            profileName: created.name,
            version: 1,
          },
          request.log
        );
        return reply.status(201).send({ data: detail, projection });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'HARNESS_PROFILE_NAME_EXISTS',
            'A harness profile with this name already exists'
          );
        }
        return readError(err, reply);
      }
    }
  );

  // GET /harness-profiles
  app.get('/harness-profiles', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.harnessProfile.findMany({
      orderBy: { name: 'asc' },
      select: PROFILE_SELECT,
    });
    const latest = await fastify.prisma.harnessProfileVersion.findMany({
      select: { ...VERSION_SELECT, profileId: true },
      where: { OR: rows.map((r) => ({ profileId: r.id, version: r.latestVersion })) },
    });
    return {
      data: rows.map((row) => {
        const v = latest.find((x) => x.profileId === row.id);
        return summaryOf(row, v ? versionDto(v) : null);
      }),
    };
  });

  registerPluginMcpMappingRoutes(fastify, adminOnly);

  // GET /harness-profiles/:name
  app.get(
    '/harness-profiles/:name',
    { onRequest: adminOnly, schema: { params: NameParams } },
    async (request, reply) => {
      const row = await fastify.prisma.harnessProfile.findUnique({
        select: {
          ...PROFILE_SELECT,
          versions: { orderBy: { version: 'desc' }, select: VERSION_SELECT },
        },
        where: { name: request.params.name },
      });
      if (!row) {
        return notFound(reply);
      }
      const { versions, ...rest } = row;
      const dtos = versions.map(versionDto);
      const [boundAgents, enabledTeams] = await Promise.all([
        boundAgentsForProfile(fastify.prisma, row),
        runUnscoped('admin counts the teams that enabled a plugin', ['PluginEnablement'], () =>
          fastify.prisma.pluginEnablement.count({ where: { profileId: row.id } })
        ),
      ]);
      // The auto-run sources of the LATEST version: what turning hooks on would arm.
      let autoRunSources: HarnessProfileDetail['autoRunSources'] = [];
      const latestRow = await fastify.prisma.harnessProfileVersion.findUnique({
        select: { files: true, manifest: true },
        where: { profileId_version: { profileId: row.id, version: row.latestVersion } },
      });
      if (latestRow) {
        try {
          autoRunSources = autoRunSourcesOf(
            unpackFiles(latestRow.files),
            latestRow.manifest as { plugins?: string[] }
          )
            .map((a) => ({
              commands: a.commands,
              kind: a.kind,
              path: a.path,
              unreadable: a.unreadable ?? null,
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        } catch {
          autoRunSources = [
            {
              commands: [],
              kind: 'hooks-file',
              path: '(snapshot)',
              unreadable: 'unreadable snapshot',
            },
          ];
        }
      }
      const mcp = await pluginMcpDetail(fastify.prisma, row.id, latestRow).catch(() => ({
        mcpMappings: [],
        mcpServers: [],
        mcpUnreadable: [],
      }));
      const detail: HarnessProfileDetail = {
        ...summaryOf(rest, dtos.find((v) => v.version === row.latestVersion) ?? null),
        ...mcp,
        autoRunSources,
        boundAgents,
        enabledTeams,
        versions: dtos,
      };
      return { data: detail };
    }
  );

  // POST /harness-profiles/:name/preview-update — reads the profile's source again; writes nothing.
  app.post(
    '/harness-profiles/:name/preview-update',
    { onRequest: adminOnly, schema: { body: UpdatePreviewBody, params: NameParams } },
    async (request, reply) => {
      const existing = await fastify.prisma.harnessProfile.findUnique({
        select: PROFILE_SELECT,
        where: { name: request.params.name },
      });
      if (!existing) {
        return notFound(reply);
      }
      const { file, sha } = request.body;
      try {
        if (file !== undefined) {
          const reviewed = existing.marketplaceEntry
            ? reviewFile((await readExisting(existing, { atSha: sha as string })).files, file)
            : await readFileForReview(existing, { atSha: sha as string }, file, readDeps);
          return reviewed ? { data: reviewed } : notFound(reply);
        }
        const read = await readExisting(existing, sha === undefined ? {} : { atSha: sha });
        if (read.validated.manifest.name !== existing.name) {
          throw new HarnessProfileInvalid([
            'profile.json name does not match the profile being updated',
          ]);
        }
        // Against the upstream content hash: the hook switch is not part of the stored snapshot, so
        // flipping it never makes an unchanged plugin look changed.
        const same = await fastify.prisma.harnessProfileVersion.findFirst({
          select: { version: true },
          where: { contentHash: read.validated.contentHash, profileId: existing.id },
        });
        const hookChanges = await hookChangesFor(existing, read);
        return {
          data: {
            ...previewOf(read, { conflicts: [], matchesVersion: same?.version ?? null }),
            hookChanges,
            hooksEnabled: existing.hooksEnabled,
          },
        };
      } catch (err) {
        return readError(err, reply);
      }
    }
  );

  // POST /harness-profiles/:name/accept — a new immutable version from the previewed commit.
  app.post(
    '/harness-profiles/:name/accept',
    { onRequest: adminOnly, schema: { body: AcceptBody, params: NameParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.harnessProfile.findUnique({
        select: PROFILE_SELECT,
        where: { name: request.params.name },
      });
      if (!existing) {
        return notFound(reply);
      }
      if (existing.status === 'DISABLED') {
        return sendError(
          reply,
          409,
          'HARNESS_PROFILE_DISABLED',
          'This profile is disabled; re-enable it first'
        );
      }
      const {
        acknowledgeHookChanges,
        acknowledgeWarnings,
        contentHash,
        sha,
        warningsHash: warnedHash,
      } = request.body;
      try {
        const read = await readExisting(existing, { expectSha: sha });
        if (read.validated.manifest.name !== existing.name) {
          throw new HarnessProfileInvalid([
            'profile.json name does not match the profile being updated',
          ]);
        }
        if (!matchesPreview(read, { contentHash, warningsHash: warnedHash })) {
          return previewStale(reply, read);
        }
        const duplicate = await fastify.prisma.harnessProfileVersion.findFirst({
          select: { version: true },
          where: { contentHash: read.validated.contentHash, profileId: existing.id },
        });
        if (duplicate) {
          return sendError(
            reply,
            409,
            'HARNESS_PROFILE_NO_CHANGE',
            `This content is already version ${duplicate.version}`
          );
        }
        if (read.warnings.length > 0 && !acknowledgeWarnings) {
          return unacknowledged(reply, read.warnings);
        }
        // An update never turns hooks on. With hooks on, one that changes the hook files needs a
        // fresh acknowledgement against the diff.
        if (existing.hooksEnabled && !acknowledgeHookChanges) {
          const hookChanges = await hookChangesFor(existing, read);
          if (hasHookChanges(hookChanges)) {
            return sendError(
              reply,
              409,
              'HOOK_CHANGES_UNACKNOWLEDGED',
              'This update changes the plugin hook files and hooks are on; review the changes and send acknowledgeHookChanges: true',
              { hookChanges }
            );
          }
        }
        const next = existing.latestVersion + 1;
        const created = await fastify.prisma.$transaction(async (tx) => {
          // Compare-and-set on latestVersion: two admins accepting at once cannot both take `next`.
          const moved = await tx.harnessProfile.updateMany({
            data: {
              description: read.validated.manifest.description,
              latestVersion: next,
              // Accepting the commit the last check found settles the tracking status.
              ...(existing.latestSha === read.sha ? { lastError: null, trackStatus: 'OK' } : {}),
            },
            // `hooksEnabled` is the value the hook-change decision above used: a concurrent PATCH
            // switching hooks on makes this miss rather than accept unreviewed hook changes.
            where: {
              hooksEnabled: existing.hooksEnabled,
              id: existing.id,
              latestVersion: existing.latestVersion,
              status: 'OK',
            },
          });
          if (moved.count !== 1) {
            return null;
          }
          const version = await tx.harnessProfileVersion.create({
            data: {
              approvedById: actor.sub,
              commitSha: read.sha,
              contentHash: read.validated.contentHash,
              fileCount: read.files.length,
              fileIndex: read.validated.fileIndex,
              files: new Uint8Array(packFiles(read.files)),
              manifest: read.validated.manifest,
              profileId: existing.id,
              scanWarnings: read.warnings,
              totalBytes: read.validated.totalBytes,
              version: next,
            },
            select: VERSION_SELECT,
          });
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor,
            after: {
              acknowledgedWarnings: read.warnings.length,
              commitSha: read.sha,
              contentHash: read.validated.contentHash,
              fileCount: read.files.length,
              name: existing.name,
              version: next,
            },
            before: { latestVersion: existing.latestVersion, name: existing.name },
            client: tx,
            entityId: existing.id,
            entityType: 'HarnessProfile',
          });
          return version;
        });
        if (!created) {
          return sendError(
            reply,
            409,
            'HARNESS_PROFILE_CHANGED',
            'The profile changed while the update was being applied; nothing was changed. Review it again.'
          );
        }
        const projection = await projectProfileSkills(
          projectSkills,
          fastify.prisma,
          {
            commitSha: read.sha,
            createdById: actor.sub,
            files: read.files,
            manifest: read.validated.manifest,
            profileId: existing.id,
            profileName: existing.name,
            version: next,
          },
          request.log
        );
        return reply.status(201).send({ data: versionDto(created), projection });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'HARNESS_PROFILE_CHANGED',
            'The profile changed while the update was being applied; nothing was changed. Review it again.'
          );
        }
        return readError(err, reply);
      }
    }
  );

  // PATCH /harness-profiles/:name
  app.patch(
    '/harness-profiles/:name',
    { onRequest: adminOnly, schema: { body: PatchBody, params: NameParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.harnessProfile.findUnique({
        select: PROFILE_SELECT,
        where: { name: request.params.name },
      });
      if (!existing) {
        return notFound(reply);
      }
      const { expectedVersion, hooksEnabled, status } = request.body;
      if (hooksEnabled === true) {
        if (expectedVersion === undefined) {
          return sendError(
            reply,
            400,
            'HOOKS_EXPECTED_VERSION_REQUIRED',
            'Turning hooks on needs expectedVersion: the latest version you reviewed'
          );
        }
        if (expectedVersion !== existing.latestVersion) {
          return sendError(
            reply,
            409,
            'HOOKS_VERSION_STALE',
            'The plugin has a newer version than the one you reviewed; review it and try again',
            { latestVersion: existing.latestVersion }
          );
        }
      }
      let updated: ProfileRow;
      try {
        updated = await fastify.prisma.$transaction(async (tx) => {
          if (hooksEnabled === true) {
            // Compare-and-set: a version accepted since the check above makes this miss.
            const held = await tx.harnessProfile.updateMany({
              data: { hooksEnabled: true },
              where: { id: existing.id, latestVersion: expectedVersion ?? existing.latestVersion },
            });
            if (held.count !== 1) {
              throw new HooksVersionStale();
            }
          }
          // The hook switch lives on the profile row, not in a version: no new version is cut and
          // the stored snapshot (and so the upstream content hash) is untouched.
          const row = await tx.harnessProfile.update({
            data: {
              ...(status === undefined ? {} : { status }),
              ...(hooksEnabled === undefined ? {} : { hooksEnabled }),
            },
            select: PROFILE_SELECT,
            where: { id: existing.id },
          });
          // Projected skills follow the plugin: off while it is DISABLED, back on with it. Team
          // enablement rows are untouched, so re-enabling restores team access.
          const skillsToggled =
            status !== undefined && status !== existing.status
              ? await setProjectedSkillsActive(tx, row, status === 'OK')
              : null;
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor,
            after: {
              hooksEnabled: row.hooksEnabled,
              name: row.name,
              status: row.status,
              ...(hooksEnabled === true ? { expectedVersion } : {}),
              ...(skillsToggled === null
                ? {}
                : {
                    projectedSkills: {
                      [status === 'OK' ? 'activated' : 'deactivated']: skillsToggled,
                    },
                  }),
            },
            before: {
              hooksEnabled: existing.hooksEnabled,
              name: existing.name,
              status: existing.status,
            },
            client: tx,
            entityId: existing.id,
            entityType: 'HarnessProfile',
          });
          return row;
        });
      } catch (err) {
        if (err instanceof HooksVersionStale) {
          const fresh = await fastify.prisma.harnessProfile.findUnique({
            select: { latestVersion: true },
            where: { id: existing.id },
          });
          return sendError(
            reply,
            409,
            'HOOKS_VERSION_STALE',
            'The plugin has a newer version than the one you reviewed; review it and try again',
            { latestVersion: fresh?.latestVersion ?? existing.latestVersion }
          );
        }
        throw err;
      }
      const latest = await fastify.prisma.harnessProfileVersion.findUnique({
        select: VERSION_SELECT,
        where: { profileId_version: { profileId: updated.id, version: updated.latestVersion } },
      });
      return { data: summaryOf(updated, latest ? versionDto(latest) : null) };
    }
  );

  // POST /harness-profiles/:name/check — the sweep's cheap check, for one profile, now.
  app.post(
    '/harness-profiles/:name/check',
    { onRequest: adminOnly, schema: { params: NameParams } },
    async (request, reply) => {
      const existing = await fastify.prisma.harnessProfile.findUnique({
        select: PROFILE_SELECT,
        where: { name: request.params.name },
      });
      if (!existing) {
        return notFound(reply);
      }
      if (existing.status === 'DISABLED') {
        return sendError(
          reply,
          409,
          'HARNESS_PROFILE_DISABLED',
          'This profile is disabled; re-enable it first'
        );
      }
      const pinned = await fastify.prisma.harnessProfileVersion.findUnique({
        select: { commitSha: true },
        where: {
          profileId_version: { profileId: existing.id, version: existing.latestVersion },
        },
      });
      if (!pinned) {
        return notFound(reply);
      }
      const check = await checkHarnessProfile(
        fastify.prisma,
        {
          host: existing.host,
          id: existing.id,
          latestVersion: existing.latestVersion,
          owner: existing.owner,
          path: existing.path,
          pinnedSha: pinned.commitSha,
          ref: existing.ref,
          repo: existing.repo,
        },
        readDeps.source
      );
      const updated = await fastify.prisma.harnessProfile.findUnique({
        select: PROFILE_SELECT,
        where: { id: existing.id },
      });
      if (!updated) {
        return notFound(reply);
      }
      // `recorded` is false when the profile changed under the check (disabled, or a newer
      // version accepted) and its answer was dropped; `check.status` is what the host said.
      return {
        data: {
          check: { error: check.error, status: check.status },
          profile: summaryOf(updated, null),
          recorded: check.recorded,
        },
      };
    }
  );

  // GET /harness-profiles/:name/enablements — every team that enabled the profile.
  app.get(
    '/harness-profiles/:name/enablements',
    { onRequest: adminOnly, schema: { params: NameParams } },
    async (request, reply) => {
      const profile = await fastify.prisma.harnessProfile.findUnique({
        select: { id: true },
        where: { name: request.params.name },
      });
      if (!profile) {
        return notFound(reply);
      }
      const rows = await runUnscoped(
        'admin lists the teams that enabled a plugin',
        ['PluginEnablement'],
        () =>
          fastify.prisma.pluginEnablement.findMany({
            orderBy: { createdAt: 'asc' },
            select: {
              createdAt: true,
              enabledById: true,
              team: { select: { id: true, name: true, slug: true } },
            },
            where: { profileId: profile.id },
          })
      );
      return {
        data: rows.map((r) => ({
          enabledAt: r.createdAt.toISOString(),
          enabledById: r.enabledById,
          teamId: r.team.id,
          teamName: r.team.name,
          teamSlug: r.team.slug,
        })),
      };
    }
  );
};
