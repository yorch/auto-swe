import type { Prisma, Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import {
  CALLBACK_EVENT_TYPES,
  callbackTargetOrigin,
  newEndpointSecretColumns,
  normaliseCallbackOrigin,
  normaliseCallbackPathPrefix,
  rotatedEndpointSecretColumns,
} from '@auto-swe/shared/lib/runCallbacks';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { paginationQuery } from '../lib/pagination.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Run-callback endpoints (docs/run-callbacks.md): the receivers a team allows
 * its runs to report to, their signing secrets, and the delivery history.
 *
 * Managed by the team's LEADs and ADMINs (a platform ADMIN manages every
 * team's). The secret is returned once, on create and on rotate, and never
 * written to the audit log. Opting an endpoint into a private network — which
 * waives the SSRF guard's private-address refusal for its origin — is
 * platform-ADMIN only, because it lets the worker reach the deployment's own
 * network.
 */

const TeamParams = z.object({ teamId: z.string().uuid() });
const EndpointParams = TeamParams.extend({ endpointId: z.string().uuid() });
const DeliveryParams = EndpointParams.extend({ deliveryId: z.string().uuid() });
const RunParams = z.object({ id: z.string().uuid() });

const EventsSchema = z
  .array(z.enum(CALLBACK_EVENT_TYPES))
  .min(1)
  .max(CALLBACK_EVENT_TYPES.length)
  .refine((events) => new Set(events).size === events.length, 'events must not repeat');

const CreateEndpointBody = z.object({
  /** Whether a public template webhook call may name this endpoint. */
  acceptTemplateWebhookLaunches: z.boolean().default(false),
  allowPrivateNetwork: z.boolean().default(false),
  events: EventsSchema.default(['run.completed']),
  name: z.string().trim().min(1).max(100),
  origin: z.string().trim().min(1).max(512),
  pathPrefix: z.string().max(512).optional(),
});

const UpdateEndpointBody = z.object({
  acceptTemplateWebhookLaunches: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  /** True disables the endpoint (no launch may choose it, due deliveries go DEAD); false enables it. */
  disabled: z.boolean().optional(),
  events: EventsSchema.optional(),
  name: z.string().trim().min(1).max(100).optional(),
  origin: z.string().trim().min(1).max(512).optional(),
  pathPrefix: z.string().max(512).optional(),
});

const DeliveriesQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 });

/** The endpoint columns any view reads; never the secret envelope. */
const ENDPOINT_VIEW_SELECT = {
  acceptTemplateWebhookLaunches: true,
  allowPrivateNetwork: true,
  createdAt: true,
  createdById: true,
  disabledAt: true,
  events: true,
  id: true,
  name: true,
  origin: true,
  pathPrefix: true,
  previousSigningSecretExpiresAt: true,
  signingSecretLastFour: true,
  teamId: true,
  updatedAt: true,
} as const;

type EndpointViewRow = Prisma.CallbackEndpointGetPayload<{ select: typeof ENDPOINT_VIEW_SELECT }>;

function endpointView(row: EndpointViewRow, now: Date = new Date()) {
  const previous = row.previousSigningSecretExpiresAt;
  return {
    acceptTemplateWebhookLaunches: row.acceptTemplateWebhookLaunches,
    allowPrivateNetwork: row.allowPrivateNetwork,
    createdAt: row.createdAt,
    createdById: row.createdById,
    disabled: row.disabledAt !== null,
    disabledAt: row.disabledAt,
    events: row.events,
    id: row.id,
    name: row.name,
    origin: row.origin,
    pathPrefix: row.pathPrefix,
    previousSecretExpiresAt: previous && previous > now ? previous : null,
    secretLastFour: row.signingSecretLastFour,
    teamId: row.teamId,
    updatedAt: row.updatedAt,
  };
}

/** What the audit log keeps: the configuration, never a secret. */
function auditFields(row: EndpointViewRow) {
  return {
    acceptTemplateWebhookLaunches: row.acceptTemplateWebhookLaunches,
    allowPrivateNetwork: row.allowPrivateNetwork,
    disabled: row.disabledAt !== null,
    events: row.events,
    name: row.name,
    origin: row.origin,
    pathPrefix: row.pathPrefix,
    teamId: row.teamId,
  };
}

