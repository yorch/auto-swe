import {
  type EffectivePermissions,
  effectivePermissions,
  type PermissionsDb,
  userActor,
} from '@auto-swe/shared/permissions';
import type { JwtPayload } from '../plugins/auth.js';

/** What `GET /api/v1/me/permissions` answers: the permissions, or a refusal with no detail. */
export type EffectivePermissionsAnswer =
  | { ok: true; body: EffectivePermissions }
  | { ok: false; status: 403 | 404; error: { code: string; message: string } };

/**
 * The caller's effective permissions, optionally narrowed to one team.
 *
 * A team the caller has no standing on answers `403 FORBIDDEN` whether it exists or not, as a
 * team-role gate does, so the endpoint cannot be used to probe for teams. Only a platform
 * administrator, who passes every team, is told a team does not exist (`404 TEAM_NOT_FOUND`).
 */
export async function loadEffectivePermissions(
  prisma: PermissionsDb,
  user: JwtPayload,
  teamId?: string
): Promise<EffectivePermissionsAnswer> {
  const actor = userActor(user);
  if (actor.kind !== 'user') {
    throw new Error('effective permissions are read for a person');
  }
  const result = await effectivePermissions(prisma, actor, teamId ? { teamId } : {});
  if (result.ok) {
    return { body: result.value, ok: true };
  }
  if (result.reason === 'NOT_FOUND') {
    return { error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' }, ok: false, status: 404 };
  }
  return {
    error: { code: 'FORBIDDEN', message: 'You have no standing in this team' },
    ok: false,
    status: 403,
  };
}
