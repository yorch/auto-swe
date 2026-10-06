import type { PlannedRepo, RepoInfo } from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import { currentWorkflowId } from '../lib/activityContext.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { assertBudgetAvailable, type LlmAttribution, recordLlmUsage } from '../lib/costTracking.js';
import { failedCallAttribution } from '../lib/llmAttribution.js';
import { getModel, getModelSpec, resolveSystemPrompt } from '../lib/models.js';
import { assertRolePricedForUsdCap } from '../lib/usdCapGuard.js';
import { PLANNER_AGENT_PROMPT } from './prompts.js';

const otelTracer = trace.getTracer('auto-swe-worker');

// ── Zod schema for structured output ──

const PlannedRepoSchema = z.object({
  dependsOn: z.array(z.string()),
  description: z.string(),
  repoId: z.string(),
});

const PlannerOutputSchema = z.object({
  repos: z.array(PlannedRepoSchema),
});

/**
 * Turn the planner's output into a plan the epic orchestrator can schedule
 * completely. The planner chooses ordering, not scope: every repository the
 * epic was launched against is in the plan, so a planner that omits one (or
 * returns nothing) cannot make an epic report SUCCESS for work it never did.
 *
 *  - entries naming a repository outside `availableRepos` are dropped;
 *  - a repository listed twice keeps its first entry, with the union of deps;
 *  - an available repository the planner omitted is appended with no deps;
 *  - a dependency on a repository outside the plan, or on itself, is dropped.
 *
 * Pure and deterministic: planner order first, then omitted repos in
 * `availableRepos` order.
 */
export function normalizePlan(
  plannedRepos: PlannedRepo[],
  availableRepos: RepoInfo[]
): PlannedRepo[] {
  const available = new Map(availableRepos.map((r) => [r.repoId, r]));
  const byId = new Map<string, { description: string; deps: Set<string> }>();
  for (const r of plannedRepos) {
    if (!available.has(r.repoId)) {
      continue;
    }
    const existing = byId.get(r.repoId);
    if (existing) {
      for (const dep of r.dependsOn) {
        existing.deps.add(dep);
      }
      continue;
    }
    byId.set(r.repoId, { deps: new Set(r.dependsOn), description: r.description });
  }
  for (const r of availableRepos) {
    if (!byId.has(r.repoId)) {
      byId.set(r.repoId, { deps: new Set(), description: r.description });
    }
  }
  return [...byId].map(([repoId, { description, deps }]) => ({
    dependsOn: [...deps].filter((dep) => dep !== repoId && byId.has(dep)),
    description,
    repoId,
  }));
}

// ── Planner Agent ──

export async function decomposeEpic(
  epicDescription: string,
  availableRepos: RepoInfo[],
  tracer?: AgentTracer,
  skillSuffix?: string
): Promise<PlannedRepo[]> {
  return otelTracer.startActiveSpan(
    'llm.epic_planning',
    { attributes: { 'epic.repo_count': availableRepos.length } },
    async (span) => {
      const start = Date.now();
      let systemPrompt = '';
      let llmUserMessage = '';
      let modelSpec: string | undefined;
      let recorded: LlmAttribution | undefined;
      try {
        modelSpec = await getModelSpec('planner');
        const model = await getModel('planner');
        span.setAttribute('llm.model', modelSpec);
        const basePrompt = await resolveSystemPrompt('planner', PLANNER_AGENT_PROMPT);
        systemPrompt = skillSuffix ? `${basePrompt}\n\n${skillSuffix}` : basePrompt;
        const agent = new Agent({
          id: 'epic-planner',
          instructions: systemPrompt,
          model,
          name: 'epic-planner',
        });

        llmUserMessage = JSON.stringify({ availableRepos, epicDescription });
        await assertRolePricedForUsdCap('planner');
        await assertBudgetAvailable('planner');
        const result = await agent.generate([{ content: llmUserMessage, role: 'user' }], {
          structuredOutput: { schema: PlannerOutputSchema },
        });

        let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
        if (result.usage) {
          attribution = recorded = await recordLlmUsage(
            currentWorkflowId(),
            'planner',
            result.usage,
            'llm.epic_planner'
          );
        }

        // Validate rather than cast: a provider can return an object that does
        // not match the schema, and a malformed plan must fail here, not inside
        // the orchestrator's scheduling loop.
        const parsed = PlannerOutputSchema.safeParse(result.object);
        if (!parsed.success) {
          throw new Error('Planner agent did not return valid structured output');
        }
        const finalRepos = normalizePlan(parsed.data.repos, availableRepos);
        if (finalRepos.length === 0) {
          throw ApplicationFailure.nonRetryable(
            'Epic plan is empty: no requested repository is available to plan against',
            'EPIC_PLAN_EMPTY'
          );
        }

        tracer?.addLlmResponse({
          costUsd: attribution.costUsd,
          durationMs: Date.now() - start,
          inputJson: { systemPrompt, userMessage: llmUserMessage },
          inputTokens: attribution.inputTokens,
          model: attribution.modelSpec || undefined,
          outputJson: {
            repoCount: finalRepos.length,
            repos: finalRepos.map((r) => ({ dependsOn: r.dependsOn, repoId: r.repoId })),
          },
          outputTokens: attribution.outputTokens,
          role: 'planner',
        });

        return finalRepos;
      } catch (e) {
        tracer?.addLlmResponse({
          ...failedCallAttribution(e, modelSpec, recorded),
          durationMs: Date.now() - start,
          error: (e as Error).message,
          inputJson: { systemPrompt, userMessage: llmUserMessage },
          role: 'planner',
        });
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    }
  );
}
