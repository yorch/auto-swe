import type { CapabilityKey } from './catalog/index.js';

/**
 * Constraints are not capabilities. They are separation of duties or ownership ("not yourself",
 * "the launcher", "not the author"), and platform `ADMIN` does not satisfy them. Domain code
 * composes one with a capability: `can(...)` AND `constraint(...)`. A constraint never widens
 * access, and none of these takes a role, so the helpers themselves treat every actor alike.
 *
 * One documented exception sits in the caller, not in a helper: the template review route lets a
 * platform `ADMIN` review a generated version they created (`notAuthor` is skipped for them). A
 * single-admin deployment could otherwise never promote a generated version, and an administrator
 * can already author an unreviewed version. No other constraint has an administrator exception.
 */

/** The actor is not the person the change is about (no self-removal, no self-demotion). */
export function notSelf(actorId: string, targetUserId: string): boolean {
  return actorId !== targetUserId;
}

/** The actor launched the run. A run with no recorded launcher has none to satisfy. */
export function isLauncher(actorId: string, launchedById: string | null | undefined): boolean {
  return !!launchedById && actorId === launchedById;
}

/** The actor did not author the change they are asked to review. */
export function notAuthor(actorId: string, authorId: string | null | undefined): boolean {
  return !authorId || actorId !== authorId;
}

/** The thing is assigned to the actor (one assignee, or a list of approvers). */
export function isAssignee(
  actorId: string,
  assignees: string | readonly string[] | null | undefined
): boolean {
  if (!assignees) {
    return false;
  }
  return typeof assignees === 'string' ? assignees === actorId : assignees.includes(actorId);
}

export interface ConstraintDef {
  /** Function name above, and the refusal code a handler answers with. */
  name: 'notSelf' | 'isLauncher' | 'notAuthor' | 'isAssignee';
  description: string;
  /** The capabilities it is composed with. Listed beside them in the generated reference. */
  accompanies: readonly CapabilityKey[];
}

/** Listed in the generated reference beside the capabilities they accompany. */
export const CONSTRAINTS: readonly ConstraintDef[] = [
  {
    accompanies: ['team.members.manage', 'org.members.manage', 'platform.users.manage'],
    description:
      'Nobody removes or demotes themselves (`SELF_REMOVAL`, `SELF_DEMOTION`); nobody deactivates or demotes their own platform account.',
    name: 'notSelf',
  },
  {
    accompanies: ['team.runs.control', 'team.orchestrations.stop'],
    description:
      'Only the launcher steers an orchestration; an administrator may emergency-stop one only when a service principal launched it.',
    name: 'isLauncher',
  },
  {
    accompanies: ['team.templates.review'],
    description:
      'A template’s author may not review their own change (`SELF_REVIEW_FORBIDDEN`). The one exception: a platform administrator may review a generated version they created, because a single-admin deployment could otherwise never promote one.',
    name: 'notAuthor',
  },
  {
    accompanies: ['team.approvals.answer'],
    description: 'A step assigned to named approvers is answered by one of them.',
    name: 'isAssignee',
  },
];
