import type { PrismaClient } from '@auto-swe/shared';
import {
  type ConfigActor,
  type ConfigGrant,
  checkSettingWrite,
  getSettingDefinition,
  invalidateSettingsCache,
  isSettingKey,
  type ResolvedSetting,
  resolveEffectiveSettings,
  SETTING_DEFINITIONS,
  type SettingKey,
  type SettingResolveCtx,
  type SettingScope,
  type WriteDenial,
} from '@auto-swe/shared/config';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

// NOTE ON CACHE SCOPE: `invalidateSettingsCache()` below clears only THIS
// process's cache. The worker is a separate process and keeps serving its own
// cached value until its ~30 s TTL expires — the same eventual consistency the
// scanner-pattern cache has. An admin's save is therefore immediate in the
// dashboard and near-immediate in the worker, but not atomic across both.

/**
 * Service for the definition-driven config registry.
 *
 * Reads and writes go through the setting definitions rather than a per-key
 * route: the definition supplies the schema that validates a write, the scopes
 * a write is allowed at, and the role floor. Adding a knob is a definition, not
 * a change here.
 */

/// One scope instance a setting can be written at. Exactly one id is set for
/// any scope other than GLOBAL — the same shape the DB CHECK constraint enforces.
export interface ScopeSelector {
  scope: SettingScope;
  teamId?: string;
  orgId?: string;
  channelId?: string;
  workflowTemplateId?: string;
}

/// The tenant a scope selector lands in. A CHANNEL or WORKFLOW_TEMPLATE write
/// belongs to the team that owns it, which is what a TEAM-scoped grant has to
/// be checked against — so the owning ids are looked up rather than assumed.
export interface ScopeTenant {
  teamId?: string;
  orgId?: string;
}

/// Maps a selector onto the columns of the row it addresses. Returns null when
/// the selector names no id for a non-GLOBAL scope, which the API rejects.
export function scopeColumns(selector: ScopeSelector): Record<string, string | null> | null {
  const base = {
    channelId: null,
    orgId: null,
    teamId: null,
    workflowTemplateId: null,
  } as Record<string, string | null>;
  switch (selector.scope) {
    case 'GLOBAL':
      return base;
    case 'ORGANIZATION':
      return selector.orgId ? { ...base, orgId: selector.orgId } : null;
    case 'TEAM':
      return selector.teamId ? { ...base, teamId: selector.teamId } : null;
    case 'CHANNEL':
      return selector.channelId ? { ...base, channelId: selector.channelId } : null;
    case 'WORKFLOW_TEMPLATE':
      return selector.workflowTemplateId
        ? { ...base, workflowTemplateId: selector.workflowTemplateId }
        : null;
    default:
      return null;
  }
}

/// Resolves which team and org a write actually lands in, so a TEAM- or
/// ORG-scoped grant can be checked against the real owner rather than against
/// whatever the request happened to name.
export async function resolveScopeTenant(
  prisma: PrismaClient,
  selector: ScopeSelector
): Promise<ScopeTenant> {
  switch (selector.scope) {
    case 'GLOBAL':
      return {};
    case 'ORGANIZATION':
      return { orgId: selector.orgId };
    case 'TEAM': {
      const team = await prisma.team.findUnique({
        select: { orgId: true },
        where: { id: selector.teamId },
      });
      return { orgId: team?.orgId, teamId: selector.teamId };
    }
    case 'CHANNEL': {
      const channel = await prisma.slackChannel.findUnique({
        select: { orgId: true, teamId: true },
        where: { id: selector.channelId },
      });
      return { orgId: channel?.orgId, teamId: channel?.teamId };
    }
    case 'WORKFLOW_TEMPLATE': {
      const template = await prisma.workflowTemplate.findUnique({
        select: { team: { select: { orgId: true } }, teamId: true },
        where: { id: selector.workflowTemplateId },
      });
      return { orgId: template?.team?.orgId, teamId: template?.teamId ?? undefined };
    }
    default:
      return {};
  }
}

