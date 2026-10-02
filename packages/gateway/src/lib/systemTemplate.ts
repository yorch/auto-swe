import type { Prisma } from '@auto-swe/shared';
import { isReservedTemplateOrigin } from '@auto-swe/shared/lib/agentRun';

export { isReservedTemplateName } from '@auto-swe/shared/lib/agentRun';

/**
 * The hidden system templates (today: "Agent Run"). They are platform
 * machinery, not content: invisible in the template list, 404 on every
 * template route, never exported, and not creatable or renameable by name.
 */

export function isSystemTemplate(t: { origin?: string | null; teamId: string | null }): boolean {
  return t.teamId === null && isReservedTemplateOrigin(t.origin);
}

/**
 * `where` fragment that leaves system templates out of a template query. Written
 * with an explicit `origin: null` arm because `NOT (origin LIKE 'system:%')` is
 * NULL, not true, for the (many) rows with no origin.
 *
 * It is keyed `OR`. Do not spread it next to another `OR`-keyed fragment (the
 * team-membership filter is one): the later spread silently replaces the earlier.
 * Combine with `AND: [a, EXCLUDE_SYSTEM_TEMPLATES]`.
 */
export const EXCLUDE_SYSTEM_TEMPLATES: Prisma.WorkflowTemplateWhereInput = {
  OR: [{ origin: null }, { NOT: { origin: { startsWith: 'system:' } } }],
};
