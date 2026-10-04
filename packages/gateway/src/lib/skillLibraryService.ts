import type { PrismaClient } from '@auto-swe/shared';
import {
  initialRevision,
  nextRevision,
  skillContentChanged,
} from '@auto-swe/shared/lib/skillRevision';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { WORKFLOW_RUN_FAILURE_STATUSES } from '@auto-swe/shared/types/api';

/**
 * Skill-library service: create/update flows (with the injection/exfiltration
 * content scan and the isVerified reset rule) and the skill-effectiveness
 * report. Audit-log writes and HTTP status decisions stay with the routes.
 */

export type SkillRow = NonNullable<Awaited<ReturnType<PrismaClient['skill']['findFirst']>>>;

/**
 * Which skills a tenant may see: platform-wide GLOBAL rows, plus rows owned by
 * its own team or org. Without this filter every caller could read every custom
 * skill's `promptText`, which is the one field a team is most likely to encode
 * internal process or domain knowledge into.
 */
export function skillVisibilityWhere(tenant: { teamId: string; orgId?: string | null }) {
  return {
    OR: [
      { scope: 'GLOBAL' as const },
      { scope: 'TEAM' as const, teamId: tenant.teamId },
      ...(tenant.orgId ? [{ orgId: tenant.orgId, scope: 'ORGANIZATION' as const }] : []),
    ],
  };
}

/// Creates a non-built-in skill. Custom promptText is scanned for
/// injection/exfiltration patterns — non-blocking; warnings are returned for
/// the route to surface alongside the created row.
export async function createSkill(
  prisma: PrismaClient,
  input: {
    createdById?: string | null;
    description?: string;
    name: string;
    promptText: string;
    scope?: 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
    teamId?: string | null;
    orgId?: string | null;
  }
): Promise<{ scanWarnings: string[]; skill: SkillRow }> {
  const scanResult = await scanSkillContent(input.promptText);
  // Default GLOBAL preserves the admin-curated library; a caller that supplies
  // a tenant gets a scoped row. The DB CHECK rejects a mismatched combination.
  const skill = await prisma.skill.create({
    data: {
      description: input.description,
      ...initialRevision(
        { description: input.description ?? null, promptText: input.promptText },
        { createdById: input.createdById, scanWarnings: scanResult.warnings }
      ),
      isBuiltIn: false,
      isVerified: false,
      name: input.name,
      orgId: input.scope === 'ORGANIZATION' ? input.orgId : null,
      promptText: input.promptText,
      scope: input.scope ?? 'GLOBAL',
      teamId: input.scope === 'TEAM' ? input.teamId : null,
    },
  });
  return { scanWarnings: scanResult.warnings, skill };
}

/// Updates a skill.
/// Built-in skills: only name, description, and isActive may be updated.
/// promptText is locked for built-ins to preserve the verified content guarantee.
/// Custom skills: scan promptText for injection/exfiltration patterns (non-blocking).
/// Reset isVerified only when promptText changes — name/description edits don't
/// invalidate the content trust signal.
/// A change to promptText or description cuts a new immutable SkillRevision (and
/// bumps currentRevision) in the same statement; name/isActive edits do not.
/// Throws when a concurrent edit already took the next revision number — see
/// `isRevisionConflict`.
export async function updateSkill(
  prisma: PrismaClient,
  existing: SkillRow,
  body: { description?: string; isActive?: boolean; name?: string; promptText?: string },
  actorId?: string | null
): Promise<{ scanWarnings: string[]; updated: SkillRow }> {
  const { name, description, promptText, isActive } = body;

  const base = existing.isBuiltIn
    ? { isActive, name }
    : {
        isActive,
        name,
        ...(promptText !== undefined ? { isVerified: false } : {}),
      };

  const scanResult =
    !existing.isBuiltIn && promptText
      ? await scanSkillContent(promptText)
      : { safe: true, warnings: [] };

  const nextContent = {
    description: description ?? existing.description,
    promptText: existing.isBuiltIn ? existing.promptText : (promptText ?? existing.promptText),
  };
  let updated: SkillRow;
  if (skillContentChanged(existing, nextContent)) {
    const next = nextRevision(existing, nextContent, {
      createdById: actorId,
      scanWarnings: scanResult.warnings,
    });
    updated = await prisma.skill.update({ data: { ...base, ...next.data }, where: next.where });
  } else {
    updated = await prisma.skill.update({ data: base, where: { id: existing.id } });
  }
  return { scanWarnings: scanResult.warnings, updated };
}

