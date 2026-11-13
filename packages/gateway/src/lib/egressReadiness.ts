import type { PrismaClient } from '@auto-swe/shared';
import { getSettingDefinition } from '@auto-swe/shared/config';
import {
  EGRESS_REPORT_MAX_AGE_MS,
  egressEnforcementWarnings,
  summarizeEgressCapabilities,
} from '@auto-swe/shared/lib/egressPolicy';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { resolveScopeTenant, type ScopeSelector } from './configSettingsService.js';

export async function loadEgressReadiness(
  prisma: PrismaClient,
  proposed?: { policy: unknown; selector: ScopeSelector },
  changedTeam?: { id: string; allowlist: string[] }
) {
  const now = new Date();
  const summary = summarizeEgressCapabilities(
    await prisma.workerEgressCapability.findMany({
      where: { reportedAt: { gte: new Date(now.getTime() - EGRESS_REPORT_MAX_AGE_MS) } },
    }),
    now
  );
  if (summary.reports.length === 0) {
    return { ...summary, ok: true, warnings: [] as string[] };
  }
  const [rows, teams] = await runUnscoped(
    'egress readiness evaluates deployment-wide settings and workers',
    ['ConfigSetting', 'Team'],
    () =>
      Promise.all([
        prisma.configSetting.findMany({
          where: { key: { in: ['workspace.egressPolicy', 'workspace.egressBaselineAllowlist'] } },
        }),
        prisma.team.findMany({ select: { egressAllowlist: true, id: true, orgId: true } }),
      ])
  );
  const policyDefinition = getSettingDefinition('workspace.egressPolicy');
  const globalPolicy = policyDefinition.schema.safeParse(
    rows.find((row) => row.key === 'workspace.egressPolicy' && row.scope === 'GLOBAL')?.value
  );
  const settings: { policy: unknown; selector: ScopeSelector }[] = proposed
    ? [proposed]
    : [
        {
          policy: globalPolicy.success ? globalPolicy.data : policyDefinition.defaultValue,
          selector: { scope: 'GLOBAL' },
        },
        ...rows
          .filter((row) => row.key === 'workspace.egressPolicy' && row.scope !== 'GLOBAL')
          .map((row) => ({
            policy: row.value,
            selector: {
              channelId: row.channelId ?? undefined,
              orgId: row.orgId ?? undefined,
              scope: row.scope,
              teamId: row.teamId ?? undefined,
              workflowTemplateId: row.workflowTemplateId ?? undefined,
            },
          })),
      ];
  const warnings: string[] = [];
  for (const { policy, selector } of settings) {
    if (policy === 'open') {
      continue;
    }
    const tenant = await resolveScopeTenant(prisma, selector);
    const involved = teams.filter(
      (t) =>
        (!tenant.teamId || tenant.teamId === t.id) &&
        (!tenant.orgId || tenant.orgId === t.orgId) &&
        (!changedTeam || changedTeam.id === t.id)
    );
    if (changedTeam && !involved.some((team) => team.id === changedTeam.id)) {
      continue;
    }
    const baselineFor = (orgId?: string | null): string[] => {
      const definition = getSettingDefinition('workspace.egressBaselineAllowlist');
      for (const scope of ['ORGANIZATION', 'GLOBAL']) {
        const row = rows.find(
          (row) =>
            row.key === 'workspace.egressBaselineAllowlist' &&
            row.scope === scope &&
            (scope === 'GLOBAL' || (orgId && row.orgId === orgId))
        );
        const parsed = definition.schema.safeParse(row?.value);
        if (parsed.success) {
          return parsed.data;
        }
      }
      return definition.defaultValue;
    };
    const hasTeamAllowlist = changedTeam
      ? changedTeam.allowlist.length > 0
      : involved.some((t) => t.egressAllowlist.length > 0);
    const hasAllowlist =
      hasTeamAllowlist ||
      (involved.length
        ? involved.some((team) => baselineFor(team.orgId).length > 0)
        : baselineFor(tenant.orgId).length > 0);
    warnings.push(
      ...egressEnforcementWarnings(summary, policy, hasAllowlist).map(
        (message) => `${selector.scope}: ${message}`
      )
    );
  }
  const levels = Object.entries(summary.enforceable)
    .filter(([, ok]) => ok)
    .map(([level]) => level)
    .join(', ');
  return {
    ...summary,
    detail: `Enforceable: ${levels}. ${summary.detail || 'All fresh workers verified network locks and have an egress proxy.'}`,
    ok: warnings.length === 0,
    warnings: [...new Set(warnings)],
  };
}
