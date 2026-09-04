import crypto from 'node:crypto';
import { Role } from '@auto-swe/shared';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import bcrypt from 'bcrypt';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { getDefaultClientOrigin } from '../lib/env.js';
import { invalidateSessionCache, requireAuth, requireUser } from '../plugins/auth.js';

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).optional(), // Auto-generated if not provided
  role: z.enum([Role.ADMIN, Role.LEAD, Role.ENGINEER]).default(Role.ENGINEER),
  // Non-empty so the truthiness guards on slackId can't be bypassed with "".
  slackId: z.string().min(1).optional(),
});

const UserParamsSchema = z.object({ id: z.string().uuid() });

const UpdateUserSchema = z.object({
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
  role: z.enum([Role.ADMIN, Role.LEAD, Role.ENGINEER]).optional(),
  // Non-empty when present; null explicitly unlinks. "" can't slip past the
  // truthiness guard on the uniqueness pre-check.
  slackId: z.string().min(1).nullable().optional(),
});

/**
 * If `err` is a Prisma unique-constraint violation (P2002) on the user table,
 * send the matching 409 and return the reply; otherwise return null so the
 * caller rethrows. This maps a race that slips past the application-level
 * pre-check into the right 409 rather than a generic 500 — the DB `@unique`
 * constraints on email + slackId are the real guarantee. Shared by the create
 * and update handlers so the mapping lives in one place.
 */
type UserRow = {
  createdAt: Date;
  email: string;
  id: string;
  isActive: boolean;
  role: string;
  slackId: string | null;
};

type UserAuditRow = UserRow & { emailVerified?: boolean };

/// Auditable subset of a user row. Password hashes and other credential
/// material are intentionally omitted — the audit log answers "who changed what
/// about this account", not "what is the hash".
function safeUserAuditFields(row: Partial<UserAuditRow>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'email', 'emailVerified', 'isActive', 'role', 'slackId'] as const) {
    if (row[key] !== undefined) {
      out[key] = row[key];
    }
  }
  return out;
}

