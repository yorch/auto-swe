/**
 * A team's event endpoints (docs/inbound-events.md): `/api/v1/teams/:teamId/event-endpoints`.
 * Members of the team read them (never a secret); ADMIN and the team's LEADs create, change,
 * rotate and remove them, as for the team's automations. A secret is returned once, when it is
 * generated, and every change is audited without it.
 */
import type { Prisma } from '@auto-swe/shared';
import {
  CLOUDEVENTS_POINTERS,
  EVENT_ENDPOINT_FORMATS,
  EVENT_ENDPOINT_SCHEMES,
  INBOUND_EVENT,
  JsonPointerSchema,
  SIGNATURE_ENCODINGS,
  SignatureHeaderSchema,
} from '@auto-swe/shared/automation';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { TEAM_MANAGE_FORBIDDEN, teamAutomationAccess } from '../lib/automations/access.js';
import { newSecretColumns, rotatedSecretColumns } from '../lib/eventEndpoints.js';
import { sendError } from '../lib/httpErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const TeamParams = z.object({ teamId: z.string().uuid() });
const EndpointParams = z.object({ id: z.string().uuid(), teamId: z.string().uuid() });

/** A secret the sender chose (a vendor that generates its own). */
const GivenSecret = z
  .string()
  .min(16)
  .max(512)
  .refine((s) => s.trim() === s, 'no surrounding whitespace');
const Prefix = z
  .string()
  .min(1)
  .max(32)
  .refine((s) => !/[\r\n]/.test(s), 'one line');

const ConfigFields = {
  format: z.enum(EVENT_ENDPOINT_FORMATS),
  idPointer: JsonPointerSchema.nullable(),
  name: z.string().trim().min(1).max(100),
  scheme: z.enum(EVENT_ENDPOINT_SCHEMES),
  scopePointer: JsonPointerSchema.nullable(),
  signatureEncoding: z.enum(SIGNATURE_ENCODINGS).nullable(),
  signatureHeader: SignatureHeaderSchema.nullable(),
  signaturePrefix: Prefix.nullable(),
  subjectPointer: JsonPointerSchema.nullable(),
  timePointer: JsonPointerSchema.nullable(),
  typePointer: JsonPointerSchema,
};

const CreateBody = z.object({
  ...ConfigFields,
  enabled: z.boolean().default(true),
  idPointer: ConfigFields.idPointer.optional(),
  scopePointer: ConfigFields.scopePointer.optional(),
  /** Omit to have one generated (returned once). */
  secret: GivenSecret.optional(),
  signatureEncoding: ConfigFields.signatureEncoding.optional(),
  signatureHeader: ConfigFields.signatureHeader.optional(),
  signaturePrefix: ConfigFields.signaturePrefix.optional(),
  subjectPointer: ConfigFields.subjectPointer.optional(),
  timePointer: ConfigFields.timePointer.optional(),
  typePointer: ConfigFields.typePointer.optional(),
});
const UpdateBody = z.object({ ...ConfigFields, enabled: z.boolean() }).partial();
const RotateBody = z.object({ secret: GivenSecret.optional() }).default({});

type SchemeConfig = {
  scheme: string;
  signatureHeader: string | null;
  signaturePrefix: string | null;
  signatureEncoding: string | null;
};

/**
 * The scheme's settings as stored: `autoswe-v1` uses its own header and none of these, a
 * shared secret has a header and no encoding, an HMAC has both. Null with the problem otherwise.
 */
function normaliseScheme(
  c: SchemeConfig
): { ok: true; value: SchemeConfig } | { ok: false; message: string } {
  if (c.scheme === 'autoswe-v1') {
    return {
      ok: true,
      value: {
        scheme: c.scheme,
        signatureEncoding: null,
        signatureHeader: null,
        signaturePrefix: null,
      },
    };
  }
  if (!c.signatureHeader) {
    return { message: `${c.scheme} needs the header the sender puts its value in`, ok: false };
  }
  if (c.scheme === 'hmac-sha256') {
    return {
      ok: true,
      value: { ...c, signatureEncoding: c.signatureEncoding ?? 'hex' },
    };
  }
  return { ok: true, value: { ...c, signatureEncoding: null } };
}

/** What anyone who may read an endpoint sees: never a secret, only its last four characters. */
const publicSelect = {
  createdAt: true,
  enabled: true,
  format: true,
  id: true,
  idPointer: true,
  name: true,
  previousSecretExpiresAt: true,
  previousSecretLastFour: true,
  scheme: true,
  scopePointer: true,
  secretLastFour: true,
  signatureEncoding: true,
  signatureHeader: true,
  signaturePrefix: true,
  subjectPointer: true,
  teamId: true,
  timePointer: true,
  typePointer: true,
  updatedAt: true,
} satisfies Prisma.EventEndpointSelect;

