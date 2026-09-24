import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { fetchBundleJson } from '../lib/bundleFetch.js';
import {
  BundleDependencyError,
  BundleIntegrityError,
  BundleProtectedContentError,
  exportBundle,
  type InstallResult,
  installBundle,
  listInstalledBundles,
} from '../lib/bundleService.js';
import { resolveBundleAllowUnverified, resolveBundleTrustedKeys } from '../lib/bundleTrust.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin bundle distribution API (P4). Export a tagged set of GLOBAL library
 * content to a portable bundle; install a bundle (inline, or fetched from a URL)
 * as a managed base layer with signature-based trust; list installed bundles.
 * GLOBAL scope → platform ADMIN only.
 */
const ExportBody = z.object({
  name: z.string().min(1).max(200),
  /** Optional provenance/origin selector (e.g. 'swe-starter'); omit to export all GLOBAL content. */
  origin: z.string().max(200).optional(),
  version: z.string().min(1).max(50),
});

/**
 * `overwriteProtected` lets a bundle replace a seeded built-in or admin-authored
 * GLOBAL agent, skill or scanner pattern with the same key, name or label. Off
 * by default; without it such an install is refused with 409.
 */
const InstallBody = z.object({ bundle: z.unknown(), overwriteProtected: z.boolean().optional() });
const InstallFromUrlBody = z.object({
  overwriteProtected: z.boolean().optional(),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'url must be an http(s) URL'),
});

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The installed-bundle registry row for `name`, if an earlier install wrote one. */
async function registryIdFor(fastify: FastifyInstance, name: string): Promise<string | null> {
  const row = await fastify.prisma.installedBundle.findUnique({
    select: { id: true },
    where: { name },
  });
  return row?.id ?? null;
}

/** Run an install, audit it, and map bundle errors to 400. Shared by both install routes. */
async function runInstall(
  fastify: FastifyInstance,
  actor: JwtPayload,
  raw: unknown,
  reply: FastifyReply,
  source: string,
  overwriteProtected: boolean
): Promise<FastifyReply> {
  try {
    const result: InstallResult = await installBundle(fastify.prisma, raw, {
      allowUnverified: resolveBundleAllowUnverified(),
      installedById: actor.sub,
      overwriteProtected,
      trustedKeys: resolveBundleTrustedKeys(),
    });
    await writeAuditLog(fastify, {
      action: 'CREATE',
      actor,
      after: {
        counts: result.counts,
        overwriteProtected,
        // What a forced install actually replaced, by key — the flag alone says
        // only that it was allowed to.
        replacedProtected: result.replacedProtected,
        source,
        trustState: result.trustState,
      },
      // The registry row, not a label: `entity_id` is a uuid column, so the
      // literal 'bundle' this used to write failed every successful install's
      // audit insert — after the install itself had committed.
      entityId: result.installedBundleId,
      entityType: 'Bundle',
    });
    return reply.send({ data: result });
  } catch (err) {
    if (err instanceof BundleProtectedContentError) {
      // Audited: an attempt to replace a built-in control (a blocking scanner
      // rule, a platform agent) is worth a record even when it is refused.
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: {
          bundleName: err.bundleName,
          conflicts: err.conflicts,
          outcome: 'refused',
          reason: 'protected-overwrite',
          source,
        },
        // A refused bundle may have no registry row; the nil UUID marks "no
        // installed bundle" and the name travels in the payload.
        entityId: (await registryIdFor(fastify, err.bundleName)) ?? NIL_UUID,
        entityType: 'Bundle',
      });
      return reply.status(409).send({
        error: {
          code: 'PROTECTED_CONTENT_OVERWRITE',
          conflicts: err.conflicts,
          message: err.message,
        },
      });
    }
    if (err instanceof BundleIntegrityError || err instanceof BundleDependencyError) {
      return reply.status(400).send({ error: { code: 'INVALID_BUNDLE', message: err.message } });
    }
    if (err instanceof z.ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'INVALID_BUNDLE', message: 'bundle failed schema validation' } });
    }
    throw err;
  }
}

export const bundleRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  app.get('/bundles', { onRequest: adminOnly }, async () => ({
    data: await listInstalledBundles(fastify.prisma),
  }));

  app.post(
    '/bundles/export',
    { onRequest: adminOnly, schema: { body: ExportBody } },
    async (request) => {
      const manifest = await exportBundle(fastify.prisma, request.body);
      return { data: manifest };
    }
  );

  app.post(
    '/bundles/install',
    { onRequest: adminOnly, schema: { body: InstallBody } },
    async (request, reply) =>
      runInstall(
        fastify,
        requireUser(request),
        request.body.bundle,
        reply,
        'inline',
        request.body.overwriteProtected ?? false
      )
  );

  app.post(
    '/bundles/install-from-url',
    { onRequest: adminOnly, schema: { body: InstallFromUrlBody } },
    async (request, reply) => {
      const { url } = request.body;
      let raw: unknown;
      try {
        raw = await fetchBundleJson(url);
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: 'BUNDLE_FETCH_FAILED',
            message: `failed to fetch bundle from ${url}: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
      return runInstall(
        fastify,
        requireUser(request),
        raw,
        reply,
        url,
        request.body.overwriteProtected ?? false
      );
    }
  );
};