const DELIVERY_VIEW_SELECT = {
  attempts: true,
  createdAt: true,
  deadAt: true,
  deadReason: true,
  deliveredAt: true,
  endpoint: { select: { id: true, name: true, teamId: true } },
  event: true,
  id: true,
  lastAttemptAt: true,
  lastError: true,
  lastStatusCode: true,
  nextAttemptAt: true,
  runCallback: { select: { target: true } },
  status: true,
  workflowRunId: true,
} as const;

type DeliveryViewRow = Prisma.OutboundDeliveryGetPayload<{ select: typeof DELIVERY_VIEW_SELECT }>;

/** A delivery as listed: outcome and timing only. Never the payload, a body or an error's text. */
function deliveryView(row: DeliveryViewRow, canRedeliver: boolean) {
  return {
    attempts: row.attempts,
    canRedeliver: canRedeliver && row.status === 'DEAD' && row.endpoint !== null,
    createdAt: row.createdAt,
    deadAt: row.deadAt,
    deadReason: row.deadReason,
    deliveredAt: row.deliveredAt,
    endpoint: row.endpoint,
    event: row.event,
    id: row.id,
    lastAttemptAt: row.lastAttemptAt,
    lastError: row.lastError,
    lastStatusCode: row.lastStatusCode,
    nextAttemptAt: row.status === 'PENDING' ? row.nextAttemptAt : null,
    status: row.status,
    target: row.runCallback?.target ?? null,
    workflowRunId: row.workflowRunId,
  };
}

function refuseOrigin(reply: FastifyReply, code: string, reason: string) {
  return sendError(
    reply,
    400,
    code,
    code === 'BASE_URL_REFUSED'
      ? `Origin refused: ${reason}. The private-network option permits private addresses only, never loopback, link-local or metadata addresses.`
      : `Origin refused: ${reason}`
  );
}

function refusePrivateNetwork(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    'PRIVATE_NETWORK_ADMIN_ONLY',
    'Only a platform admin may let a callback endpoint reach a private network'
  );
}

/**
 * A delivery as a run viewer outside the endpoint's team sees it: the origin it went to and how
 * it went — not the path (which can itself be a receiver's secret), the endpoint or its errors.
 */
function limitedDeliveryView(row: DeliveryViewRow) {
  return {
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    event: row.event,
    id: row.id,
    status: row.status,
    target: callbackTargetOrigin(row.runCallback?.target),
  };
}

