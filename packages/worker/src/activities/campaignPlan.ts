/**
 * Planning a `PLANNED` campaign (docs/specs/2026-11-25-campaigns-as-tracked-goals.md §6): the
 * `planner` agent decomposes the campaign's brief into one brief per repository and the order the
 * repositories must be worked in, exactly as `planEpic` does for an epic. The result is written to
 * the targets (`brief`, `dependsOn`) and the campaign waits in `PLANNING` for its launcher to look
 * at it and confirm; nothing starts before that.
 *
 * The planner's order is an inference from prose, so an edge survives only where the repository
 * dependency graph holds an `active` edge between the same two repositories (a proposal or a
 * dismissed edge never counts), and an edge that would close a cycle is dropped. A graph that cannot
 * be read leaves no edges: targets then start in `position` order, each as soon as the limits allow.
 */
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { EpicRepoEntry, RepoInfo } from '@auto-swe/shared/types/workflow';
import { CAMPAIGN_DESCRIPTION_MAX_LENGTH } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { decomposeEpic } from '../agents/plannerAgent.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { assertCurrentWorkflowOwnsCampaign } from '../lib/campaignIdentity.js';
import type { PlanCampaignBriefsResult } from '../lib/campaignReconcilerTypes.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { joinSkillPrompts } from '../lib/config/skillPrompt.js';
import { ownerOfTeam, withSpendOwner } from '../lib/spendOwner.js';
import { loadStoredUpstream, mergeStoredDependencies } from './planEpic.js';

/**
 * Keep a planner's edge only when the dependency graph has the same edge, and break any cycle the
 * remaining edges form. `storedUpstream` maps a repository to the repositories it depends on
 * (`active` edges only). Pure; entries keep their input order.
 */
export function restrictToStoredEdges(
  planned: readonly EpicRepoEntry[],
  storedUpstream: ReadonlyMap<string, readonly string[]>
): EpicRepoEntry[] {
  const allowed = new Map<string, string[]>();
  for (const entry of planned) {
    const stored = new Set(storedUpstream.get(entry.repoId) ?? []);
    allowed.set(
      entry.repoId,
      entry.dependsOn.filter((dep) => stored.has(dep))
    );
  }
  return mergeStoredDependencies(
    planned.map((e) => ({ dependsOn: [], repoId: e.repoId })),
    allowed as Map<string, string[]>
  );
}

/** A planner's text as a brief: control characters out, bounded, never empty. */
export function cleanBrief(text: string, fallback: string): string {
  const cleaned = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
      ? ' '
      : ch;
  })
    .join('')
    .trim()
    .slice(0, CAMPAIGN_DESCRIPTION_MAX_LENGTH);
  return cleaned === '' ? fallback : cleaned;
}

export async function planCampaignBriefs(input: {
  campaignId: string;
}): Promise<PlanCampaignBriefsResult> {
  const { campaignId } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  const campaign = await prisma.campaign.findUnique({
    select: { description: true, orgId: true, ownerTeamId: true, plan: true, state: true },
    where: { id: campaignId },
  });
  if (campaign?.plan !== 'PLANNED' || campaign.state !== 'PLANNING') {
    return { edges: 0, planned: 0 };
  }
  const targets = await prisma.campaignTarget.findMany({
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { brief: true, connectionId: true, id: true, teamId: true },
    where: { campaign: { orgId: campaign.orgId }, campaignId },
  });
  const planable = targets.filter(
    (t): t is typeof t & { connectionId: string } => t.connectionId !== null
  );
  if (planable.length === 0) {
    throw ApplicationFailure.nonRetryable(
      'The campaign has no repository to plan against',
      'CAMPAIGN_PLAN_EMPTY'
    );
  }
  if (planable.every((t) => t.brief !== null)) {
    return { edges: 0, planned: planable.length };
  }
  return withSpendOwner(ownerOfTeam(campaign.ownerTeamId), () => planImpl(campaign, planable));
}

async function planImpl(
  campaign: { description: string; orgId: string },
  planable: Array<{ id: string; connectionId: string; teamId: string }>
): Promise<PlanCampaignBriefsResult> {
  heartbeat('fetching repo metadata');
  const repos = await runUnscoped(
    'ids come from the campaign targets; scoped by id, not by tenant',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: {
          description: true,
          id: true,
          language: true,
          repoName: true,
          team: { select: { orgId: true } },
        },
        where: { id: { in: planable.map((t) => t.connectionId) }, type: 'git_repo' },
      })
  );
  const repoInfos: RepoInfo[] = repos.map((r) => ({
    description: r.description ?? '',
    language: r.language ?? 'unknown',
    name: r.repoName ?? '',
    repoId: r.id,
  }));
  if (repoInfos.length === 0) {
    throw ApplicationFailure.nonRetryable(
      'None of the campaign repositories is an available git repository',
      'CAMPAIGN_PLAN_EMPTY'
    );
  }

  heartbeat('decomposing the campaign via the planner agent');
  const tracer = new AgentTracer();
  try {
    const ctx = await currentRequestContext();
    const skills = await loadAgentSkills('planner', ctx);
    const skillSuffix = joinSkillPrompts(skills);
    const planned = await decomposeEpic(
      campaign.description,
      repoInfos,
      tracer,
      skillSuffix || undefined
    );

    let storedUpstream = new Map<string, string[]>();
    try {
      storedUpstream = await loadStoredUpstream(repos);
    } catch {
      // The graph is unreadable: no ordering is claimed.
    }
    const entries = restrictToStoredEdges(
      planned.map((p) => ({ dependsOn: p.dependsOn, repoId: p.repoId })),
      storedUpstream
    );
    const targetByRepo = new Map(planable.map((t) => [t.connectionId, t]));
    const briefByRepo = new Map(planned.map((p) => [p.repoId, p.description]));
    const depsByRepo = new Map(entries.map((e) => [e.repoId, e.dependsOn]));

    let edges = 0;
    const writes = planable.map((t) => {
      const dependsOn = (depsByRepo.get(t.connectionId) ?? []).flatMap((repoId) => {
        const upstream = targetByRepo.get(repoId);
        return upstream ? [upstream.id] : [];
      });
      edges += dependsOn.length;
      return prisma.campaignTarget.updateMany({
        data: {
          brief: cleanBrief(briefByRepo.get(t.connectionId) ?? '', campaign.description),
          dependsOn,
        },
        where: { id: t.id, teamId: t.teamId },
      });
    });
    await prisma.$transaction(writes);
    tracer.addActivityEvent({
      name: 'campaign.plan',
      outputJson: { edges, repos: planable.length },
    });
    return { edges, planned: planable.length };
  } finally {
    await persistActivityTrace(tracer, 'planner').catch(() => false);
  }
}
