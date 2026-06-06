import type { PlannedRepo, RepoInfo } from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import { currentWorkflowId } from '../lib/activityContext.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getModel, getModelSpec, resolveSystemPrompt } from '../lib/models.js';
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
      try {
        const modelSpec = await getModelSpec('planner');
        const model = await getModel('planner');
        span.setAttribute('llm.model', modelSpec);
        const basePrompt = await resolveSystemPrompt('planner', PLANNER_AGENT_PROMPT);
        const systemPrompt = skillSuffix ? `${basePrompt}\n\n${skillSuffix}` : basePrompt;
        const agent = new Agent({
          id: 'epic-planner',
          instructions: systemPrompt,
          model,
          name: 'epic-planner',
        });

        const result = await agent.generate(
          [
            {
              content: JSON.stringify({
                availableRepos,
                epicDescription,
              }),
              role: 'user',
            },
          ],
          { structuredOutput: { schema: PlannerOutputSchema } }
        );

        if (result.usage) {
          await recordLlmUsage(currentWorkflowId(), 'planner', result.usage, 'llm.epic_planner');
        }

        if (!result.object) {
          throw new Error('Planner agent did not return structured output');
        }
        const parsed = result.object as z.infer<typeof PlannerOutputSchema>;

        // Validate that all repoIds reference actual available repos
        const validRepoIds = new Set(availableRepos.map((r) => r.repoId));
        const validatedRepos = parsed.repos.filter((r) => validRepoIds.has(r.repoId));

        // Validate that dependsOn references only repos in the plan
        const plannedRepoIds = new Set(validatedRepos.map((r) => r.repoId));
        const finalRepos = validatedRepos.map((r) => ({
          ...r,
          dependsOn: r.dependsOn.filter((dep) => plannedRepoIds.has(dep)),
        }));

        tracer?.addLlmResponse({
          durationMs: Date.now() - start,
          outputJson: {
            repoCount: finalRepos.length,
            repos: finalRepos.map((r) => ({ dependsOn: r.dependsOn, repoId: r.repoId })),
          },
          role: 'planner',
        });

        return finalRepos;
      } catch (e) {
        tracer?.addLlmResponse({
          durationMs: Date.now() - start,
          error: (e as Error).message,
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