type PublicEndpoint = Prisma.EventEndpointGetPayload<{ select: typeof publicSelect }>;

/** The endpoint as the API returns it: its receiver path, and a lapsed previous secret hidden. */
function view(row: PublicEndpoint, now = new Date()) {
  const previousLive = row.previousSecretExpiresAt !== null && row.previousSecretExpiresAt > now;
  return {
    ...row,
    path: `/api/v1/webhooks/events/${row.id}`,
    previousSecretExpiresAt: previousLive ? row.previousSecretExpiresAt : null,
    previousSecretLastFour: previousLive ? row.previousSecretLastFour : null,
  };
}

export const eventEndpointRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const signedIn = requireAuth({ requiredRole: 'ENGINEER' });

  /** The caller's access to the team, or a 404 already sent. */
  async function loadTeam(request: FastifyRequest, reply: FastifyReply, teamId: string) {
    const access = await teamAutomationAccess(fastify.prisma, teamId, requireUser(request));
    if (!access) {
      await sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
    }
    return access;
  }

  /** The team's endpoint, for a manager, or a reply already sent. */
  async function loadForManager(
    request: FastifyRequest,
    reply: FastifyReply,
    params: { teamId: string; id: string }
  ) {
    const access = await loadTeam(request, reply, params.teamId);
    if (!access) {
      return null;
    }
    if (!access.canManage) {
      await sendError(reply, 403, 'FORBIDDEN', TEAM_MANAGE_FORBIDDEN);
      return null;
    }
    const row = await fastify.prisma.eventEndpoint.findFirst({
      where: { id: params.id, teamId: params.teamId },
    });
    if (!row) {
      await sendError(reply, 404, 'EVENT_ENDPOINT_NOT_FOUND', 'Event endpoint not found');
      return null;
    }
    return { access, row };
  }

  // GET /:teamId/event-endpoints — the team's endpoints, to its members.
  app.get(
    '/:teamId/event-endpoints',
    { onRequest: signedIn, schema: { params: TeamParams } },
    async (request, reply) => {
      const access = await loadTeam(request, reply, request.params.teamId);
      if (!access) {
        return;
      }
      const rows = await fastify.prisma.eventEndpoint.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: publicSelect,
        where: { teamId: access.team.id },
      });
      const now = new Date();
      return { data: { canManage: access.canManage, endpoints: rows.map((r) => view(r, now)) } };
    }
  );

  // POST /:teamId/event-endpoints — a new endpoint, with its secret shown once.
  app.post(
    '/:teamId/event-endpoints',
    { onRequest: signedIn, schema: { body: CreateBody, params: TeamParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const access = await loadTeam(request, reply, request.params.teamId);
      if (!access) {
        return;
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', TEAM_MANAGE_FORBIDDEN);
      }
      if (!access.team.isActive) {
        return sendError(reply, 409, 'TEAM_INACTIVE', 'The team is not active');
      }
      const body = request.body;
      const scheme = normaliseScheme({
        scheme: body.scheme,
        signatureEncoding: body.signatureEncoding ?? null,
        signatureHeader: body.signatureHeader ?? null,
        signaturePrefix: body.signaturePrefix ?? null,
      });
      if (!scheme.ok) {
        return sendError(reply, 400, 'INVALID_SCHEME', scheme.message);
      }
      // A CloudEvents endpoint reads its attributes unless told otherwise.
      const defaults =
        body.format === 'cloudevents'
          ? CLOUDEVENTS_POINTERS
          : {
              idPointer: null,
              scopePointer: null,
              subjectPointer: null,
              timePointer: null,
              typePointer: '/type',
            };
      const secret = newSecretColumns(body.secret);
      const created = await fastify.prisma.eventEndpoint.create({
        data: {
          ...scheme.value,
          ...secret.data,
          createdById: user.sub,
          enabled: body.enabled,
          format: body.format,
          idPointer: body.idPointer === undefined ? defaults.idPointer : body.idPointer,
          name: body.name,
          scopePointer: body.scopePointer === undefined ? defaults.scopePointer : body.scopePointer,
          subjectPointer:
            body.subjectPointer === undefined ? defaults.subjectPointer : body.subjectPointer,
          teamId: access.team.id,
          timePointer: body.timePointer === undefined ? defaults.timePointer : body.timePointer,
          typePointer: body.typePointer ?? defaults.typePointer,
        },
        select: publicSelect,
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor: user,
        after: { ...view(created), secretGenerated: secret.generated },
        entityId: created.id,
        entityType: 'EventEndpoint',
      });
      return reply.status(201).send({
        // Shown once, and only when the platform generated it: a sender's own secret is theirs.
        data: { ...view(created), ...(secret.generated ? { secret: secret.secret } : {}) },
      });
    }
  );

  // PATCH /:teamId/event-endpoints/:id — name, switch, scheme settings and pointers.
  app.patch(
    '/:teamId/event-endpoints/:id',
    { onRequest: signedIn, schema: { body: UpdateBody, params: EndpointParams } },
    async (request, reply) => {
      const loaded = await loadForManager(request, reply, request.params);
      if (!loaded) {
        return;
      }
      const { row } = loaded;
      const body = request.body;
      if (body.enabled === true && !loaded.access.team.isActive) {
        return sendError(reply, 409, 'TEAM_INACTIVE', 'The team is not active');
      }
      const schemeTouched =
        body.scheme !== undefined ||
        body.signatureHeader !== undefined ||
        body.signaturePrefix !== undefined ||
        body.signatureEncoding !== undefined;
      const scheme = schemeTouched
        ? normaliseScheme({
            scheme: body.scheme ?? row.scheme,
            signatureEncoding:
              body.signatureEncoding === undefined ? row.signatureEncoding : body.signatureEncoding,
            signatureHeader:
              body.signatureHeader === undefined ? row.signatureHeader : body.signatureHeader,
            signaturePrefix:
              body.signaturePrefix === undefined ? row.signaturePrefix : body.signaturePrefix,
          })
        : null;
      if (scheme && !scheme.ok) {
        return sendError(reply, 400, 'INVALID_SCHEME', scheme.message);
      }
      const {
        scheme: _s,
        signatureEncoding: _e,
        signatureHeader: _h,
        signaturePrefix: _p,
        ...rest
      } = body;
      const before = view({ ...row });
      const updated = await fastify.prisma.eventEndpoint.update({
        data: { ...rest, ...(scheme?.ok ? scheme.value : {}) },
        select: publicSelect,
        where: { id: row.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: requireUser(request),
        after: view(updated),
        before: pickPublic(before),
        entityId: row.id,
        entityType: 'EventEndpoint',
      });
      return { data: view(updated) };
    }
  );

  // POST /:teamId/event-endpoints/:id/secret/rotate — a new secret; the one it replaces is still
  // accepted for 24 hours. The new one is returned once when generated.
  app.post(
    '/:teamId/event-endpoints/:id/secret/rotate',
    { onRequest: signedIn, schema: { body: RotateBody, params: EndpointParams } },
    async (request, reply) => {
      const loaded = await loadForManager(request, reply, request.params);
      if (!loaded) {
        return;
      }
      const { row } = loaded;
      const now = new Date();
      const rotated = rotatedSecretColumns(row, now, request.body?.secret);
      const updated = await fastify.prisma.eventEndpoint.update({
        data: rotated.data,
        select: publicSelect,
        where: { id: row.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: requireUser(request),
        after: {
          previousSecretExpiresAt: rotated.previousExpiresAt,
          secretGenerated: rotated.generated,
          secretLastFour: updated.secretLastFour,
        },
        before: { secretLastFour: row.secretLastFour },
        entityId: row.id,
        entityType: 'EventEndpoint',
      });
      return {
        data: { ...view(updated, now), ...(rotated.generated ? { secret: rotated.secret } : {}) },
      };
    }
  );

  // DELETE /:teamId/event-endpoints/:id — refused while an automation listens to it.
  app.delete(
    '/:teamId/event-endpoints/:id',
    { onRequest: signedIn, schema: { params: EndpointParams } },
    async (request, reply) => {
      const loaded = await loadForManager(request, reply, request.params);
      if (!loaded) {
        return;
      }
      const { row } = loaded;
      const listening = await fastify.prisma.automation.count({
        where: {
          filters: { equals: row.id, path: ['endpointId'] },
          source: INBOUND_EVENT,
          teamId: row.teamId,
        },
      });
      if (listening > 0) {
        return sendError(
          reply,
          409,
          'EVENT_ENDPOINT_IN_USE',
          `${listening} automation${listening === 1 ? '' : 's'} react to this endpoint; remove ${listening === 1 ? 'it' : 'them'} first`
        );
      }
      await fastify.prisma.eventEndpoint.delete({ where: { id: row.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: requireUser(request),
        before: pickPublic(view({ ...row })),
        entityId: row.id,
        entityType: 'EventEndpoint',
      });
      return reply.status(204).send();
    }
  );
};

/** Only the public fields of a full row, for the audit log. */
function pickPublic(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [...Object.keys(publicSelect), 'path'].flatMap((k) => (k in row ? [[k, row[k]]] : []))
  );
}
