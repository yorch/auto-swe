import type { Prisma } from '@auto-swe/shared';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { type HeldScope, isPlatformAdmin, userActor } from '@auto-swe/shared/permissions';
import type { FastifyReply } from 'fastify';
import { ledTeams, memberTeams } from './tenantScope.js';

/** Templates the user may see: global ones, plus those of a team they belong to (all, for ADMIN). */
export function teamMembershipFilter(user: {
  sub: string;
  role: string;
}): Prisma.WorkflowTemplateWhereInput {
  if (isPlatformAdmin(userActor(user))) {
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
 * Write-scoped counterpart of `teamMembershipFilter`, built from the teams the caller holds
 * `team.templates.write` on (`heldScope(request, 'team.templates.write')`). Global templates
 * (`teamId: null`) are readable by everyone but may only be mutated by a platform admin, who holds
 * the capability everywhere (`all`). A team template needs the capability on an active owning team,
 * so a list and the action behind it cannot disagree.
 */
export function templateWriteWhere(held: HeldScope): Prisma.WorkflowTemplateWhereInput {
  if (held.all) {
    return {};
  }
  return {
    team: { id: { in: held.teamIds }, isActive: true },
    teamId: { not: null },
  };
}

/**
 * Transitional synchronous form for callers that have not moved to `templateWriteWhere` yet
 * (`routes/automations.ts`). Same rule as before: platform admin, or LEAD or ADMIN of an active
 * owning team.
 * @deprecated Use `templateWriteWhere(await heldScope(request, 'team.templates.write'))`.
 */
export function templateWriteFilter(user: {
  sub: string;
  role: string;
}): Prisma.WorkflowTemplateWhereInput {
  if (isPlatformAdmin(userActor(user))) {
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
  payload: Record<string, unknown>,
  opts?: { deferField?: string }
): boolean {
  if (!inputSchema || !isInputSchema(inputSchema)) {
    return true;
  }
  const result = validateInputPayload(inputSchema, payload);
  if (result.ok) {
    return true;
  }
  // A field whose value is built later is checked then; its errors are not this refusal's.
  const errors = opts?.deferField
    ? result.errors.filter((e) => !e.startsWith(`'${opts.deferField}'`))
    : result.errors;
  if (errors.length === 0) {
    return true;
  }
  reply.status(400).send({
    error: {
      code: 'INVALID_INPUT',
      details: errors,
      message: `Run input does not satisfy the template's input schema: ${errors.join('; ')}`,
    },
  });
  return false;
}
