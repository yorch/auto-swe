import { warningsHash } from '@auto-swe/shared/lib/harnessProfile';
import {
  type CatalogEntryDto,
  checkMarketplaceSource,
  type MarketplaceCatalogDto,
  type MarketplaceDetailDto,
  MarketplaceInvalid,
  type MarketplaceSourceDto,
  type MarketplaceSourceStatus,
  type ParsedMarketplace,
  readMarketplace,
} from '@auto-swe/shared/lib/marketplace';
import {
  SKILL_SOURCE_ERRORS,
  type SkillSourceDeps,
  SkillSourceError,
} from '@auto-swe/shared/lib/skillSource';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { HarnessProfileInvalid, type ProfileReadDeps } from '../lib/harnessProfileService.js';
import { sendError } from '../lib/httpErrors.js';
import {
  type EntryProfileRead,
  entryPreviewOf,
  firstVersionData,
  readEntryProfile,
} from '../lib/marketplaceService.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { STATUS_BY_CODE } from './skillSources.js';

/**
 * Admin API for plugin marketplaces: a GitHub / GitHub Enterprise repository (or a folder of one)
 * holding a Claude Code `.claude-plugin/marketplace.json`. An administrator pins a marketplace to
 * a commit, reads its catalog, and approves an entry as a single-plugin harness profile bound to
 * that entry's commit. ADMIN-only and GLOBAL, like harness profiles (`docs/harness-profiles.md`).
 *
 *   POST   /api/v1/platform/marketplaces/preview                 Read the catalog; writes nothing
 *   POST   /api/v1/platform/marketplaces                         Add the source, pinned to the previewed commit
 *   GET    /api/v1/platform/marketplaces                         List sources
 *   GET    /api/v1/platform/marketplaces/:id                     One source with its catalog at the pinned commit
 *   PATCH  /api/v1/platform/marketplaces/:id                     Disable / re-enable
 *   DELETE /api/v1/platform/marketplaces/:id                     Remove the source; profiles keep working
 *   POST   /api/v1/platform/marketplaces/:id/check               Ask the host for the ref's commit now (what the sweep does)
 *   POST   /api/v1/platform/marketplaces/:id/accept-update       Move the pin; installs nothing and changes no profile
 *   POST   /api/v1/platform/marketplaces/:id/entries/preview     Read, validate and scan one entry as a profile; writes nothing
 *   POST   /api/v1/platform/marketplaces/:id/entries/approve     Create the single-plugin profile from the previewed entry
 *
 * MCP: the harness ignores a plugin's `.mcp.json`. Its HTTP servers are shown in the entry preview
 * as declared dependencies (an administrator points the agent's existing `mcpConnectionId` at a
 * matching `mcp` Connection); stdio servers are flagged unsupported. There is no mapping table.
 */

const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const IdParams = z.object({ id: z.string().uuid() });

const Location = z.object({
  host: z.string().min(1).max(253).default('github.com'),
  owner: z.string().min(1).max(100),
  path: z.string().max(1000).default(''),
  ref: z.string().min(1).max(255),
  repo: z.string().min(1).max(100),
});

const AddBody = Location.extend({
  /** The commit the preview showed; the ref must still resolve to it (else 409 MARKETPLACE_SHA_MOVED). */
  sha: Sha,
});
const PatchBody = z.object({ status: z.enum(['DISABLED', 'OK']) });
const AcceptUpdateBody = z.object({ sha: Sha });
const EntryPreviewBody = z.object({
  entry: z.string().min(1).max(64),
  /** A commit for a GitHub entry that names only a ref; a relative entry is always read at the pin. */
  sha: Sha.optional(),
});
const EntryApproveBody = z.object({
  acknowledgeWarnings: z.boolean().default(false),
  /** `contentHash` and `warningsHash` from the entry preview; the server re-reads and refuses 409 PREVIEW_STALE if either differs. */
  contentHash: Hash,
  entry: z.string().min(1).max(64),
  /** Whether the plugin's hooks run in the run container. Required: there is no default. */
  hooksEnabled: z.boolean(),
  sha: Sha,
  warningsHash: Hash,
});

const SOURCE_SELECT = {
  _count: { select: { profiles: true } },
  createdAt: true,
  createdById: true,
  host: true,
  id: true,
  lastCheckedAt: true,
  lastError: true,
  latestSha: true,
  owner: true,
  path: true,
  pinnedSha: true,
  ref: true,
  repo: true,
  status: true,
  updatedAt: true,
} as const;

