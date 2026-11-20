/**
 * Team directory and join requests (`docs/specs/2026-11-20-team-join-requests.md` §7).
 *
 * Three plugins, one per mount point: `/api/v1/teams` (the directory, a request to join, and the team
 * step), `/api/v1/me` (the caller's own requests) and `/api/v1/{platform,admin}/organizations` (the
 * organization step). The rules and the transactions are in `lib/teamJoinRequests.ts`.
 *
 * Authorization, per route:
 *   - the directory, creating a request and the caller's own list are open to any signed-in person,
 *     so they use a bare `requireAuth()`: the catalog cannot say "everyone", and what matters
 *     (membership, visibility, ownership) depends on the row and is decided in the service;
 *   - the team queue and decisions are `team.members.manage` on the `:id` team, and the request must
 *     belong to that team;
 *   - the organization queue and decisions are `org.members.manage` on the `:orgId` organization,
 *     and the request must be for one of its teams.
 */
import {
  approveJoinRequestBodySchema,
  createJoinRequestBodySchema,
  decideJoinRequestBodySchema,
  joinRequestStatusSchema,
} from '@auto-swe/shared/lib/teamJoinRequests';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditContextOf } from '../lib/auditContext.js';
import { sendError } from '../lib/httpErrors.js';
import {
  approveAtOrgStep,
  approveAtTeamStep,
  createJoinRequest,
  listOrgRequests,
  listOwnRequests,
  listTeamRequests,
  loadDirectory,
  type Refusal,
  rejectAtOrgStep,
  rejectAtTeamStep,
  withdrawRequest,
} from '../lib/teamJoinRequests.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

// A body is optional on every route here: an empty POST means "no message / note / role". Fastify
// hands an absent body to the validator as `null`, which `.default()` does not catch.
const orEmpty = <T extends z.ZodType>(schema: T) => z.preprocess((body) => body ?? {}, schema);
const CreateBody = orEmpty(createJoinRequestBodySchema);
const ApproveBody = orEmpty(approveJoinRequestBodySchema);
const DecideBody = orEmpty(decideJoinRequestBodySchema);

const TeamParams = z.object({ id: z.string().uuid() });
const TeamRequestParams = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });
const OrgParams = z.object({ orgId: z.string().uuid() });
const OrgRequestParams = z.object({ orgId: z.string().uuid(), requestId: z.string().uuid() });
const RequestParams = z.object({ requestId: z.string().uuid() });

const DirectoryQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  orgId: z.string().uuid().optional(),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((q) => (q ? q : undefined)),
});

/** `?status=` on a queue: one status, or `ALL`. The team and organization queues default differently. */
const QueueQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.union([joinRequestStatusSchema, z.literal('ALL')]).optional(),
});

function send(reply: FastifyReply, refusal: Refusal) {
  if (refusal.retryAfterSeconds !== undefined) {
    reply.header('Retry-After', String(refusal.retryAfterSeconds));
  }
  return sendError(reply, refusal.status, refusal.code, refusal.message, refusal.details);
}

/** The directory, a request to join, and the team step. Mounted at `/api/v1/teams`. */
export const teamJoinRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/teams/directory: every active team the directory scope allows, public fields only.
  // A static segment, so it is never read as `/teams/:id`.
  app.get(
    '/directory',
    { onRequest: requireAuth(), schema: { querystring: DirectoryQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const result = await loadDirectory(fastify.prisma, user, request.query);
      if (!result.ok) {
        return send(reply, result);
      }
      const { ok: _ok, ...body } = result;
      return body;
    }
  );

  // POST /api/v1/teams/:id/join-requests
  app.post(
    '/:id/join-requests',
    {
      onRequest: requireAuth(),
      schema: { body: CreateBody, params: TeamParams },
    },
    async (request, reply) => {
      const result = await createJoinRequest(fastify, {
        actor: requireUser(request),
        context: auditContextOf(request),
        message: request.body.message,
        teamId: request.params.id,
      });
      if (!result.ok) {
        return send(reply, result);
      }
      return reply.status(201).send({ data: result.request });
    }
  );

  // GET /api/v1/teams/:id/join-requests?status=: the team's queue (default: awaiting the team)
  app.get(
    '/:id/join-requests',
    {
      onRequest: requireAuth({ capability: 'team.members.manage', team: { param: 'id' } }),
      schema: { params: TeamParams, querystring: QueueQuery },
    },
    async (request) => {
      const { limit, status } = request.query;
      return {
        data: await listTeamRequests(
          fastify.prisma,
          request.params.id,
          status ?? 'PENDING_TEAM',
          limit
        ),
      };
    }
  );

  // POST /api/v1/teams/:id/join-requests/:requestId/approve
  app.post(
    '/:id/join-requests/:requestId/approve',
    {
      onRequest: requireAuth({ capability: 'team.members.manage', team: { param: 'id' } }),
      schema: { body: ApproveBody, params: TeamRequestParams },
    },
    async (request, reply) => {
      const result = await approveAtTeamStep(fastify, {
        actor: requireUser(request),
        context: auditContextOf(request),
        note: request.body.note,
        requestId: request.params.requestId,
        role: request.body.role,
        teamId: request.params.id,
      });
      if (!result.ok) {
        return send(reply, result);
      }
      return { data: result.request };
    }
  );

  // POST /api/v1/teams/:id/join-requests/:requestId/reject
  app.post(
    '/:id/join-requests/:requestId/reject',
    {
      onRequest: requireAuth({ capability: 'team.members.manage', team: { param: 'id' } }),
      schema: { body: DecideBody, params: TeamRequestParams },
    },
    async (request, reply) => {
      const result = await rejectAtTeamStep(fastify, {
        actor: requireUser(request),
        context: auditContextOf(request),
        note: request.body.note,
        requestId: request.params.requestId,
        teamId: request.params.id,
      });
      if (!result.ok) {
        return send(reply, result);
      }
      return { data: result.request };
    }
  );
};

