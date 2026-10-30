import { type Prisma, Role } from '@auto-swe/shared';
import { resolveSetting, resolveSettings } from '@auto-swe/shared/config';
import { autoArmingRefusals, type BranchRulesLike } from '@auto-swe/shared/lib/prEvaluation';
import {
  autoEvidenceAssessment,
  prEvaluationEvidence,
} from '@auto-swe/shared/lib/prEvaluationEvidence';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { paginationQuery } from '../lib/pagination.js';
import { REPOSITORY_SWEEP_CAP, sweepArmedPullRequests } from '../lib/prEvaluationSweep.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { canManageTeamRepos } from './repositories.js';

const RepoParams = z.object({ id: z.string().uuid() });
const EvaluationParams = z.object({ id: z.string().uuid() });

const MODES = ['off', 'advisory', 'enforce', 'auto'] as const;
const RISK_CLASSES = ['LOW', 'STANDARD', 'HIGH'] as const;

const SetModeBody = z.object({ mode: z.enum(MODES).nullable() });

const ListQuery = paginationQuery({ defaultLimit: 50, maxLimit: 100 }).extend({
  /** Only evaluations whose pull request merged; omitted or `false` applies no merge filter. */
  merged: booleanQueryParam(false),
  repoId: z.string().uuid().optional(),
  riskClass: z.enum(RISK_CLASSES).optional(),
});

const THRESHOLD_KEYS = [
  'prEvaluation.maxLowLines',
  'prEvaluation.maxLowFiles',
  'prEvaluation.maxLowDirs',
  'prEvaluation.highLines',
  'prEvaluation.lowApprovers',
  'prEvaluation.standardApprovers',
  'prEvaluation.highApprovers',
  'prEvaluation.sensitivePaths',
] as const;

const POLICY_KEYS = [
  'prEvaluation.enabled',
  'prEvaluation.defaultMode',
  'prEvaluation.autoMergeAllowed',
  'prEvaluation.autoMinEvidence',
  'prEvaluation.autoMinRepoEvidence',
  'prEvaluation.autoMinDistinctRequesters',
  'prEvaluation.autoEvidenceMinChangedLines',
  'prEvaluation.requiredStatusContext',
  ...THRESHOLD_KEYS,
] as const;

const SUMMARY_SELECT = {
  autoMergeEnabled: true,
  badMerge: true,
  badMergeReason: true,
  baseBranch: true,
  closedAt: true,
  connection: { select: { organizationName: true, repoName: true } },
  connectionId: true,
  createdAt: true,
  headSha: true,
  id: true,
  mergedAt: true,
  mode: true,
  prNumber: true,
  reasons: true,
  requiredApprovers: true,
  riskClass: true,
  statusState: true,
  triggeredBy: true,
} as const satisfies Prisma.PrEvaluationSelect;

/** The length of a stored brief's markdown, 0 for a brief of any other shape. */
function briefMarkdownLength(brief: unknown): number {
  if (brief && typeof brief === 'object' && 'markdown' in brief) {
    const markdown = (brief as { markdown: unknown }).markdown;
    return typeof markdown === 'string' ? markdown.length : 0;
  }
  return 0;
}

