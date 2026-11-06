import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import {
  MAX_DEPENDENCY_CHECKOUTS,
  resolveKnowledgeBaseSet,
} from '@auto-swe/shared/lib/knowledgeBaseResolution';
import { z } from 'zod';
import { currentTemporalRunId, currentWorkflowId } from './activityContext.js';
import { logWarn } from './activityLog.js';
import { currentRequestContext } from './config/contextLookup.js';
import { ensureKnowledgeBaseSnapshot } from './knowledgeBaseIndex.js';
import { getScmProvider, toRepoRef } from './scm/index.js';

export interface KnowledgeBaseCheckout {
  knowledgeBaseId: string;
  snapshotId: string;
  authedCloneUrl: string;
  sha: string;
  path: string;
  mountName: string;
  owner: string;
  repo: string;
  flaggedFiles: string[];
}

export interface MountedKnowledgeBase {
  knowledgeBaseId: string;
  snapshotId: string;
  sha: string;
  mountPath: string;
  owner: string;
  repo: string;
}

const Resolution = z.object({
  knowledgeBaseId: z.string(),
  mandatory: z.boolean(),
  mountName: z.string().nullable(),
  ref: z.string().nullable(),
  source: z.enum(['TEAM', 'REPO', 'TEMPLATE', 'RUN']),
});
const Selected = Resolution.extend({
  connectionId: z.string(),
  path: z.string(),
  sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
  snapshotId: z.string(),
});
export const RunKnowledgeBasePinSchema = z.object({
  dropped: z.array(Resolution),
  refusedExclusions: z.array(z.string()),
  selected: z.array(Selected),
});
const Overrides = z.object({
  add: z.array(z.object({ knowledgeBaseId: z.string(), ref: z.string().nullish() })).optional(),
  exclude: z.array(z.string()).optional(),
});
const Flagged = z.array(z.object({ path: z.string(), reason: z.string() }));

export interface LoadRunKnowledgeBasesOptions {
  repoId?: string | null;
  teamId?: string | null;
  templateId?: string | null;
  knowledgeBases?: boolean;
  checkoutCredentials?: boolean;
}