interface SourceRow {
  _count: { profiles: number };
  createdAt: Date;
  createdById: string | null;
  host: string;
  id: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  latestSha: string | null;
  owner: string;
  path: string;
  pinnedSha: string;
  ref: string;
  repo: string;
  status: MarketplaceSourceStatus;
  updatedAt: Date;
}

const sourceDto = (row: SourceRow): MarketplaceSourceDto => ({
  createdAt: row.createdAt.toISOString(),
  createdById: row.createdById,
  host: row.host,
  id: row.id,
  lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
  lastError: row.lastError,
  latestSha: row.latestSha,
  owner: row.owner,
  path: row.path,
  pinnedSha: row.pinnedSha,
  profileCount: row._count.profiles,
  ref: row.ref,
  repo: row.repo,
  status: row.status,
  updatedAt: row.updatedAt.toISOString(),
});

const locationOf = (s: {
  host: string;
  owner: string;
  path: string;
  ref: string;
  repo: string;
}) => ({
  host: s.host,
  owner: s.owner,
  path: s.path,
  ref: s.ref,
  repo: s.repo,
});

export interface MarketplaceRouteOptions {
  /** Test seam: replaces the fetch machinery and the scanners. */
  readDeps?: ProfileReadDeps;
}

export const marketplaceRoutes: FastifyPluginAsync<MarketplaceRouteOptions> = async (
  fastify,
  options
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ capability: 'platform.integrations.manage' });
  const readDeps = options.readDeps ?? {};
  const sourceDeps: SkillSourceDeps | undefined = readDeps.source;

  /** A refused marketplace read as its fixed response; anything unexpected is rethrown. */
  const marketplaceError = (err: unknown, reply: FastifyReply) => {
    if (err instanceof MarketplaceInvalid) {
      return sendError(
        reply,
        422,
        'MARKETPLACE_INVALID',
        'The folder does not hold a valid marketplace',
        {
          errors: err.errors,
        }
      );
    }
    if (err instanceof SkillSourceError) {
      return sendError(
        reply,
        STATUS_BY_CODE[err.code],
        `MARKETPLACE_${err.code}`,
        SKILL_SOURCE_ERRORS[err.code]
      );
    }
    throw err;
  };

  /** A refused entry read: the profile flow's codes (`SHA_MOVED`, `HARNESS_PROFILE_*`). */
  const entryError = (err: unknown, reply: FastifyReply) => {
    if (err instanceof HarnessProfileInvalid) {
      return sendError(
        reply,
        422,
        'HARNESS_PROFILE_INVALID',
        'The plugin folder is not a valid harness profile',
        { errors: err.errors }
      );
    }
    if (err instanceof MarketplaceInvalid) {
      return sendError(
        reply,
        422,
        'MARKETPLACE_ENTRY_NOT_INSTALLABLE',
        'The entry cannot be installed',
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
    sendError(reply, 404, 'NOT_FOUND', 'Marketplace not found');
  const disabled = (reply: FastifyReply) =>
    sendError(
      reply,
      409,
      'MARKETPLACE_DISABLED',
      'This marketplace is disabled; re-enable it first'
    );
  const exists = (reply: FastifyReply) =>
    sendError(reply, 409, 'MARKETPLACE_EXISTS', 'This marketplace is already tracked');

  const getSource = (
    id: string,
    db: Pick<typeof fastify.prisma, 'marketplaceSource'> = fastify.prisma
  ) => db.marketplaceSource.findUnique({ select: SOURCE_SELECT, where: { id } });

  /** The catalog with, per entry, the profile already approved from it and whether its name is taken. */
  async function catalogDto(
    sourceId: string | null,
    parsed: ParsedMarketplace
  ): Promise<MarketplaceCatalogDto> {
    const names = parsed.entries.flatMap((e) => (e.name ? [e.name] : []));
    const profiles =
      names.length === 0
        ? []
        : await fastify.prisma.harnessProfile.findMany({
            select: {
              latestVersion: true,
              marketplaceEntry: true,
              marketplaceSourceId: true,
              name: true,
              status: true,
            },
            where: {
              OR: [
                { name: { in: names, mode: 'insensitive' } },
                ...(sourceId ? [{ marketplaceSourceId: sourceId }] : []),
              ],
            },
          });
    const entries: CatalogEntryDto[] = parsed.entries.map((e) => {
      const own = profiles.find(
        (p) =>
          sourceId !== null && p.marketplaceSourceId === sourceId && p.marketplaceEntry === e.name
      );
      const taken = profiles.some(
        (p) => !!e.name && p !== own && p.name.toLowerCase() === e.name.toLowerCase()
      );
      return {
        ...e,
        nameTaken: taken,
        profile: own
          ? { latestVersion: own.latestVersion, name: own.name, status: own.status }
          : null,
      };
    });
    return {
      entries,
      ignoredKeys: parsed.ignoredKeys,
      name: parsed.name,
      ownerName: parsed.ownerName,
    };
  }

  // POST /marketplaces/preview — reads the catalog; writes nothing.
  app.post(
    '/marketplaces/preview',
    { onRequest: adminOnly, schema: { body: AddBody.partial({ sha: true }) } },
    async (request, reply) => {
      const { sha, ...location } = request.body;
      try {
        const read = await readMarketplace(location, sha ? { atSha: sha } : {}, sourceDeps);
        const { host, owner, path, repo } = read.location;
        const existing = await fastify.prisma.marketplaceSource.findFirst({
          select: { id: true },
          where: { host, owner, path, repo },
        });
        return {
          data: {
            catalog: await catalogDto(null, read.marketplace),
            existingId: existing?.id ?? null,
            sha: read.sha,
            source: locationOf(read.location),
          },
        };
      } catch (err) {
        return marketplaceError(err, reply);
      }
    }
  );

  // POST /marketplaces — add the source, pinned to the previewed commit.
  app.post(
    '/marketplaces',
    { onRequest: adminOnly, schema: { body: AddBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { sha, ...location } = request.body;
      try {
        const read = await readMarketplace(location, { expectSha: sha }, sourceDeps);
        const { host, owner, path, ref, repo } = read.location;
        if (
          await fastify.prisma.marketplaceSource.findFirst({
            select: { id: true },
            where: { host, owner, path, repo },
          })
        ) {
          return exists(reply);
        }
        const created = await fastify.prisma.$transaction(async (tx) => {
          const row = await tx.marketplaceSource.create({
            data: { createdById: actor.sub, host, owner, path, pinnedSha: read.sha, ref, repo },
            select: SOURCE_SELECT,
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor,
            after: { host, owner, path, pinnedSha: read.sha, ref, repo },
            client: tx,
            entityId: row.id,
            entityType: 'MarketplaceSource',
          });
          return row;
        });
        return reply.status(201).send({ data: sourceDto(created) });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return exists(reply);
        }
        return marketplaceError(err, reply);
      }
    }
  );

  // GET /marketplaces
  app.get('/marketplaces', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.marketplaceSource.findMany({
      orderBy: [{ owner: 'asc' }, { repo: 'asc' }, { path: 'asc' }],
      select: SOURCE_SELECT,
    });
    return { data: rows.map(sourceDto) };
  });

  // GET /marketplaces/:id — the source and its catalog at the pinned commit.
  app.get(
    '/marketplaces/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const row = await getSource(request.params.id);
      if (!row) {
        return notFound(reply);
      }
      let catalog: MarketplaceCatalogDto | null = null;
      let catalogError: string | null = null;
      try {
        const read = await readMarketplace(locationOf(row), { atSha: row.pinnedSha }, sourceDeps);
        catalog = await catalogDto(row.id, read.marketplace);
      } catch (err) {
        if (err instanceof MarketplaceInvalid) {
          catalogError = err.errors.join('; ');
        } else if (err instanceof SkillSourceError) {
          catalogError = SKILL_SOURCE_ERRORS[err.code];
        } else {
          throw err;
        }
      }
      const detail: MarketplaceDetailDto = { ...sourceDto(row), catalog, catalogError };
      return { data: detail };
    }
  );

  // PATCH /marketplaces/:id
  app.patch(
    '/marketplaces/:id',
    { onRequest: adminOnly, schema: { body: PatchBody, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await getSource(request.params.id);
      if (!existing) {
        return notFound(reply);
      }
      const status: MarketplaceSourceStatus =
        request.body.status === 'DISABLED'
          ? 'DISABLED'
          : existing.latestSha && existing.latestSha !== existing.pinnedSha
            ? 'UPDATE_AVAILABLE'
            : 'OK';
      const updated = await fastify.prisma.$transaction(async (tx) => {
        const row = await tx.marketplaceSource.update({
          data: { status },
          select: SOURCE_SELECT,
          where: { id: existing.id },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor,
          after: { status: row.status },
          before: { status: existing.status },
          client: tx,
          entityId: existing.id,
          entityType: 'MarketplaceSource',
        });
        return row;
      });
      return { data: sourceDto(updated) };
    }
  );

  // DELETE /marketplaces/:id — profiles keep working; the foreign key detaches them.
  app.delete(
    '/marketplaces/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await getSource(request.params.id);
      if (!existing) {
        return notFound(reply);
      }
      await fastify.prisma.$transaction(async (tx) => {
        await tx.marketplaceSource.delete({ where: { id: existing.id } });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor,
          before: {
            detachedProfiles: existing._count.profiles,
            host: existing.host,
            owner: existing.owner,
            path: existing.path,
            pinnedSha: existing.pinnedSha,
            ref: existing.ref,
            repo: existing.repo,
          },
          client: tx,
          entityId: existing.id,
          entityType: 'MarketplaceSource',
        });
      });
      return reply.status(204).send();
    }
  );

  // POST /marketplaces/:id/check — the sweep's cheap check, for one source, now.
  app.post(
    '/marketplaces/:id/check',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const existing = await getSource(request.params.id);
      if (!existing) {
        return notFound(reply);
      }
      if (existing.status === 'DISABLED') {
        return disabled(reply);
      }
      const check = await checkMarketplaceSource(fastify.prisma, existing, sourceDeps);
      const updated = await getSource(existing.id);
      // `recorded` is false when the source changed under the check (disabled, or a newer pin
      // accepted) and its answer was dropped; `check.status` is what the host said.
      return updated
        ? {
            data: {
              check: { error: check.error, status: check.status },
              recorded: check.recorded,
              source: sourceDto(updated),
            },
          }
        : notFound(reply);
    }
  );

  // POST /marketplaces/:id/accept-update — moves the pin. Installs nothing, changes no profile.
  app.post(
    '/marketplaces/:id/accept-update',
    { onRequest: adminOnly, schema: { body: AcceptUpdateBody, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await getSource(request.params.id);
      if (!existing) {
        return notFound(reply);
      }
      if (existing.status === 'DISABLED') {
        return disabled(reply);
      }
      const { sha } = request.body;
      if (sha === existing.pinnedSha) {
        return sendError(
          reply,
          409,
          'MARKETPLACE_NO_CHANGE',
          'The marketplace is already pinned to this commit'
        );
      }
      try {
        // The ref must still name this commit, and its catalog must read: a broken file cannot be pinned.
        await readMarketplace(locationOf(existing), { expectSha: sha }, sourceDeps);
        const updated = await fastify.prisma.$transaction(async (tx) => {
          const moved = await tx.marketplaceSource.updateMany({
            data: { lastError: null, latestSha: sha, pinnedSha: sha, status: 'OK' },
            where: { id: existing.id, pinnedSha: existing.pinnedSha, status: { not: 'DISABLED' } },
          });
          if (moved.count !== 1) {
            return null;
          }
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor,
            after: { pinnedSha: sha },
            before: { pinnedSha: existing.pinnedSha },
            client: tx,
            entityId: existing.id,
            entityType: 'MarketplaceSource',
          });
          // Through `tx`: another connection cannot see the uncommitted pin.
          return getSource(existing.id, tx);
        });
        if (!updated) {
          return sendError(
            reply,
            409,
            'MARKETPLACE_CHANGED',
            'The marketplace changed while the update was being applied; nothing was changed'
          );
        }
        return { data: sourceDto(updated) };
      } catch (err) {
        return marketplaceError(err, reply);
      }
    }
  );

  /** Resolve the named entry of the source's catalog at the pinned commit. */
  async function loadEntry(
    row: SourceRow,
    name: string,
    reply: FastifyReply
  ): Promise<
    | { entry: ParsedMarketplace['entries'][number]; location: ReturnType<typeof locationOf> }
    | FastifyReply
  > {
    const read = await readMarketplace(locationOf(row), { atSha: row.pinnedSha }, sourceDeps);
    const entry = read.marketplace.entries.find((e) => e.name === name);
    if (!entry) {
      return sendError(
        reply,
        404,
        'MARKETPLACE_ENTRY_NOT_FOUND',
        'The marketplace has no such entry'
      );
    }
    if (!entry.installable) {
      return sendError(
        reply,
        422,
        'MARKETPLACE_ENTRY_NOT_INSTALLABLE',
        entry.reason ?? 'The entry cannot be installed'
      );
    }
    return { entry, location: read.location };
  }

  const conflictsFor = async (name: string) =>
    fastify.prisma.harnessProfile.findMany({
      select: { name: true, status: true },
      where: { name: { equals: name, mode: 'insensitive' } },
    });

  // POST /marketplaces/:id/entries/preview — the profile preview of one entry; writes nothing.
  app.post(
    '/marketplaces/:id/entries/preview',
    { onRequest: adminOnly, schema: { body: EntryPreviewBody, params: IdParams } },
    async (request, reply) => {
      const row = await getSource(request.params.id);
      if (!row) {
        return notFound(reply);
      }
      if (row.status === 'DISABLED') {
        return disabled(reply);
      }
      try {
        const found = await loadEntry(row, request.body.entry, reply);
        if ('statusCode' in found) {
          return found;
        }
        const read = await readEntryProfile(
          {
            bind: false,
            entry: found.entry,
            marketplace: found.location,
            marketplaceSha: row.pinnedSha,
            ...(request.body.sha ? { sha: request.body.sha } : {}),
          },
          readDeps
        );
        return {
          data: {
            ...entryPreviewOf(read, await conflictsFor(request.body.entry)),
            entry: {
              description: found.entry.description,
              name: found.entry.name,
              source: found.entry.source,
              version: found.entry.version,
            },
          },
        };
      } catch (err) {
        return catalogOrEntryError(err, reply);
      }
    }
  );

  // A catalog read that fails is a marketplace problem; an entry read that fails is a profile problem.
  const catalogOrEntryError = (err: unknown, reply: FastifyReply) =>
    err instanceof MarketplaceInvalid ? marketplaceError(err, reply) : entryError(err, reply);

  // POST /marketplaces/:id/entries/approve — the single-plugin profile, bound to the previewed commit.
  app.post(
    '/marketplaces/:id/entries/approve',
    { onRequest: adminOnly, schema: { body: EntryApproveBody, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const row = await getSource(request.params.id);
      if (!row) {
        return notFound(reply);
      }
      if (row.status === 'DISABLED') {
        return disabled(reply);
      }
      const body = request.body;
      let read: EntryProfileRead;
      try {
        const found = await loadEntry(row, body.entry, reply);
        if ('statusCode' in found) {
          return found;
        }
        read = await readEntryProfile(
          {
            bind: true,
            entry: found.entry,
            marketplace: found.location,
            marketplaceSha: row.pinnedSha,
            sha: body.sha,
          },
          readDeps
        );
      } catch (err) {
        return catalogOrEntryError(err, reply);
      }
      if (
        read.validated.contentHash !== body.contentHash ||
        warningsHash(read.warnings) !== body.warningsHash
      ) {
        return sendError(
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
      }
      if (read.warnings.length > 0 && !body.acknowledgeWarnings) {
        return sendError(
          reply,
          409,
          'WARNINGS_UNACKNOWLEDGED',
          'The plugin has warnings; review them and send acknowledgeWarnings: true',
          { warnings: read.warnings }
        );
      }
      const { manifest } = read.validated;
      const nameTaken = () =>
        sendError(
          reply,
          409,
          'HARNESS_PROFILE_NAME_EXISTS',
          'A harness profile with this name already exists'
        );
      if ((await conflictsFor(manifest.name)).length > 0) {
        return nameTaken();
      }
      try {
        const { host, owner, path, ref, repo } = read.location;
        const created = await fastify.prisma.$transaction(async (tx) => {
          const profile = await tx.harnessProfile.create({
            data: {
              description: manifest.description,
              hooksEnabled: body.hooksEnabled,
              host,
              latestVersion: 1,
              marketplaceEntry: body.entry,
              marketplaceSourceId: row.id,
              name: manifest.name,
              owner,
              path,
              ref,
              repo,
              versions: { create: firstVersionData(read, actor.sub) },
            },
            select: { id: true, name: true, status: true },
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor,
            after: {
              acknowledgedWarnings: read.warnings.length,
              commitSha: read.sha,
              contentHash: read.validated.contentHash,
              fileCount: read.files.length,
              hooksEnabled: body.hooksEnabled,
              host,
              marketplaceEntry: body.entry,
              marketplaceSourceId: row.id,
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
        return reply.status(201).send({
          data: {
            commitSha: read.sha,
            contentHash: read.validated.contentHash,
            hooksEnabled: body.hooksEnabled,
            id: created.id,
            name: created.name,
            status: created.status,
            version: 1,
          },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return nameTaken();
        }
        throw err;
      }
    }
  );
};