export const prEvaluationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /** A repository's team scope for the settings it is evaluated under. */
  async function settingsFor(
    repo: { teamId: string; team: { orgId: string | null } | null },
    keys: readonly (typeof POLICY_KEYS)[number][]
  ) {
    return resolveSettings(keys, {
      ...(repo.team?.orgId ? { orgId: repo.team.orgId } : {}),
      teamId: repo.teamId,
    });
  }

  // GET /api/v1/repositories/:id/pr-evaluation
  app.get(
    '/repositories/:id/pr-evaluation',
    {
      onRequest: requireAuth({ requiredRole: Role.ENGINEER }),
      schema: { params: RepoParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      // A repository the caller cannot reach is not found, whether or not it exists.
      const repo = await fastify.prisma.connection.findFirst({
        select: {
          id: true,
          prEvaluationMode: true,
          team: { select: { orgId: true } },
          teamId: true,
        },
        where: {
          id: request.params.id,
          type: 'git_repo',
          ...(user.role === Role.ADMIN ? {} : reachableConnections(user, request.repoAccessGate)),
        },
      });
      if (!repo) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const settings = await settingsFor(repo, POLICY_KEYS);
      const [last, evidence] = await Promise.all([
        fastify.prisma.prEvaluation.findFirst({
          orderBy: { createdAt: 'desc' },
          select: {
            autoMergeEnabled: true,
            createdAt: true,
            headSha: true,
            id: true,
            prNumber: true,
            readiness: true,
            reasons: true,
            requiredApprovers: true,
            riskClass: true,
            statusState: true,
          },
          where: { connectionId: repo.id },
        }),
        prEvaluationEvidence(
          fastify.prisma,
          repo.id,
          new Date(),
          settings['prEvaluation.autoEvidenceMinChangedLines']
        ),
      ]);
      const defaultMode = settings['prEvaluation.defaultMode'];
      const thresholds = {
        minDistinctRequesters: settings['prEvaluation.autoMinDistinctRequesters'],
        minEvidence: settings['prEvaluation.autoMinEvidence'],
        minRepoEvidence: settings['prEvaluation.autoMinRepoEvidence'],
      };
      const assessment = autoEvidenceAssessment(evidence, thresholds);
      return {
        data: {
          autoMergeAllowed: settings['prEvaluation.autoMergeAllowed'],
          enabled: settings['prEvaluation.enabled'],
          // Counts and thresholds only: nothing here names a requester.
          evidence: {
            deployment: {
              ...evidence.deployment,
              minDistinctRequesters: thresholds.minDistinctRequesters,
              minEvidence: thresholds.minEvidence,
            },
            minChangedLines: settings['prEvaluation.autoEvidenceMinChangedLines'],
            repository: { ...evidence.repository, minRepoEvidence: thresholds.minRepoEvidence },
            satisfied: assessment.satisfied,
            unmet: assessment.unmet,
            windowDays: evidence.windowDays,
          },
          lastEvaluation: last,
          mode: repo.prEvaluationMode ?? defaultMode,
          modeSource: repo.prEvaluationMode === null ? 'default' : 'repository',
          requiredStatusContext: settings['prEvaluation.requiredStatusContext'],
          thresholds: Object.fromEntries(
            THRESHOLD_KEYS.map((key) => [key.slice('prEvaluation.'.length), settings[key]])
          ),
        },
      };
    }
  );

  // PUT /api/v1/repositories/:id/pr-evaluation — owning-team LEAD or platform ADMIN. `auto`
  // is the one mode that lets the platform act on its own judgement, so only a platform ADMIN
  // may choose it, and only while every precondition holds.
  app.put(
    '/repositories/:id/pr-evaluation',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { body: SetModeBody, params: RepoParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      // Reachability before management: a repository the caller cannot reach is not found, so a
      // non-member cannot tell a refused repository from one that does not exist.
      const repo = await fastify.prisma.connection.findFirst({
        select: {
          id: true,
          prEvaluationMode: true,
          team: { select: { orgId: true } },
          teamId: true,
        },
        where: {
          id: request.params.id,
          type: 'git_repo',
          ...(user.role === Role.ADMIN ? {} : reachableConnections(user, request.repoAccessGate)),
        },
      });
      if (!repo) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires LEAD role in this repository's team");
      }
      const { mode } = request.body;

      if (mode === 'auto') {
        const reasons = await autoRefusals(fastify, user.role, repo);
        if (reasons.length > 0) {
          return sendError(
            reply,
            400,
            'AUTO_NOT_READY',
            'Auto mode is not ready for this repository',
            { reasons }
          );
        }
      }

      await fastify.prisma.connection.update({
        data: { prEvaluationMode: mode },
        select: { id: true },
        where: { id: repo.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { prEvaluationMode: mode },
        before: { prEvaluationMode: repo.prEvaluationMode },
        entityId: repo.id,
        entityType: 'Connection',
      });
      // Anything but `auto` (`enforce` included) must not leave auto-merge armed on a pull
      // request an earlier `auto` armed: the worker's evaluation disarms what the policy no
      // longer wants.
      if (mode !== 'auto') {
        const swept = await sweepArmedPullRequests(fastify, request.log, {
          cap: REPOSITORY_SWEEP_CAP,
          connectionId: repo.id,
        });
        if (swept.found > 0) {
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor: user,
            after: { prEvaluationDisarmSweep: { pullRequests: swept.found } },
            entityId: repo.id,
            entityType: 'Connection',
          });
        }
      }
      const warnings = await enforceWarnings(fastify, repo, mode);
      return { data: { mode, modeSource: mode === null ? 'default' : 'repository', warnings } };
    }
  );

  // GET /api/v1/pr-evaluations — newest first, repositories the caller can reach only
  app.get(
    '/pr-evaluations',
    {
      onRequest: requireAuth({ requiredRole: Role.ENGINEER }),
      schema: { querystring: ListQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, merged, offset, repoId, riskClass } = request.query;
      const where: Prisma.PrEvaluationWhereInput = {
        ...(user.role === Role.ADMIN
          ? {}
          : { connection: reachableConnections(user, request.repoAccessGate) }),
        ...(repoId ? { connectionId: repoId } : {}),
        ...(riskClass ? { riskClass } : {}),
        ...(merged ? { mergedAt: { not: null } } : {}),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.prEvaluation.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { ...SUMMARY_SELECT, brief: true },
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.prEvaluation.count({ where }),
      ]);
      return {
        data: rows.map(({ brief, ...row }) => {
          const length = briefMarkdownLength(brief);
          return { ...row, briefAvailable: length > 0, briefMarkdownLength: length };
        }),
        meta: { limit, offset, total },
      };
    }
  );

  // GET /api/v1/pr-evaluations/:id — the full row, brief included
  app.get(
    '/pr-evaluations/:id',
    {
      onRequest: requireAuth({ requiredRole: Role.ENGINEER }),
      schema: { params: EvaluationParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await fastify.prisma.prEvaluation.findFirst({
        select: { ...SUMMARY_SELECT, brief: true, readiness: true },
        where: {
          id: request.params.id,
          ...(user.role === Role.ADMIN
            ? {}
            : { connection: reachableConnections(user, request.repoAccessGate) }),
        },
      });
      if (!row) {
        return sendError(reply, 404, 'PR_EVALUATION_NOT_FOUND', 'Evaluation not found');
      }
      return { data: row };
    }
  );
};

