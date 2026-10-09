import type { Prisma } from '@auto-swe/shared';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import type { FastifyReply } from 'fastify';
import { ledTeams, memberTeams } from './tenantScope.js';

/** Templates the user may see: global ones, plus those of a team they belong to (all, for ADMIN). */
export function teamMembershipFilter(user: {
  sub: string;
  role: string;
}): Prisma.WorkflowTemplateWhereInput {
  if (user.role === 'ADMIN') {
    return {};
  }
  return {
    OR: [
      { teamId: null }, // Global templates visible to everyone
      { team: memberTeams(user) },
    ],
  };
}

/**
 * Write-scoped counterpart of `teamMembershipFilter`. Global templates
 * (`teamId: null`) are readable by everyone but may only be mutated by a
 * platform admin — a LEAD must never be able to edit, version, promote or
 * re-key the platform-wide fallback every other team runs.
 *
 * A team template needs LEAD (or ADMIN) membership on an active owning team,
 * the same bar `canManageTeamRepos` sets for the team's repositories. The
 * route-level `requiredRole: 'LEAD'` checks only the platform role, so without
 * this a platform LEAD who is a plain ENGINEER on a team could rewrite the
 * workflow every one of that team's runs executes.
 */
export function templateWriteFilter(user: {
  sub: string;
  role: string;
}): Prisma.WorkflowTemplateWhereInput {
  if (user.role === 'ADMIN') {
    return {};
  }
  return {
    team: { ...ledTeams(user), isActive: true },
    teamId: { not: null },
  };
}

/**
 * The row a caller may launch a run of: the template must be ACTIVE and visible
 * to them. A fresh launch and a retry of an earlier request both use this, so
 * neither can start a run the other would refuse.
 */
export function launchableTemplateWhere(
  user: { sub: string; role: string },
  templateId: string
): Prisma.WorkflowTemplateWhereInput {
  return { id: templateId, status: 'ACTIVE', ...teamMembershipFilter(user) };
}

export function sendTemplateNotLaunchable(reply: FastifyReply) {
  return reply.status(404).send({
    error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found or not active' },
  });
}

/**
 * Validate run inputs against the template's declared `inputSchema`. Sends the
 * 400 `INVALID_INPUT` refusal and returns false when they do not satisfy it.
 */
export function inputsSatisfySchema(
  reply: FastifyReply,
  inputSchema: unknown,
  payload: Record<string, unknown>
): boolean {
  if (!inputSchema || !isInputSchema(inputSchema)) {
    return true;
  }
  const result = validateInputPayload(inputSchema, payload);
  if (result.ok) {
    return true;
  }
  reply.status(400).send({
    error: {
      code: 'INVALID_INPUT',
      details: result.errors,
      message: `Run input does not satisfy the template's input schema: ${result.errors.join('; ')}`,
    },
  });
  return false;
}