/// Marks the skill's CURRENT content as human-verified. Verification is a
/// property of the text a reviewer read, so it is only ever set here — never by
/// a create, a bundle install or a sync of custom content — and every content
/// edit clears it again (see `updateSkill`). Guarded on `currentRevision` so a
/// concurrent edit between the read and this write cannot be verified unseen
/// (Prisma raises P2025; see `isRevisionConflict`).
export async function verifySkill(prisma: PrismaClient, existing: SkillRow): Promise<SkillRow> {
  return prisma.skill.update({
    data: { isVerified: true },
    where: { currentRevision: existing.currentRevision, id: existing.id },
  });
}

/// Correlational report: run outcomes for runs where each skill was active
/// (from the implementer's skills.loaded trace events) vs the all-runs
/// baseline. EVOL-8: skillsActive was recorded everywhere but analyzed nowhere.
export async function getSkillEffectivenessReport(prisma: PrismaClient, windowDays: number) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const events = await runUnscoped(
    'admin skill-effectiveness report spans every tenant',
    ['AgentTrace'],
    () =>
      prisma.agentTrace.findMany({
        select: { outputJson: true, runId: true },
        where: {
          createdAt: { gte: since },
          toolName: 'skills.loaded',
          type: 'activity_event',
        },
      })
  );

  // Union of skills per run (retries emit the event once per attempt).
  const skillsByRun = new Map<string, Set<string>>();
  for (const ev of events) {
    const names = (ev.outputJson as { skills?: unknown } | null)?.skills;
    // Runless traces (evals, authoring) have no outcome to correlate against.
    if (!ev.runId || !Array.isArray(names)) {
      continue;
    }
    const set = skillsByRun.get(ev.runId) ?? new Set<string>();
    for (const n of names) {
      if (typeof n === 'string') {
        set.add(n);
      }
    }
    skillsByRun.set(ev.runId, set);
  }

  const runs = await prisma.workflowRun.findMany({
    select: { costUsdAccrued: true, id: true, status: true },
    where: {
      startedAt: { gte: since },
      // Finished runs that either succeeded or failed — SKIPPED is terminal but
      // neither, so it would dilute the success rate without saying anything.
      status: { in: ['SUCCESS', ...WORKFLOW_RUN_FAILURE_STATUSES] },
    },
  });

  const baseline = {
    succeeded: runs.filter((r) => r.status === 'SUCCESS').length,
    totalRuns: runs.length,
  };

  const perSkill = new Map<string, { runs: number; succeeded: number; totalCostUsd: number }>();
  for (const run of runs) {
    const skills = skillsByRun.get(run.id);
    if (!skills) {
      continue;
    }
    for (const name of skills) {
      const agg = perSkill.get(name) ?? { runs: 0, succeeded: 0, totalCostUsd: 0 };
      agg.runs += 1;
      agg.succeeded += run.status === 'SUCCESS' ? 1 : 0;
      agg.totalCostUsd += run.costUsdAccrued;
      perSkill.set(name, agg);
    }
  }

  return {
    baselineSuccessRate: baseline.totalRuns > 0 ? baseline.succeeded / baseline.totalRuns : null,
    // Correlation, not causation: skills are assigned per scope, so
    // skill presence correlates with team/template effects too.
    caveat: 'correlational',
    perSkill: [...perSkill.entries()]
      .map(([name, agg]) => ({
        avgCostUsd: agg.runs > 0 ? agg.totalCostUsd / agg.runs : null,
        name,
        runs: agg.runs,
        successRate: agg.runs > 0 ? agg.succeeded / agg.runs : null,
      }))
      .sort((a, b) => b.runs - a.runs),
    totalRuns: baseline.totalRuns,
    windowDays,
  };
}
