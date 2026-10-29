import type { FastifyInstance } from 'fastify';
import type { SpecCheckIssue } from './specCheck.js';
import { isReservedTemplateName } from './systemTemplate.js';

// The outcomes of saving a template that depend on the template's name and on the versions it
// already has, rather than on the spec. The save routes and the read-only
// `POST /workflow-templates/validate` share the predicates and the messages below, so what the
// check reports and what a save answers cannot drift apart.

export const RESERVED_TEMPLATE_NAME_MESSAGE = 'That template name is reserved';
export const TEMPLATE_NAME_CONFLICT_MESSAGE = 'A template with this name already exists';

/**
 * Whether another template already holds `name` in `teamId`. This is the predicate behind the
 * database's unique `(team_id, name)` index, whose violation the create route answers as
 * `409 NAME_CONFLICT`. A global template (`teamId === null`) can never conflict: Postgres treats
 * NULLs as distinct in a unique index, so the save accepts a repeated global name and so does
 * this. `exceptTemplateId` leaves out the template being renamed, so keeping its own name is
 * not a conflict.
 *
 * The caller must already have established that the user may save into `teamId`: the lookup reads
 * that team's names and nothing else, which is what keeps it from revealing a name in a team
 * the caller cannot see.
 */
export async function templateNameTaken(
  prisma: FastifyInstance['prisma'],
  teamId: string | null,
  name: string,
  exceptTemplateId?: string
): Promise<boolean> {
  if (teamId === null) {
    return false;
  }
  const row = await prisma.workflowTemplate.findFirst({
    select: { id: true },
    where: { name, teamId, ...(exceptTemplateId ? { id: { not: exceptTemplateId } } : {}) },
  });
  return row !== null;
}

/** The highest version number `templateId` has, or 0. A new version is numbered after it. */
export async function latestTemplateVersion(
  prisma: FastifyInstance['prisma'],
  templateId: string
): Promise<number> {
  const last = await prisma.workflowTemplateVersion.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
    where: { templateId },
  });
  return last?.version ?? 0;
}

/**
 * What a save of a template called `name` into `teamId` would answer, as findings and without
 * writing: `RESERVED_TEMPLATE_NAME` (a save answers 400) and `NAME_CONFLICT` (409). With
 * `templateId` it is a rename of that template, and with `baseVersion` it also reports a base
 * that is no longer the newest version (`STALE_BASE_VERSION`, a warning: a save does not refuse
 * it, it appends a version built on the older content, which supersedes the newer ones).
 * `teamId` must be a scope the caller may save into (see `templateNameTaken`).
 */
export async function checkTemplateSave(
  prisma: FastifyInstance['prisma'],
  args: { teamId: string | null; templateId?: string; name?: string; baseVersion?: number }
): Promise<SpecCheckIssue[]> {
  const issues: SpecCheckIssue[] = [];
  const { teamId, templateId, name, baseVersion } = args;
  if (name !== undefined) {
    if (isReservedTemplateName(name)) {
      issues.push({
        code: 'RESERVED_TEMPLATE_NAME',
        field: 'name',
        message: RESERVED_TEMPLATE_NAME_MESSAGE,
        severity: 'error',
        source: 'save',
      });
    } else if (await templateNameTaken(prisma, teamId, name, templateId)) {
      issues.push({
        code: 'NAME_CONFLICT',
        field: 'name',
        message: TEMPLATE_NAME_CONFLICT_MESSAGE,
        severity: 'error',
        source: 'save',
      });
    }
  }
  if (templateId && baseVersion !== undefined) {
    const latest = await latestTemplateVersion(prisma, templateId);
    if (latest > baseVersion) {
      issues.push({
        code: 'STALE_BASE_VERSION',
        field: 'baseVersion',
        message: `This edit is based on version ${baseVersion}, but the template is now at version ${latest}. Saving creates version ${latest + 1} from this content, which replaces the changes in the newer versions.`,
        severity: 'warning',
        source: 'save',
      });
    }
  }
  return issues;
}