function replyOnUserUniqueViolation(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') {
    return null;
  }
  const t = e.meta?.target;
  const target = Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
  const isSlack = target.includes('slack');
  return reply.status(409).send({
    error: {
      code: isSlack ? 'SLACK_ID_TAKEN' : 'USER_EXISTS',
      message: isSlack
        ? 'This Slack ID is linked to another user'
        : 'User with this email already exists',
    },
  });
}

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/users — List users (ADMIN only)
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: Role.ADMIN }),
    },
    async () => {
      const users = await fastify.prisma.user.findMany({
        orderBy: { email: 'asc' },
        select: {
          createdAt: true,
          email: true,
          id: true,
          isActive: true,
          memberships: {
            select: { role: true, team: { select: { id: true, name: true, slug: true } } },
          },
          role: true,
          slackId: true,
        },
      });
      return { data: users };
    }
  );

  // POST /api/v1/users — Create user (ADMIN only)
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: Role.ADMIN }),
      schema: { body: CreateUserSchema },
    },
    async (request, reply) => {
      const { email, password, role, slackId } = request.body;

      const existing = await fastify.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'USER_EXISTS', message: 'User with this email already exists' },
        });
      }

      // slackId must be unique — a collision would make the Slack webhook/slash
      // handlers (which resolve users by slackId) ambiguous.
      if (slackId) {
        const slackTaken = await fastify.prisma.user.findFirst({ where: { slackId } });
        if (slackTaken) {
          return reply.status(409).send({
            error: { code: 'SLACK_ID_TAKEN', message: 'This Slack ID is linked to another user' },
          });
        }
      }

      const plainPassword = password ?? crypto.randomBytes(16).toString('base64url');
      const passwordHash = await bcrypt.hash(plainPassword, 12);

      let user: UserRow;
      try {
        user = await fastify.prisma.user.create({
          data: { email, passwordHash, role, slackId },
          select: {
            createdAt: true,
            email: true,
            id: true,
            isActive: true,
            role: true,
            slackId: true,
          },
        });
      } catch (err) {
        // The pre-checks above cover the common case; this maps a concurrent
        // collision (caught by the DB @unique constraints) to the right 409.
        const conflict = replyOnUserUniqueViolation(err, reply);
        if (conflict) {
          return conflict;
        }
        throw err;
      }

      const actor = requireUser(request);
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: safeUserAuditFields(user),
        entityId: user.id,
        entityType: 'User',
      });

      return reply.status(201).send({
        data: {
          ...user,
          // Only return the generated password on creation
          ...(password ? {} : { temporaryPassword: plainPassword }),
        },
      });
    }
  );

  // POST /api/v1/users/invite — Admin invites a new user by email.
  // The user lands pre-active (skip the approval queue — admin vouched)
  // and pre-membered to the default team. We immediately fire a magic-link
  // so the invitee can sign in by clicking the email. They never see a
  // password screen.
  app.post(
    '/invite',
    {
      onRequest: requireAuth({ requiredRole: Role.ADMIN }),
      schema: {
        body: z.object({
          email: z.string().email(),
          role: z.enum([Role.ADMIN, Role.LEAD, Role.ENGINEER]).default(Role.ENGINEER),
        }),
      },
    },
    async (request, reply) => {
      const { email, role } = request.body;
      const existing = await fastify.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'USER_EXISTS', message: 'User with this email already exists' },
        });
      }

      const user = await fastify.prisma.user.create({
        data: {
          email,
          emailVerified: true, // Admin vouched for this email
          isActive: true, // Admin-invited → skip the approval queue
          role,
        },
        select: { email: true, emailVerified: true, id: true, isActive: true, role: true },
      });

      const actor = requireUser(request);
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: safeUserAuditFields(user),
        entityId: user.id,
        entityType: 'User',
      });

      // Pre-attach to the default team so the new user sees something on
      // first sign-in. Soft-fails if the team doesn't exist (seed missing).
      const { defaultTeamSlug } = await resolveWorkflowDefaults();
      const defaultTeam = await fastify.prisma.team.findUnique({
        where: { slug: defaultTeamSlug },
      });
      if (defaultTeam) {
        await fastify.prisma.teamMembership
          .upsert({
            create: { role: Role.ENGINEER, teamId: defaultTeam.id, userId: user.id },
            update: {},
            where: { userId_teamId: { teamId: defaultTeam.id, userId: user.id } },
          })
          .catch((err: unknown) => {
            request.log.warn({ err, userId: user.id }, 'default-team enrolment failed (non-fatal)');
          });
      }

      // Send a magic-link via better-auth so the invitee can sign in
      // without ever choosing a password. Lazy-load betterAuth to avoid
      // a circular import (routes/users → lib/betterAuth → adapter →
      // PrismaClient already in scope here).
      try {
        const { getAuth } = await import('../lib/betterAuth.js');
        const clientOrigin = getDefaultClientOrigin();
        await getAuth().api.signInMagicLink({
          body: { callbackURL: `${clientOrigin}/login?bridge=1`, email },
          // better-auth's typing requires a Headers object even for purely
          // server-side invocations (no real browser headers to forward here).
          headers: new Headers(),
        });
      } catch (err) {
        fastify.log.warn({ err }, 'invite magic-link send failed — user row was created');
      }

      return reply.status(201).send({ data: user });
    }
  );

  // PATCH /api/v1/users/:id — Update user (ADMIN only)
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: Role.ADMIN }),
      schema: { body: UpdateUserSchema, params: UserParamsSchema },
    },
    async (request, reply) => {
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.params.id },
      });
      if (!user) {
        return reply.status(404).send({
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
        });
      }

      // Prevent an admin from locking themselves (and potentially every
      // admin) out: self-deactivation and self-demotion are blocked, but
      // other self-edits (email, slackId) and edits to other users pass
      // through unaffected.
      const actor = requireUser(request);
      if (actor.sub === request.params.id) {
        if (request.body.isActive === false) {
          return reply.status(400).send({
            error: {
              code: 'CANNOT_SELF_DEACTIVATE',
              message: 'You cannot deactivate your own account.',
            },
          });
        }
        if (request.body.role !== undefined && request.body.role !== Role.ADMIN) {
          return reply.status(400).send({
            error: {
              code: 'CANNOT_SELF_DEMOTE',
              message: 'You cannot remove your own admin role.',
            },
          });
        }
      }

      // Guard slackId uniqueness on reassignment (see POST handler note).
      if (request.body.slackId) {
        const slackTaken = await fastify.prisma.user.findFirst({
          where: { id: { not: request.params.id }, slackId: request.body.slackId },
        });
        if (slackTaken) {
          return reply.status(409).send({
            error: { code: 'SLACK_ID_TAKEN', message: 'This Slack ID is linked to another user' },
          });
        }
      }

      try {
        const updated = await fastify.prisma.user.update({
          data: request.body,
          select: { email: true, id: true, isActive: true, role: true, slackId: true },
          where: { id: request.params.id },
        });
        // A demotion or deactivation must take effect now, not after the
        // session cache's TTL — drop every cached session for the user.
        const privilegeChanged =
          (request.body.role !== undefined && request.body.role !== user.role) ||
          (request.body.isActive !== undefined && request.body.isActive !== user.isActive);
        if (privilegeChanged) {
          const sessions = await fastify.prisma.session.findMany({
            select: { token: true },
            where: { userId: updated.id },
          });
          for (const session of sessions) {
            invalidateSessionCache(session.token);
          }
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor,
          after: safeUserAuditFields(updated),
          before: safeUserAuditFields({
            email: user.email,
            id: user.id,
            isActive: user.isActive,
            role: user.role,
            slackId: user.slackId,
          }),
          entityId: updated.id,
          entityType: 'User',
        });
        return { data: updated };
      } catch (err) {
        const conflict = replyOnUserUniqueViolation(err, reply);
        if (conflict) {
          return conflict;
        }
        throw err;
      }
    }
  );
};
