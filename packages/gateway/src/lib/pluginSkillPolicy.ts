import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyReply } from 'fastify';
import { sendError } from './httpErrors.js';

/**
 * Rules for skills projected from a plugin (`Skill.pluginProfileId` set). They follow the plugin:
 * their text arrives only by accepting a new plugin version, they stay unverified, they go inactive
 * while the plugin is DISABLED, and a TEAM agent may attach one only when the team enabled the
 * plugin. Platform-wide, organization, channel and template agents are written by a platform ADMIN
 * and need no enablement, but nothing attaches a skill of a disabled plugin.
 */

export const SKILL_PLUGIN_MANAGED_MESSAGE =
  'This skill is projected from a plugin and is managed by it. Its text, name and state change only by accepting a new plugin version (or disabling the plugin).';

/** 409 for any mutation of a projected skill. */
export function skillPluginManaged(reply: FastifyReply): FastifyReply {
  return sendError(reply, 409, 'SKILL_PLUGIN_MANAGED', SKILL_PLUGIN_MANAGED_MESSAGE);
}

/** Make the projected skills of a profile inactive (disable) or active again (re-enable). */
export async function setProjectedSkillsActive(
  tx: Prisma.TransactionClient,
  profile: { id: string; latestVersion: number },
  active: boolean
): Promise<number> {
  // Nothing can deactivate a projected skill by hand (every skill write refuses it), so every
  // inactive row of the profile at its latest version was deactivated by a disable. A row left
  // at an older version is not part of the current projection and stays off.
  const { count } = await runUnscoped(
    'a plugin status change toggles the skills projected from it',
    ['Skill'],
    () =>
      tx.skill.updateMany({
        data: { isActive: active },
        where: active
          ? { isActive: false, pluginProfileId: profile.id, pluginVersion: profile.latestVersion }
          : { isActive: true, pluginProfileId: profile.id },
      })
  );
  return count;
}

export interface SkillAttachError {
  code: 'SKILL_PLUGIN_NOT_ENABLED' | 'SKILL_PLUGIN_DISABLED';
  message: string;
}

export interface SkillAttachContext {
  scope?: string;
  teamId?: string | null;
  /** The agent version being edited; skills it already carries are not re-checked. */
  currentAgentId?: string;
}

/**
 * Why these skill refs may not be saved on an agent version, or `null`. Only skills being ADDED are
 * checked: removal is always allowed and a carried skill must not lock the rest of the agent.
 */
export async function skillAttachError(
  prisma: Pick<PrismaClient, 'agentSkillRef' | 'pluginEnablement' | 'skill'>,
  refs: ReadonlyArray<{ skillId: string }> | null | undefined,
  ctx: SkillAttachContext = {}
): Promise<SkillAttachError | null> {
  if (!refs || refs.length === 0) {
    return null;
  }
  let ids = refs.map((r) => r.skillId);
  if (ctx.currentAgentId) {
    const carried = new Set(
      (
        await prisma.agentSkillRef.findMany({
          select: { skillId: true },
          where: { agentId: ctx.currentAgentId },
        })
      ).map((r) => r.skillId)
    );
    ids = ids.filter((id) => !carried.has(id));
  }
  if (ids.length === 0) {
    return null;
  }
  const projected = await runUnscoped(
    'admin checks whether skills being attached are plugin projections',
    ['Skill'],
    () =>
      prisma.skill.findMany({
        select: { name: true, pluginProfile: { select: { id: true, name: true, status: true } } },
        where: { id: { in: ids }, pluginProfileId: { not: null } },
      })
  );
  const named = (rows: { name: string }[]) => rows.map((r) => `'${r.name}'`).join(', ');
  const disabled = projected.filter((p) => p.pluginProfile && p.pluginProfile.status !== 'OK');
  if (disabled.length > 0) {
    return {
      code: 'SKILL_PLUGIN_DISABLED',
      message: `Skills of a disabled plugin cannot be attached: ${named(disabled)}.`,
    };
  }
  if (ctx.scope === 'TEAM' && ctx.teamId && projected.length > 0) {
    const profileIds = [
      ...new Set(projected.flatMap((p) => (p.pluginProfile ? [p.pluginProfile.id] : []))),
    ];
    const enabled = new Set(
      (
        await runUnscoped('admin checks which plugins a team enabled', ['PluginEnablement'], () =>
          prisma.pluginEnablement.findMany({
            select: { profileId: true },
            where: { profileId: { in: profileIds }, teamId: ctx.teamId as string },
          })
        )
      ).map((e) => e.profileId)
    );
    const missing = projected.filter((p) => p.pluginProfile && !enabled.has(p.pluginProfile.id));
    if (missing.length > 0) {
      return {
        code: 'SKILL_PLUGIN_NOT_ENABLED',
        message: `Not enabled for this team: ${named(missing)}. A team admin enables the plugin before its skills can be attached.`,
      };
    }
  }
  return null;
}