/** The caller's standing on an endpoint's team: any membership, and LEAD+ (or platform ADMIN). */
async function teamAccess(
  prisma: Parameters<FastifyPluginAsync>[0]['prisma'],
  user: JwtPayload,
  teamId: string
): Promise<{ member: boolean; manages: boolean }> {
  if (user.role === 'ADMIN') {
    return { manages: true, member: true };
  }
  const membership = await prisma.teamMembership.findUnique({
    select: { role: true },
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  return {
    manages: !!membership && roleMeets(membership.role as Role, 'LEAD' as Role),
    member: !!membership,
  };
}

/** `/api/v1/teams/:teamId/callback-endpoints`. */
export const callbackEndpointRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const manage = requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'teamId' });

  async function loadEndpoint(teamId: string, endpointId: string) {
    return fastify.prisma.callbackEndpoint.findFirst({ where: { id: endpointId, teamId } });
  }

  app.get(
    '/:teamId/callback-endpoints',
    { onRequest: manage, schema: { params: TeamParams } },
    async (request) => {
      const rows = await fastify.prisma.callbackEndpoint.findMany({
        orderBy: { name: 'asc' },
        select: ENDPOINT_VIEW_SELECT,
        where: { teamId: request.params.teamId },
      });
      return { data: rows.map((r) => endpointView(r)) };
    }
  );

  app.post(
    '/:teamId/callback-endpoints',
    { onRequest: manage, schema: { body: CreateEndpointBody, params: TeamParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body;
      if (body.allowPrivateNetwork && user.role !== 'ADMIN') {
        return refusePrivateNetwork(reply);
      }
      const origin = normaliseCallbackOrigin(body.origin, body.allowPrivateNetwork);
      if (!origin.ok) {
        return refuseOrigin(reply, origin.code, origin.reason);
      }
      const prefix = normaliseCallbackPathPrefix(body.pathPrefix);
      if (!prefix.ok) {
        return sendError(reply, 400, prefix.code, `Path prefix refused: ${prefix.reason}`);
      }
      const sealed = newEndpointSecretColumns();
      try {
        const row = await fastify.prisma.$transaction(async (tx) => {
          const created = await tx.callbackEndpoint.create({
            data: {
              ...sealed.data,
              acceptTemplateWebhookLaunches: body.acceptTemplateWebhookLaunches,
              allowPrivateNetwork: body.allowPrivateNetwork,
              createdById: user.sub,
              events: body.events,
              name: body.name,
              origin: origin.origin,
              pathPrefix: prefix.pathPrefix,
              teamId: request.params.teamId,
            },
            select: ENDPOINT_VIEW_SELECT,
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor: user,
            after: auditFields(created),
            client: tx,
            entityId: created.id,
            entityType: 'CallbackEndpoint',
          });
          return created;
        });
        // The secret is shown here and on rotation only; it cannot be read back.
        return reply.status(201).send({ data: endpointView(row), secret: sealed.secret });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'CALLBACK_ENDPOINT_EXISTS',
            'This team already has a callback endpoint with that name'
          );
        }
        throw err;
      }
    }
  );

  app.patch(
    '/:teamId/callback-endpoints/:endpointId',
    { onRequest: manage, schema: { body: UpdateEndpointBody, params: EndpointParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body;
      const existing = await loadEndpoint(request.params.teamId, request.params.endpointId);
      if (!existing) {
        return sendError(reply, 404, 'CALLBACK_ENDPOINT_NOT_FOUND', 'Callback endpoint not found');
      }
      if (
        body.allowPrivateNetwork === true &&
        !existing.allowPrivateNetwork &&
        user.role !== 'ADMIN'
      ) {
        return refusePrivateNetwork(reply);
      }
      // The opt-in was granted for one destination. Moving that destination while the opt-in
      // stays would extend it to an origin or path no admin approved, so only an admin may.
      const privateAfter = body.allowPrivateNetwork ?? existing.allowPrivateNetwork;
      const movesDestination =
        (body.origin !== undefined && body.origin !== existing.origin) ||
        (body.pathPrefix !== undefined && body.pathPrefix !== existing.pathPrefix);
      // Accepting template-webhook launches widens who may send to the destination the same way.
      const opensToWebhooks =
        body.acceptTemplateWebhookLaunches === true && !existing.acceptTemplateWebhookLaunches;
      if (
        (movesDestination || opensToWebhooks) &&
        (existing.allowPrivateNetwork || privateAfter) &&
        user.role !== 'ADMIN'
      ) {
        return refusePrivateNetwork(reply);
      }
      const allowPrivate = body.allowPrivateNetwork ?? existing.allowPrivateNetwork;
      const data: Prisma.CallbackEndpointUpdateInput = {};
      // The origin is checked whenever it changes or the opt-in is granted. A write that only
      // removes the opt-in is never blocked: it narrows what the endpoint may reach, and a
      // delivery to an origin that now fails the guard is refused when it is sent.
      if (body.origin !== undefined || body.allowPrivateNetwork === true) {
        const origin = normaliseCallbackOrigin(body.origin ?? existing.origin, allowPrivate);
        if (!origin.ok) {
          return refuseOrigin(reply, origin.code, origin.reason);
        }
        data.origin = origin.origin;
      }
      if (body.pathPrefix !== undefined) {
        const prefix = normaliseCallbackPathPrefix(body.pathPrefix);
        if (!prefix.ok) {
          return sendError(reply, 400, prefix.code, `Path prefix refused: ${prefix.reason}`);
        }
        data.pathPrefix = prefix.pathPrefix;
      }
      if (body.allowPrivateNetwork !== undefined) {
        data.allowPrivateNetwork = body.allowPrivateNetwork;
      }
      if (body.acceptTemplateWebhookLaunches !== undefined) {
        data.acceptTemplateWebhookLaunches = body.acceptTemplateWebhookLaunches;
      }
      if (body.events !== undefined) {
        data.events = body.events;
      }
      if (body.name !== undefined) {
        data.name = body.name;
      }
      if (body.disabled !== undefined) {
        data.disabledAt = body.disabled ? (existing.disabledAt ?? new Date()) : null;
      }
      try {
        const row = await fastify.prisma.$transaction(async (tx) => {
          const updated = await tx.callbackEndpoint.update({
            data,
            select: ENDPOINT_VIEW_SELECT,
            where: { id: existing.id },
          });
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor: user,
            after: auditFields(updated),
            before: auditFields(existing),
            client: tx,
            entityId: existing.id,
            entityType: 'CallbackEndpoint',
          });
          return updated;
        });
        return { data: endpointView(row) };
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'CALLBACK_ENDPOINT_EXISTS',
            'This team already has a callback endpoint with that name'
          );
        }
        throw err;
      }
    }
  );

  app.post(
    '/:teamId/callback-endpoints/:endpointId/rotate-secret',
    { onRequest: manage, schema: { params: EndpointParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await loadEndpoint(request.params.teamId, request.params.endpointId);
      if (!existing) {
        return sendError(reply, 404, 'CALLBACK_ENDPOINT_NOT_FOUND', 'Callback endpoint not found');
      }
      const rotated = rotatedEndpointSecretColumns(existing, new Date());
      const row = await fastify.prisma.$transaction(async (tx) => {
        // Conditional on the secret read above, so two concurrent rotations cannot both keep
        // the same "previous" and lose the secret the first one issued.
        const { count } = await tx.callbackEndpoint.updateMany({
          data: rotated.data,
          where: {
            id: existing.id,
            signingSecretNonce: existing.signingSecretNonce,
            teamId: existing.teamId,
          },
        });
        if (count === 0) {
          return null;
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { secretRotated: true },
          client: tx,
          entityId: existing.id,
          entityType: 'CallbackEndpoint',
        });
        return tx.callbackEndpoint.findUniqueOrThrow({
          select: ENDPOINT_VIEW_SELECT,
          where: { id: existing.id },
        });
      });
      if (!row) {
        return sendError(
          reply,
          409,
          'CALLBACK_ENDPOINT_CHANGED',
          'The secret was rotated concurrently; reload and try again'
        );
      }
      return {
        data: endpointView(row),
        previousSecretExpiresAt: rotated.previousExpiresAt,
        secret: rotated.secret,
      };
    }
  );

  app.delete(
    '/:teamId/callback-endpoints/:endpointId',
    { onRequest: manage, schema: { params: EndpointParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await loadEndpoint(request.params.teamId, request.params.endpointId);
      if (!existing) {
        return sendError(reply, 404, 'CALLBACK_ENDPOINT_NOT_FOUND', 'Callback endpoint not found');
      }
      await fastify.prisma.$transaction(async (tx) => {
        // Pending deliveries keep their row (endpoint unset) and go DEAD at their next send.
        await tx.callbackEndpoint.delete({ where: { id: existing.id } });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: user,
          before: auditFields(existing),
          client: tx,
          entityId: existing.id,
          entityType: 'CallbackEndpoint',
        });
      });
      return reply.status(204).send();
    }
  );

  app.get(
    '/:teamId/callback-endpoints/:endpointId/deliveries',
    { onRequest: manage, schema: { params: EndpointParams, querystring: DeliveriesQuery } },
    async (request, reply) => {
      const existing = await loadEndpoint(request.params.teamId, request.params.endpointId);
      if (!existing) {
        return sendError(reply, 404, 'CALLBACK_ENDPOINT_NOT_FOUND', 'Callback endpoint not found');
      }
      const where = { endpointId: existing.id };
      const [rows, total] = await Promise.all([
        fastify.prisma.outboundDelivery.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: DELIVERY_VIEW_SELECT,
          skip: request.query.offset,
          take: request.query.limit,
          where,
        }),
        fastify.prisma.outboundDelivery.count({ where }),
      ]);
      return { data: rows.map((r) => deliveryView(r, true)), total };
    }
  );

  // Back to PENDING, due now, with a fresh 24 h retry window and the same id and body, so a
  // receiver that already processed it recognises it. A delivered row is not resent.
  app.post(
    '/:teamId/callback-endpoints/:endpointId/deliveries/:deliveryId/redeliver',
    { onRequest: manage, schema: { params: DeliveryParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await loadEndpoint(request.params.teamId, request.params.endpointId);
      if (!existing) {
        return sendError(reply, 404, 'CALLBACK_ENDPOINT_NOT_FOUND', 'Callback endpoint not found');
      }
      if (existing.disabledAt) {
        return sendError(
          reply,
          409,
          'CALLBACK_ENDPOINT_DISABLED',
          'Enable the endpoint before redelivering to it'
        );
      }
      const delivery = await fastify.prisma.outboundDelivery.findFirst({
        select: { id: true, status: true },
        where: { endpointId: existing.id, id: request.params.deliveryId },
      });
      if (!delivery) {
        return sendError(reply, 404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
      }
      if (delivery.status === 'DELIVERED') {
        return sendError(reply, 409, 'ALREADY_DELIVERED', 'This delivery was already delivered');
      }
      // A pending delivery is still being retried (and may be mid-send); resetting it would send
      // it twice. Only a dead one is redelivered.
      if (delivery.status === 'PENDING') {
        return sendError(
          reply,
          409,
          'DELIVERY_PENDING',
          'This delivery is still being retried; redeliver it once it is dead'
        );
      }
      const now = new Date();
      const row = await fastify.prisma.$transaction(async (tx) => {
        const { count } = await tx.outboundDelivery.updateMany({
          data: {
            attempts: 0,
            claimToken: null,
            deadAt: null,
            deadReason: null,
            nextAttemptAt: now,
            retryWindowStartedAt: now,
            status: 'PENDING',
          },
          where: { endpointId: existing.id, id: delivery.id, status: 'DEAD' },
        });
        if (count === 0) {
          return null;
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { status: 'PENDING' },
          before: { status: delivery.status },
          client: tx,
          entityId: delivery.id,
          entityType: 'OutboundDelivery',
        });
        return tx.outboundDelivery.findUniqueOrThrow({
          select: DELIVERY_VIEW_SELECT,
          where: { id: delivery.id },
        });
      });
      if (!row) {
        return sendError(
          reply,
          409,
          'DELIVERY_CHANGED',
          'The delivery changed; reload and try again'
        );
      }
      return { data: deliveryView(row, true) };
    }
  );
};