/** The caller's own requests. Mounted at `/api/v1/me`. */
export const meJoinRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/me/join-requests: newest first, with the team and organization names.
  // `meta.truncated` is true when the caller has more requests than the 200 returned.
  app.get('/join-requests', { onRequest: requireAuth() }, async (request) => {
    const { requests, truncated } = await listOwnRequests(fastify.prisma, requireUser(request).sub);
    return { data: requests, meta: { truncated } };
  });

  // POST /api/v1/me/join-requests/:requestId/withdraw: one's own open request only.
  app.post(
    '/join-requests/:requestId/withdraw',
    { onRequest: requireAuth(), schema: { params: RequestParams } },
    async (request, reply) => {
      const result = await withdrawRequest(fastify, {
        actor: requireUser(request),
        context: auditContextOf(request),
        requestId: request.params.requestId,
      });
      if (!result.ok) {
        return send(reply, result);
      }
      return { data: result.request };
    }
  );
};

/**
 * The organization step. Mounted at `/api/v1/platform/organizations`, and at the deprecated
 * `/api/v1/admin/organizations` alias beside its sibling organization routes.
 */
export const orgJoinRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET .../:orgId/join-requests?status=: the cross-organization requests of the organization's
  // teams (default: awaiting the organization).
  app.get(
    '/:orgId/join-requests',
    {
      onRequest: requireAuth({ capability: 'org.members.manage', org: { param: 'orgId' } }),
      schema: { params: OrgParams, querystring: QueueQuery },
    },
    async (request) => {
      const { limit, status } = request.query;
      return {
        data: await listOrgRequests(
          fastify.prisma,
          request.params.orgId,
          status ?? 'PENDING_ORG',
          limit
        ),
      };
    }
  );

  // POST .../:orgId/join-requests/:requestId/approve
  app.post(
    '/:orgId/join-requests/:requestId/approve',
    {
      onRequest: requireAuth({ capability: 'org.members.manage', org: { param: 'orgId' } }),
      schema: { body: DecideBody, params: OrgRequestParams },
    },
    async (request, reply) => {
      const result = await approveAtOrgStep(fastify, {
        actor: requireUser(request),
        context: auditContextOf(request),
        note: request.body.note,
        orgId: request.params.orgId,
        requestId: request.params.requestId,
      });
      if (!result.ok) {
        return send(reply, result);
      }
      return { data: result.request };
    }
  );

  // POST .../:orgId/join-requests/:requestId/reject
  app.post(
    '/:orgId/join-requests/:requestId/reject',
    {
      onRequest: requireAuth({ capability: 'org.members.manage', org: { param: 'orgId' } }),
      schema: { body: DecideBody, params: OrgRequestParams },
    },
    async (request, reply) => {
      const result = await rejectAtOrgStep(fastify, {
        actor: requireUser(request),
        context: auditContextOf(request),
        note: request.body.note,
        orgId: request.params.orgId,
        requestId: request.params.requestId,
      });
      if (!result.ok) {
        return send(reply, result);
      }
      return { data: result.request };
    }
  );
};
