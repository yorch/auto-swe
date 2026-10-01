import type { Prisma } from '@auto-swe/shared';
import { AGENT_RUN_TEMPLATE_NAME, isReservedTemplateOrigin } from '@auto-swe/shared/lib/agentRun';

/**
 * The hidden system templates (today: "Agent Run"). They are platform
 * machinery, not content: invisible in the template list, 404 on every
 * template route, never exported, and not creatable or renameable by name.
 */

export function isSystemTemplate(t: { origin?: string | null; teamId: string | null }): boolean {
  return t.teamId === null && isReservedTemplateOrigin(t.origin);
}

/** Case-insensitive: the seed matches by name and a near-miss must not slip through. */
export function isReservedTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === AGENT_RUN_TEMPLATE_NAME.toLowerCase();
}

/**
 * `where` fragment that leaves system templates out of a template query. Written
 * with an explicit `origin: null` arm because `NOT (origin LIKE 'system:%')` is
 * NULL, not true, for the (many) rows with no origin.
 */
export const EXCLUDE_SYSTEM_TEMPLATES: Prisma.WorkflowTemplateWhereInput = {
  OR: [{ origin: null }, { NOT: { origin: { startsWith: 'system:' } } }],
};