/// Every grant that could apply to this actor: their own user grants plus the
/// role grants for the role they hold. Filtering by key and scope happens in
/// `checkSettingWrite`, which owns the matching rule.
export async function loadGrantsForActor(
  prisma: PrismaClient,
  actor: ConfigActor
): Promise<ConfigGrant[]> {
  // Cross-tenant on purpose: an actor's grants may span several teams and orgs,
  // and the query is already pinned to that one actor.
  const rows = await runUnscoped(
    "a user's own grants span every tenant they hold authority in; the query is pinned to one actor",
    ['ConfigPermission'],
    () =>
      prisma.configPermission.findMany({
        select: {
          keyPattern: true,
          orgId: true,
          role: true,
          scope: true,
          teamId: true,
          userId: true,
        },
        where: { OR: [{ userId: actor.id }, { role: actor.role }] },
      })
  );
  return rows as ConfigGrant[];
}

/// Membership check for a scoped READ. Writes are authorised by grants, but a
/// read has no grant to check — and the effective-config view exposes another
/// tenant's resolved values, including which images their workspaces run and
/// how their channel assistant is tuned. Platform ADMINs see everything;
/// everyone else needs a membership on the team or org the scope belongs to.
export async function canReadScope(
  prisma: PrismaClient,
  actor: ConfigActor,
  selector: ScopeSelector
): Promise<boolean> {
  if (actor.role === 'ADMIN') {
    return true;
  }
  // GLOBAL values are the deployment-wide defaults every tenant already runs
  // under, so any authenticated user may read them.
  if (selector.scope === 'GLOBAL') {
    return true;
  }

  const tenant = await resolveScopeTenant(prisma, selector);
  // A selector that names an id nothing owns resolves to no tenant. Refuse
  // rather than fall through to a GLOBAL-only read that would look like success.
  if (!tenant.teamId && !tenant.orgId) {
    return false;
  }
  if (tenant.teamId) {
    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { teamId: tenant.teamId, userId: actor.id } },
    });
    if (membership) {
      return true;
    }
  }
  if (tenant.orgId) {
    const membership = await prisma.organizationMembership.findUnique({
      where: { userId_orgId: { orgId: tenant.orgId, userId: actor.id } },
    });
    if (membership) {
      return true;
    }
  }
  return false;
}

/// The admin form's payload: every definition plus the value currently in
/// effect for the requested scope and where it came from.
export interface SettingView extends ResolvedSetting {
  /// Whether THIS actor may write THIS key at the requested scope, decided by
  /// the same `checkSettingWrite` the write path uses — grants included.
  canWrite: boolean;
  group: string;
  label: string;
  description: string;
  defaultValue: unknown;
  overridableAt: readonly string[];
  requiredRole: string;
  restartRequired: boolean;
  runPinned: boolean;
  unit?: string;
  /// The override stored at exactly the requested scope, if any. Distinct from
  /// `value`, which is what the cascade resolves to — an operator needs to see
  /// both to understand why a change at their scope did or did not take effect.
  overrideAtScope?: unknown;
}

export async function listSettings(
  prisma: PrismaClient,
  actor: ConfigActor,
  ctx: SettingResolveCtx,
  selector: ScopeSelector
): Promise<SettingView[]> {
  // One query: `resolveEffectiveSettings` already loaded every override visible
  // from this context, including the row at the exact scope being asked about.
  const { overrideAt, settings } = await resolveEffectiveSettings(ctx);
  const grants = actor.role === 'ADMIN' ? [] : await loadGrantsForActor(prisma, actor);
  const tenant = await resolveScopeTenant(prisma, selector);

  return settings.map((resolved) => {
    const definition = getSettingDefinition(resolved.key as SettingKey);
    return {
      ...resolved,
      // Computed server-side because only the server knows the grants. A client
      // that re-derives this from the role alone can only see the floor, so a
      // lead holding a grant would be shown a disabled control for a key they
      // are entitled to change — the grant model is the point of the feature.
      canWrite: checkSettingWrite(
        actor,
        {
          key: resolved.key,
          scope: selector.scope,
          targetOrgId: tenant.orgId,
          targetTeamId: tenant.teamId,
        },
        grants
      ).allowed,
      defaultValue: definition.defaultValue,
      description: definition.description,
      group: definition.group,
      label: definition.label,
      overridableAt: definition.overridableAt,
      overrideAtScope: overrideAt(resolved.key, selector.scope),
      requiredRole: definition.requiredRole,
      restartRequired: definition.restartRequired,
      runPinned: definition.runPinned,
      unit: definition.unit,
    };
  });
}

