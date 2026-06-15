import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import type { AgentSpec } from '../lib/config/agentSpec.js';
import { recordLlmUsage } from '../lib/costTracking.js';

const otelTracer = trace.getTracer('auto-swe-worker');

export interface RunAgentOptions {
  /** OTel span name and cost-attribution event name. Default `llm.run_agent`. */
  spanName?: string;
}

export interface RunAgentResult<T = unknown> {
  /** Structured output, present when the spec carried an `outputSchema`. */
  object?: T;
  /** Free-text output, present when the model returned prose. */
  text?: string;
  /** Token usage as reported by the provider, if any. */
  usage?: Awaited<ReturnType<InstanceType<typeof Agent>['generate']>>['usage'];
}

/**
 * Generic Mastra agent loop driven by an {@link AgentSpec}. Builds the agent,
 * runs a single `generate` (Mastra drives the internal tool-calling loop when
 * the spec carries tools), records token usage via `recordLlmUsage`, captures
 * one `llm_response` trace, and persists it via `persistActivityTrace`.
 *
 * This is an in-process helper, not a Temporal activity boundary — an
 * `AgentSpec` holds live, non-serializable handles (`model`, `tools`). Callers
 * are themselves activities (e.g. `validateContext`), so the trace's `nodeId`
 * (from `currentActivityType`) and attempt resolve to the caller's activity.
 * The P2 `agent` node will wrap this in an activity that resolves the spec
 * inside the activity boundary.
 *
 * The trace is persisted in a `finally` so a thrown LLM call still records the
 * failed attempt; the error is re-raised for the caller to handle (e.g. the
 * graceful-degradation path in `validateContext`).
 */
export async function runAgent<T = unknown>(
  spec: AgentSpec,
  userMessage: string,
  options: RunAgentOptions = {}
): Promise<RunAgentResult<T>> {
  const spanName = options.spanName ?? 'llm.run_agent';
  const tracer = new AgentTracer();
  try {
    return await otelTracer.startActiveSpan(spanName, async (span) => {
      const start = Date.now();
      try {
        span.setAttribute('llm.model', spec.modelSpec);
        span.setAttribute('agent.key', spec.agentKey);

        const agent = new Agent({
          id: spec.agentKey,
          instructions: spec.systemPrompt,
          model: spec.model,
          name: spec.agentKey,
          tools: spec.tools,
        });

        const genResult = spec.outputSchema
          ? await agent.generate([{ content: userMessage, role: 'user' }], {
              structuredOutput: { schema: spec.outputSchema },
            })
          : await agent.generate([{ content: userMessage, role: 'user' }]);

        if (genResult.usage) {
          await recordLlmUsage(currentWorkflowId(), spec.agentKey, genResult.usage, spanName);
        }

        const object = (genResult.object ?? undefined) as T | undefined;
        const text = genResult.text || undefined;

        tracer.addLlmResponse({
          durationMs: Date.now() - start,
          inputJson: { systemPrompt: spec.systemPrompt, userMessage },
          outputJson: object !== undefined ? { object } : { text },
          role: spec.agentKey,
        });

        return { object, text, usage: genResult.usage };
      } catch (e) {
        tracer.addLlmResponse({
          durationMs: Date.now() - start,
          error: (e as Error).message,
          inputJson: { systemPrompt: spec.systemPrompt, userMessage },
          role: spec.agentKey,
        });
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    });
  } finally {
    await persistActivityTrace(tracer, spec.agentKey);
  }
}