/** The readiness record as the rule reads it; anything that is not an object reads as unread. */
function branchRulesOf(
  readiness: unknown
): (BranchRulesLike & { statusPublished?: unknown }) | null {
  return readiness && typeof readiness === 'object' && !Array.isArray(readiness)
    ? (readiness as BranchRulesLike & { statusPublished?: unknown })
    : null;
}

/**
 * What an operator must know after a mode change, judged on the EFFECTIVE mode (`null` inherits
 * `prEvaluation.defaultMode` at the repository's scope), not the string written. Only an
 * effective `enforce` warns. Nothing is evaluated while `prEvaluation.enabled` is off; otherwise
 * `enforce` only holds once the status context is a required check on the base branch, pinned to
 * the platform's own GitHub App. Both are read from the repository's latest recorded readiness;
 * with none recorded it is not known, which is said rather than left silent. A missing or
 * unreadable field is as unknown as the string `'unknown'`.
 */
async function enforceWarnings(
  fastify: FastifyInstance,
  repo: { id: string; team: { orgId: string | null } | null; teamId: string },
  mode: (typeof MODES)[number] | null
): Promise<string[]> {
  const scope = {
    ...(repo.team?.orgId ? { orgId: repo.team.orgId } : {}),
    teamId: repo.teamId,
  };
  const effective = mode ?? (await resolveSetting('prEvaluation.defaultMode', scope));
  if (effective !== 'enforce') {
    return [];
  }
  const [context, enabled, last] = await Promise.all([
    resolveSetting('prEvaluation.requiredStatusContext', scope),
    resolveSetting('prEvaluation.enabled', scope),
    fastify.prisma.prEvaluation.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { readiness: true },
      where: { connectionId: repo.id },
    }),
  ]);
  const warnings: string[] = [];
  if (!enabled) {
    warnings.push(
      'Nothing is evaluated, so nothing is enforced: pull request evaluation is switched off (prEvaluation.enabled).'
    );
  }
  if (!last) {
    warnings.push(
      `No evaluation has run yet, so it is not known whether "${context}" is a required status check on the base branch. Nothing is enforced until it is.`
    );
    return warnings;
  }
  const rules = branchRulesOf(last.readiness);
  const contexts = rules?.requiredStatusContexts;
  if (!Array.isArray(contexts)) {
    warnings.push(
      `Nothing is enforced until "${context}" is a required status check on the base branch, and the platform could not read whether it is. Require it in branch protection or a ruleset.`
    );
  } else if (!contexts.includes(context)) {
    warnings.push(
      `Nothing is enforced yet: "${context}" is not a required status check on the base branch. Require it in branch protection or a ruleset.`
    );
  } else if (rules?.requiredStatusPinnedToApp !== true) {
    warnings.push(
      `"${context}" is required but not pinned to the platform's GitHub App, so anyone with statuses: write can post success under it and enforcement cannot be trusted. Pin the requirement to the App; a personal access token cannot be pinned.`
    );
  }
  return warnings;
}

