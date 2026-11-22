import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { SUBMIT_LEARNING_TOOL, submitLearningWorkerTool } from './knowledgeTools.js';
import { lessonWorkerTools } from './lessonTools.js';
import { grantsProvisionTool, provisionWorkerTool } from './provisionTool.js';
import type { WorkerTool } from './workerTool.js';

export interface SessionToolGrants {
  /** Scope the installer's switches resolve at. */
  ctx?: ResolveCtx;
  /** The repository whose lessons the memory tools read; omitted, there are none. */
  repoId?: string;
  /** The resolved Agent's effective `toolKeys`. */
  toolKeys: readonly string[] | null;
  tracer?: AgentTracer;
  workspace: Workspace;
}

/**
 * The worker-side tools an Agent's grants open beyond its workspace tools — the
 * ones the Mastra loop binds inside `createImplementerAgent` and a harness binds
 * through `workerTool.ts`.
 *
 * Written once so the two loops cannot drift: lesson recall is bound to the
 * run's repository, `submitLearning` and `provisionTool` only when the Agent's
 * `toolKeys` name them (an unrestricted list never implies either), and the
 * installer re-checks its own grant at call time.
 */
export function workerToolsFor(grants: SessionToolGrants): WorkerTool[] {
  const { ctx, repoId, toolKeys, tracer, workspace } = grants;
  const provisions = grantsProvisionTool(toolKeys);
  return [
    ...(repoId ? lessonWorkerTools(repoId, tracer) : []),
    ...(toolKeys?.includes(SUBMIT_LEARNING_TOOL) ? [submitLearningWorkerTool(tracer)] : []),
    ...(provisions
      ? [
          provisionWorkerTool({
            ...(ctx?.orgId || ctx?.teamId
              ? {
                  ctx: {
                    ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
                    ...(ctx.teamId ? { teamId: ctx.teamId } : {}),
                  },
                }
              : {}),
            toolKeys,
            ...(tracer ? { tracer } : {}),
            workspace,
          }),
        ]
      : []),
  ];
}