/** `/api/v1/workflow-runs/:id/callback-deliveries`: a run's deliveries, for whoever can see the run. */
export const runCallbackDeliveryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:id/callback-deliveries',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: RunParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        select: {
          id: true,
          workflowId: true,
          workRequest: {
            select: {
              callback: {
                select: { endpoint: { select: { teamId: true } }, target: true, workflowId: true },
              },
            },
          },
        },
        where: {
          id: request.params.id,
          ...buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
        },
      });
      if (!run) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      const rows = await fastify.prisma.outboundDelivery.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: DELIVERY_VIEW_SELECT,
        take: 100,
        where: { workflowRunId: run.id },
      });
      // Full detail (the endpoint, the path, attempts, errors) for the endpoint's team and admins;
      // anyone else who can see the run sees the origin each delivery went to and how it ended.
      const callback =
        run.workRequest?.callback?.workflowId === run.workflowId ? run.workRequest.callback : null;
      const access = new Map<string, { member: boolean; manages: boolean }>();
      const teamIds = new Set(rows.flatMap((r) => (r.endpoint ? [r.endpoint.teamId] : [])));
      if (callback?.endpoint) {
        teamIds.add(callback.endpoint.teamId);
      }
      for (const teamId of teamIds) {
        access.set(teamId, await teamAccess(fastify.prisma, user, teamId));
      }
      const seesPath = callback?.endpoint
        ? access.get(callback.endpoint.teamId)?.member === true
        : user.role === 'ADMIN';
      return {
        data: {
          deliveries: rows.map((r) => {
            const a = r.endpoint ? access.get(r.endpoint.teamId) : undefined;
            return a?.member ? deliveryView(r, a.manages) : limitedDeliveryView(r);
          }),
          // The request's callback reports only the execution that asked for it, not a re-run.
          target: callback
            ? seesPath
              ? callback.target
              : callbackTargetOrigin(callback.target)
            : null,
        },
      };
    }
  );
};
