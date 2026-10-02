import { resolveSetting } from '@auto-swe/shared/config';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { abortSignalOption } from '../lib/cancellation.js';
import type { AgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { assertBudgetAvailable, type LlmAttribution, recordLlmUsage } from '../lib/costTracking.js';
import { withHeartbeat } from '../lib/execUtils.js';
import { failedCallAttribution } from '../lib/llmAttribution.js';
import { createStepAccounting } from '../lib/stepAccounting.js';
import { assertModelPricedForUsdCap } from '../lib/usdCapGuard.js';

const otelTracer = trace.getTracer('auto-swe-worker');

export interface RunAgentOptions {
  /** OTel span name and cost-attribution event name. Default `llm.run_agent`. */
  spanName?: string;
  /**
   * Scope the step budget (`workspace.agentMaxSteps`) resolves against. Pass
   * the fullest context the caller has — a channel-scoped run's `channelId`,
   * say — since a lookup missing a key silently resolves a broader value.
   * Defaults to the activity's request context.
   */
  ctx?: ResolveCtx;
  /**
   * Step ceiling for this call. Wins over `workspace.agentMaxSteps`, so a caller
   * that has already resolved a tighter bound (an agent run's clamped cap) is
   * not re-widened by the generic setting.
   */
  maxSteps?: number;
  /**
   * An additional abort signal (an agent run's wall-clock deadline), merged with
   * the activity's cancellation signal. Unlike cancellation it is a *stop*, not
   * a failure: the call returns what it has with `stoppedReason: 'wall_clock'`.
   * Only honoured with `perStepAccounting`, which is what guarantees the spend
   * of a partial result is recorded.
   */
  abortSignal?: AbortSignal;
  /**
   * Record usage and re-check the run budget after EVERY step, instead of once
   * before and once after a single `generate`.
   *
   * The default shape checks the budget once before a loop of up to 500 tool
   * steps and records usage only when `generate` returns, so (a) a long loop can
   * overshoot its tier many times over, and (b) an aborted call — deadline,
   * cancellation, a provider error mid-loop — skipped `recordLlmUsage`, and the
   * spend of every completed step went unrecorded. With this on, each finished
   * step is debited as it lands, a step that exhausts the budget aborts the loop
   * with `BUDGET_EXCEEDED`, and an abort loses at most the one step in flight.
   */
  perStepAccounting?: boolean;
}

export interface RunAgentResult<T = unknown> {
  /** Structured output, present when the spec carried an `outputSchema`. */
  object?: T;
  /** Free-text output, present when the model returned prose. */
  text?: string;
  /** Token usage as reported by the provider, if any. */
  usage?: Awaited<ReturnType<InstanceType<typeof Agent>['generate']>>['usage'];
  /**
   * Authoritative USD cost for this call, priced by `recordLlmUsage` against the
   * agent KEY's configured model (the same number debited to the run-level
   * ledger). `0` when the provider reported no usage. Callers should use this
   * rather than re-pricing `usage` to stay consistent with the run ledger.
   */
  costUsd?: number;
  /** False when the model had no known price, so `costUsd` is an unpriced $0. */
  pricingKnown?: boolean;
  /** Input tokens attributed by `recordLlmUsage` (0 when there was no usage). */
  inputTokens?: number;
  /** Output tokens attributed by `recordLlmUsage` (0 when there was no usage). */
  outputTokens?: number;
  /** Provider finish reason of the last step (`stop`, `tool-calls`, `aborted`, ...). */
  finishReason?: string;
  /** Number of model steps taken. */
  stepCount?: number;
  /**
   * Set when the call ended before the model finished: it used every step
   * (`max_steps`) or hit the caller's abort signal (`wall_clock`).
   */
  stoppedReason?: 'max_steps' | 'wall_clock';
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
      // The trace is persisted after this span ends, so capture its context now
      // or the rows lose their link to Tempo.
      const { traceId, spanId } = span.spanContext();
      tracer.setSpanContext(traceId, spanId);
      let recorded: LlmAttribution | undefined;
      let accountingTotals: (() => LlmAttribution) | undefined;
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

        // An unpriced model measures as $0 and a USD cap would count nothing, so
        // on a capped path the call is refused before it is made. Uncapped paths
        // proceed and record $0 with `llm.cost_pricing_known=false`.
        // The ambient activity context never carries a channelId, so only an
        // explicit ctx can name a channel; no lookup is needed to find out.
        await assertModelPricedForUsdCap(spec.modelSpec, { channelId: options.ctx?.channelId });
        await assertBudgetAvailable(`agent.${spec.agentKey}`);
        // Every caller is an activity with a heartbeat timeout, and a single
        // generate (with a tool loop) can outlast it — pump heartbeats while
        // it runs. The heartbeat is also how a cancellation reaches this
        // activity; the abort signal then stops the in-flight call.
        // A tool-bearing agent (MCP tools on an agent node) needs an explicit
        // step budget: without one Mastra stops after 5 steps, which ends the
        // turn mid-task. Same setting as the implementer family. A tool-free
        // call is a single step, so it neither needs nor reads the setting.
        const hasTools = Object.keys(spec.tools ?? {}).length > 0;
        const maxSteps = hasTools
          ? (options.maxSteps ??
            (await resolveSetting(
              'workspace.agentMaxSteps',
              options.ctx ?? (await currentRequestContext())
            )))
          : undefined;
        const stepBudget = maxSteps === undefined ? {} : { maxSteps };

        // Per-step accounting (agent runs). Its abort controller is how a step
        // that exhausts the budget stops the loop; the reason is carried out of
        // band because an aborted generate may resolve instead of throwing.
        const accounting = options.perStepAccounting
          ? createStepAccounting(spec.agentKey, spanName, options.abortSignal, spec.modelSpec)
          : undefined;
        accountingTotals = accounting?.totals;
        const callOptions = accounting
          ? { ...stepBudget, abortSignal: accounting.signal, onStepFinish: accounting.onStepFinish }
          : { ...stepBudget, ...abortSignalOption() };

        let genResult: Awaited<ReturnType<InstanceType<typeof Agent>['generate']>> | undefined;
        try {
          genResult = await withHeartbeat(
            `agent ${spec.agentKey}: generating`,
            spec.outputSchema
              ? agent.generate([{ content: userMessage, role: 'user' }], {
                  ...callOptions,
                  structuredOutput: { schema: spec.outputSchema },
                })
              : Object.keys(callOptions).length > 0
                ? agent.generate([{ content: userMessage, role: 'user' }], callOptions)
                : agent.generate([{ content: userMessage, role: 'user' }])
          );
        } catch (e) {
          // A budget stop wins over whatever the aborted call threw, and a
          // cancellation is a failure, not a stop. Only the caller's own
          // deadline degrades to a partial result; anything else propagates.
          if (!accounting) {
            throw e;
          }
          accounting.throwIfBudgetOrCancelled();
          if (!accounting.deadlineHit()) {
            throw e;
          }
        }
        accounting?.throwIfBudgetOrCancelled();

        let attribution: LlmAttribution = {
          costUsd: 0,
          inputTokens: 0,
          modelSpec: '',
          outputTokens: 0,
        };
        if (accounting) {
          // Every step was debited as it finished; do not debit the total again.
          attribution = recorded = accounting.totals();
        } else if (genResult?.usage) {
          attribution = recorded = await recordLlmUsage(
            currentWorkflowId(),
            spec.agentKey,
            genResult.usage,
            spanName,
            spec.modelSpec
          );
        }
        const deadlineHit = accounting?.deadlineHit() ?? false;
        const stepCount = accounting ? accounting.stepCount() : genResult?.steps?.length;
        const finishReason = genResult?.finishReason;
        const stoppedReason: RunAgentResult['stoppedReason'] = deadlineHit
          ? 'wall_clock'
          : maxSteps !== undefined &&
              finishReason !== undefined &&
              finishReason !== 'stop' &&
              (stepCount ?? 0) >= maxSteps
            ? 'max_steps'
            : undefined;

        const object = (genResult?.object ?? undefined) as T | undefined;
        const text = genResult?.text || accounting?.lastText() || undefined;

        tracer.addLlmResponse({
          costUsd: attribution.costUsd,
          durationMs: Date.now() - start,
          inputJson: { systemPrompt: spec.systemPrompt, userMessage },
          inputTokens: attribution.inputTokens,
          model: attribution.modelSpec || undefined,
          outputJson: object !== undefined ? { object } : { text },
          outputTokens: attribution.outputTokens,
          role: spec.agentKey,
        });

        return {
          costUsd: attribution.costUsd,
          finishReason,
          inputTokens: attribution.inputTokens,
          object,
          outputTokens: attribution.outputTokens,
          pricingKnown: attribution.pricingKnown,
          stepCount,
          stoppedReason,
          text,
          usage: genResult?.usage,
        };
      } catch (e) {
        // Steps already debited by per-step accounting were paid for even when
        // the call as a whole failed.
        const paid = recorded ?? (accountingTotals ? accountingTotals() : undefined);
        tracer.addLlmResponse({
          ...failedCallAttribution(e, spec.modelSpec, paid),
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