/**
 * Every unmet precondition for `auto`, as sentences an operator can act on. The arming rule is
 * the worker's own (`autoArmingRefusals`), applied to the repository's latest evaluation. This is
 * a repository-level check, not a pull request's: approvals and draft state are enforced per
 * pull request when arming, so they are treated as met here.
 */
async function autoRefusals(
  fastify: FastifyInstance,
  role: string,
  repo: { id: string; team: { orgId: string | null } | null; teamId: string }
): Promise<string[]> {
  const reasons: string[] = [];
  if (role !== Role.ADMIN) {
    reasons.push('Only a platform admin may set auto mode.');
  }
  const ctx = {
    ...(repo.team?.orgId ? { orgId: repo.team.orgId } : {}),
    teamId: repo.teamId,
  };
  const [enabled, autoMergeAllowed, minEvidence, minRepoEvidence, minDistinctRequesters, minLines] =
    await Promise.all([
      resolveSetting('prEvaluation.enabled', ctx),
      resolveSetting('prEvaluation.autoMergeAllowed', ctx),
      resolveSetting('prEvaluation.autoMinEvidence', ctx),
      resolveSetting('prEvaluation.autoMinRepoEvidence', ctx),
      resolveSetting('prEvaluation.autoMinDistinctRequesters', ctx),
      resolveSetting('prEvaluation.autoEvidenceMinChangedLines', ctx),
    ]);
  const [context, evidence, last] = await Promise.all([
    resolveSetting('prEvaluation.requiredStatusContext', ctx),
    prEvaluationEvidence(fastify.prisma, repo.id, new Date(), minLines),
    fastify.prisma.prEvaluation.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { readiness: true },
      where: { connectionId: repo.id },
    }),
  ]);
  if (!enabled) {
    reasons.push('Pull request evaluation is switched off (prEvaluation.enabled).');
  }
  if (!autoMergeAllowed) {
    reasons.push('Auto-merge is not allowed on this deployment (prEvaluation.autoMergeAllowed).');
  }
  const assessment = autoEvidenceAssessment(evidence, {
    minDistinctRequesters,
    minEvidence,
    minRepoEvidence,
  });
  for (const unmet of assessment.unmet) {
    reasons.push(`Not enough evidence, ${unmet}.`);
  }
  if (!last) {
    reasons.push('Auto mode is not ready: no evaluation has run yet for this repository.');
  } else {
    const readiness = branchRulesOf(last.readiness);
    const published = readiness?.statusPublished;
    const statusPublished =
      !!published && typeof published === 'object' && (published as { ok?: unknown }).ok === true;
    for (const refusal of autoArmingRefusals({
      approvalSatisfied: true,
      context,
      draft: false,
      // Launcher resolution is per pull request, so this repository-level check cannot ask it;
      // it is enforced when a pull request is armed.
      launcherResolved: true,
      readiness,
      statusPublished,
    })) {
      reasons.push(`The latest evaluation shows ${refusal}.`);
    }
  }
  return reasons;
}
