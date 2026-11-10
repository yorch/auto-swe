import { packFiles, warningsHash } from '@auto-swe/shared/lib/harnessProfile';
import { SKILL_SOURCE_ERRORS, SkillSourceError } from '@auto-swe/shared/lib/skillSource';
import type {
  HarnessProfileDetail,
  HarnessProfileStatus,
  HarnessProfileSummary,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  HarnessProfileInvalid,
  type ProfileReadDeps,
  previewOf,
  type ReadProfile,
  readAndCheckProfile,
  readFileForReview,
  VERSION_SELECT,
  versionDto,
} from '../lib/harnessProfileService.js';
import { sendError } from '../lib/httpErrors.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
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
 *   PATCH /api/v1/platform/harness-profiles/:name                Disable / re-enable
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
  acknowledgeWarnings: z.boolean().default(false),
  contentHash: Hash,
  /** The commit the update preview showed; the profile's ref must still resolve to it. */
  sha: Sha,
  warningsHash: Hash,
});

const PatchBody = z.object({ status: z.enum(['DISABLED', 'OK']) });

const PROFILE_SELECT = {
  createdAt: true,
  description: true,
  host: true,
  id: true,
  latestVersion: true,
  name: true,
  owner: true,
  path: true,
  ref: true,
  repo: true,
  status: true,
  updatedAt: true,
} as const;

interface ProfileRow {
  createdAt: Date;
  description: string;
  host: string;
  id: string;
  latestVersion: number;
  name: string;
  owner: string;
  path: string;
  ref: string;
  repo: string;
  status: HarnessProfileStatus;
  updatedAt: Date;
}

const summaryOf = (
  row: ProfileRow,
  latest: ReturnType<typeof versionDto> | null
): HarnessProfileSummary => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
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
}

export const harnessProfileRoutes: FastifyPluginAsync<HarnessProfileRouteOptions> = async (
  fastify,
  options
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });
  const readDeps = options.readDeps ?? {};

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
              host,
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
        return reply.status(201).send({ data: detail });
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
      const detail: HarnessProfileDetail = {
        ...summaryOf(rest, dtos.find((v) => v.version === row.latestVersion) ?? null),
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
          const reviewed = await readFileForReview(
            existing,
            { atSha: sha as string },
            file,
            readDeps
          );
          return reviewed ? { data: reviewed } : notFound(reply);
        }
        const read = await readAndCheckProfile(
          existing,
          sha === undefined ? {} : { atSha: sha },
          readDeps
        );
        if (read.validated.manifest.name !== existing.name) {
          throw new HarnessProfileInvalid([
            'profile.json name does not match the profile being updated',
          ]);
        }
        const same = await fastify.prisma.harnessProfileVersion.findFirst({
          select: { version: true },
          where: { contentHash: read.validated.contentHash, profileId: existing.id },
        });
        return {
          data: previewOf(read, { conflicts: [], matchesVersion: same?.version ?? null }),
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
      const { acknowledgeWarnings, contentHash, sha, warningsHash: warnedHash } = request.body;
      try {
        const read = await readAndCheckProfile(existing, { expectSha: sha }, readDeps);
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
        const next = existing.latestVersion + 1;
        const created = await fastify.prisma.$transaction(async (tx) => {
          // Compare-and-set on latestVersion: two admins accepting at once cannot both take `next`.
          const moved = await tx.harnessProfile.updateMany({
            data: { description: read.validated.manifest.description, latestVersion: next },
            where: { id: existing.id, latestVersion: existing.latestVersion, status: 'OK' },
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
        return reply.status(201).send({ data: versionDto(created) });
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
      const updated = await fastify.prisma.$transaction(async (tx) => {
        const row = await tx.harnessProfile.update({
          data: { status: request.body.status },
          select: PROFILE_SELECT,
          where: { id: existing.id },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor,
          after: { name: row.name, status: row.status },
          before: { name: existing.name, status: existing.status },
          client: tx,
          entityId: existing.id,
          entityType: 'HarnessProfile',
        });
        return row;
      });
      const latest = await fastify.prisma.harnessProfileVersion.findUnique({
        select: VERSION_SELECT,
        where: { profileId_version: { profileId: updated.id, version: updated.latestVersion } },
      });
      return { data: summaryOf(updated, latest ? versionDto(latest) : null) };
    }
  );
};