export async function loadRunKnowledgeBases(options: LoadRunKnowledgeBasesOptions = {}): Promise<{
  checkouts: KnowledgeBaseCheckout[];
  snapshotIds: string[];
}> {
  const empty = { checkouts: [], snapshotIds: [] };
  if (options.knowledgeBases === false) {
    return empty;
  }
  try {
    let workflowId: string | undefined;
    try {
      workflowId = currentWorkflowId();
    } catch {}
    const executionId = currentTemporalRunId();
    const run = workflowId
      ? await prisma.workflowRun.findUnique({
          select: {
            connectionId: true,
            id: true,
            knowledgeBaseOverrides: true,
            knowledgeBases: true,
            knowledgeBasesFor: true,
            knowledgeSourceOrgId: true,
            knowledgeSourceRepoId: true,
            knowledgeSourceTeamId: true,
            templateId: true,
          },
          where: { workflowId },
        })
      : null;
    const repoId = run?.connectionId ?? run?.knowledgeSourceRepoId ?? options.repoId;
    const repo = repoId
      ? await prisma.connection.findUnique({ include: { team: true }, where: { id: repoId } })
      : null;
    const ctx = await currentRequestContext();
    const teamId = run?.knowledgeSourceTeamId ?? repo?.teamId ?? options.teamId ?? ctx.teamId;
    if (!teamId) {
      return empty;
    }
    const team = await prisma.team.findUnique({ select: { orgId: true }, where: { id: teamId } });
    const orgId = run?.knowledgeSourceOrgId ?? team?.orgId;
    if (!orgId || (team && team.orgId !== orgId)) {
      return empty;
    }
    const templateId = run?.templateId ?? options.templateId ?? ctx.workflowTemplateId;
    const attachable = {
      connection: { isActive: true, team: { orgId }, type: 'git_repo' },
      OR: [
        { connection: { teamId } },
        { visibility: 'ORG' as const },
        { shares: { some: { teamId } }, visibility: 'SHARED' as const },
      ],
      orgId,
      status: 'OK' as const,
    };
    type Base = Prisma.KnowledgeBaseGetPayload<{
      include: { connection: { include: { installation: true } } };
    }>;
    const loadBases = (ids: string[]) =>
      prisma.knowledgeBase.findMany({
        include: { connection: { include: { installation: true } } },
        where: { ...attachable, id: { in: ids }, orgId },
      });
    let pin: z.infer<typeof RunKnowledgeBasePinSchema>;
    let bases: Base[];
    if (
      run?.knowledgeBases != null &&
      (run.knowledgeBasesFor === executionId || run.knowledgeBasesFor === null)
    ) {
      pin = RunKnowledgeBasePinSchema.parse(run.knowledgeBases);
      bases = await loadBases(pin.selected.map((kb) => kb.knowledgeBaseId));
    } else {
      const overrides =
        run?.knowledgeBaseOverrides == null
          ? undefined
          : Overrides.parse(run.knowledgeBaseOverrides);
      const links = await prisma.knowledgeBaseLink.findMany({
        orderBy: { id: 'asc' },
        where: {
          knowledgeBase: { ...attachable, orgId },
          OR: [
            { scope: 'TEAM', teamId },
            ...(repoId ? [{ repoId, scope: 'REPO' as const }] : []),
            ...(templateId ? [{ scope: 'TEMPLATE' as const, templateId }] : []),
          ],
        },
      });
      bases = await loadBases([
        ...new Set([
          ...links.map((link) => link.knowledgeBaseId),
          ...(overrides?.add ?? []).map((item) => item.knowledgeBaseId),
        ]),
      ]);
      const byId = new Map(bases.map((kb) => [kb.id, kb]));
      const availableLinks = links.filter((link) => byId.has(link.knowledgeBaseId));
      const resolution = resolveKnowledgeBaseSet({
        cap: MAX_DEPENDENCY_CHECKOUTS,
        repoLinks: availableLinks.filter((link) => link.scope === 'REPO'),
        runOverrides: overrides
          ? { ...overrides, add: overrides.add?.filter((item) => byId.has(item.knowledgeBaseId)) }
          : undefined,
        teamLinks: availableLinks.filter((link) => link.scope === 'TEAM'),
        templateLinks: availableLinks.filter((link) => link.scope === 'TEMPLATE'),
      });
      const selected: z.infer<typeof Selected>[] = [];
      for (const resolved of resolution.selected) {
        const kb = byId.get(resolved.knowledgeBaseId);
        if (!kb) {
          continue;
        }
        const ref = toRepoRef(kb.connection);
        const scm = getScmProvider(ref);
        const sha = await scm.resolveRef(
          ref,
          resolved.ref ??
            kb.defaultRef ??
            kb.connection.defaultBranch ??
            (await scm.defaultBranch(ref))
        );
        if (!sha) {
          throw new Error('knowledge base ref unavailable');
        }
        const snapshot = await ensureKnowledgeBaseSnapshot(kb.id, sha);
        selected.push({
          ...resolved,
          connectionId: kb.connectionId,
          mountName: resolved.mountName ?? kb.mountName,
          path: snapshot.path,
          sha: snapshot.sha,
          snapshotId: snapshot.id,
        });
      }
      pin = {
        dropped: resolution.dropped,
        refusedExclusions: resolution.refusedExclusions,
        selected,
      };
      if (run) {
        await prisma.workflowRun.updateMany({
          data: { knowledgeBases: pin as Prisma.InputJsonObject, knowledgeBasesFor: executionId },
          where: {
            id: run.id,
            OR: [
              { knowledgeBases: { equals: Prisma.DbNull } },
              ...(executionId ? [{ knowledgeBasesFor: { not: executionId } }] : []),
            ],
          },
        });
        const winner = await prisma.workflowRun.findUniqueOrThrow({
          select: { knowledgeBases: true },
          where: { id: run.id },
        });
        pin = RunKnowledgeBasePinSchema.parse(winner.knowledgeBases);
        bases = await loadBases(pin.selected.map((kb) => kb.knowledgeBaseId));
      }
    }
    const byId = new Map(bases.map((kb) => [kb.id, kb]));
    const snapshots = await prisma.knowledgeBaseSnapshot.findMany({
      select: { flaggedFiles: true, id: true, knowledgeBaseId: true, path: true, sha: true },
      where: {
        id: { in: pin.selected.map((kb) => kb.snapshotId) },
        knowledgeBase: { orgId },
        status: 'READY',
      },
    });
    const checkouts: KnowledgeBaseCheckout[] = [];
    const snapshotIds: string[] = [];
    for (const selected of pin.selected) {
      const kb = byId.get(selected.knowledgeBaseId);
      const snapshot = snapshots.find(
        (item) =>
          item.id === selected.snapshotId &&
          item.knowledgeBaseId === selected.knowledgeBaseId &&
          item.sha === selected.sha &&
          item.path === selected.path
      );
      if (!kb || !snapshot || kb.connectionId !== selected.connectionId) {
        continue;
      }
      snapshotIds.push(snapshot.id);
      if (options.checkoutCredentials === false) {
        continue;
      }
      const ref = toRepoRef(kb.connection);
      const { authedCloneUrl } = await getScmProvider(ref).cloneCredentials(ref);
      checkouts.push({
        authedCloneUrl,
        flaggedFiles: Flagged.parse(snapshot.flaggedFiles).map((file) => file.path),
        knowledgeBaseId: kb.id,
        mountName: selected.mountName ?? kb.mountName,
        owner: ref.organizationName,
        path: selected.path,
        repo: ref.repoName,
        sha: selected.sha,
        snapshotId: snapshot.id,
      });
    }
    return { checkouts, snapshotIds };
  } catch {
    logWarn('knowledge base resolution failed; continuing without reference material');
    return empty;
  }
}