/// Resolves a write to the row it addresses: the scope columns plus whatever is
/// already stored there. Both writers need exactly this, and both need the same
/// refusal when a scoped selector names no id — keeping one copy stops the two
/// from drifting.
///
/// findFirst-then-create rather than upsert: the uniqueness is a *partial* index
/// per scope, which Prisma cannot express in an upsert's where clause — the same
/// constraint Agent and ProviderCredential live with.
async function resolveWriteTarget(
  prisma: PrismaClient,
  key: string,
  selector: ScopeSelector
): Promise<
  | { columns: Record<string, string | null>; existing: { id: string; value: unknown } | null }
  | { denial: WriteDenial & { allowed: false } }
> {
  const columns = scopeColumns(selector);
  if (!columns) {
    return {
      denial: {
        allowed: false,
        code: 'SCOPE_NOT_ALLOWED',
        message: `A ${selector.scope} override needs the matching id.`,
      },
    };
  }
  const existing = await prisma.configSetting.findFirst({
    where: { key, scope: selector.scope, ...columns },
  });
  return { columns, existing };
}

export interface SettingWriteResult {
  denial?: WriteDenial & { allowed: false };
  before?: unknown;
  after?: unknown;
}

/// Writes one override. Validates the value against the definition's own schema
/// — the API has no separate body schema to drift from it — after authorising
/// the write.
export async function setSetting(
  prisma: PrismaClient,
  actor: ConfigActor,
  key: string,
  selector: ScopeSelector,
  value: unknown
): Promise<SettingWriteResult | { validationError: string }> {
  const denial = await authorize(prisma, actor, key, selector);
  if (denial) {
    return { denial };
  }

  const definition = getSettingDefinition(key as SettingKey);
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return { validationError: parsed.error.issues.map((i) => i.message).join('; ') };
  }

  const target = await resolveWriteTarget(prisma, key, selector);
  if ('denial' in target) {
    return target;
  }
  const { columns, existing } = target;

  if (existing) {
    await prisma.configSetting.update({
      data: { updatedById: actor.id, value: parsed.data as never },
      where: { id: existing.id },
    });
  } else {
    await prisma.configSetting.create({
      data: {
        key,
        scope: selector.scope,
        updatedById: actor.id,
        value: parsed.data as never,
        ...columns,
      },
    });
  }

  invalidateSettingsCache();
  return { after: parsed.data, before: existing?.value };
}

/// Removes an override so the key falls back to the next scope down. Returns
/// `before: undefined` when there was nothing stored, which the route reports
/// as a no-op rather than an error.
export async function clearSetting(
  prisma: PrismaClient,
  actor: ConfigActor,
  key: string,
  selector: ScopeSelector
): Promise<SettingWriteResult> {
  const denial = await authorize(prisma, actor, key, selector);
  if (denial) {
    return { denial };
  }
  const target = await resolveWriteTarget(prisma, key, selector);
  if ('denial' in target) {
    return target;
  }
  if (target.existing) {
    await prisma.configSetting.delete({ where: { id: target.existing.id } });
    invalidateSettingsCache();
  }
  return { before: target.existing?.value };
}

async function authorize(
  prisma: PrismaClient,
  actor: ConfigActor,
  key: string,
  selector: ScopeSelector
): Promise<(WriteDenial & { allowed: false }) | null> {
  if (!isSettingKey(key)) {
    return {
      allowed: false,
      code: 'UNKNOWN_SETTING',
      message: `'${key}' is not a known setting.`,
    };
  }
  const tenant = await resolveScopeTenant(prisma, selector);
  const grants = actor.role === 'ADMIN' ? [] : await loadGrantsForActor(prisma, actor);
  const verdict = checkSettingWrite(
    actor,
    { key, scope: selector.scope, targetOrgId: tenant.orgId, targetTeamId: tenant.teamId },
    grants
  );
  return verdict.allowed ? null : verdict;
}

export { SETTING_DEFINITIONS };
