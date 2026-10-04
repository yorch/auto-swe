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
  /**
   * Record into the caller's tracer instead of a private one, and leave
   * persisting it to the caller. For a caller whose tools record their own
   * calls on that tracer (MCP and workspace tools do): the loop's rows and the
   * tool rows then share one `seq` sequence and persist once. Name those tools
   * in `selfRecordingTools` so their calls are not recorded a second time.
   */
  tracer?: AgentTracer;
  /**
   * Keys (as bound in `spec.tools`) of the tools that record their own calls on
   * the tracer while the loop runs. Their calls are not re-read from the
   * result's steps; every other tool call still gets a row from the steps,
   * appended after the loop returns. Empty by default, so an unlisted tool is
   * never left without a row — the worst case is a duplicate.
   */
  selfRecordingTools?: ReadonlySet<string>;
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
 * a `tool_call` row per tool call the loop made and one `llm_response` row, and
 * persists them via `persistActivityTrace` (or leaves that to a caller that
 * passed its own `tracer`).
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
  const tracer = options.tracer ?? new AgentTracer();
  try {
    return await otelTracer.startActiveSpan(spanName, async (span) => {
      const start = Date.now();
      // The trace is persisted after this span ends, so capture its context now
      // or the rows lose their link to Tempo.
      const { traceId, spanId } = span.spanContext();
      tracer.setSpanContext(traceId, spanId);
      let recorded: LlmAttribution | undefined;
      // Call ids the tool wrappers have already recorded, so the step pass below
      // adds rows only for calls that never reached a tool's `execute`.
      const liveCallIds = new Set<string>();
      let accountingTotals: (() => LlmAttribution) | undefined;
      try {
        span.setAttribute('llm.model', spec.modelSpec);
        span.setAttribute('agent.key', spec.agentKey);

        const agent = new Agent({
          id: spec.agentKey,
          instructions: spec.systemPrompt,
          model: spec.model,
          name: spec.agentKey,
          tools: recordToolCalls(spec.tools, tracer, options.selfRecordingTools, liveCallIds),
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

        recordStepToolCalls(tracer, genResult?.steps, options.selfRecordingTools, liveCallIds);

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
    if (!options.tracer) {
      await persistActivityTrace(tracer, spec.agentKey);
    }
  }
}

/** A tool's `execute`, as far as the wrapper needs to see it. */
type ToolExecute = (
  input: unknown,
  context?: { agent?: { toolCallId?: string } }
) => Promise<unknown>;

/**
 * A copy of `tools` whose `execute` records its own `tool_call` row as the call
 * happens: real duration, and a row even when the surrounding `generate` later
 * throws, which would leave the step pass below with nothing to read. Tools in
 * `skip` already record themselves and are passed through untouched. The tool
 * objects are cloned rather than patched, since a tool may be shared.
 */
function recordToolCalls(
  tools: AgentSpec['tools'],
  tracer: AgentTracer,
  skip: ReadonlySet<string> = new Set(),
  liveCallIds: Set<string>
): AgentSpec['tools'] {
  if (!tools) {
    return tools;
  }
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: ToolExecute }).execute;
    if (skip.has(name) || !execute) {
      wrapped[name] = tool;
      continue;
    }
    const clone = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
      execute: async (input: unknown, context?: Parameters<ToolExecute>[1]) => {
        const start = Date.now();
        const callId = context?.agent?.toolCallId;
        if (callId) {
          liveCallIds.add(callId);
        }
        try {
          const output = await execute.call(tool, input, context);
          tracer.addToolCall({
            durationMs: Date.now() - start,
            inputJson: input ?? {},
            outputJson: output,
            toolName: name,
          });
          return output;
        } catch (e) {
          tracer.addToolCall({
            durationMs: Date.now() - start,
            error: errorText(e),
            inputJson: input ?? {},
            toolName: name,
          });
          throw e;
        }
      },
    });
    wrapped[name] = clone;
  }
  return wrapped as AgentSpec['tools'];
}

/** The slice of a Mastra step that carries its tool calls and their outcomes. */
interface StepToolCalls {
  toolCalls?: Array<{ payload: { toolCallId: string; toolName: string; args?: unknown } }>;
  toolResults?: Array<{ payload: { toolCallId: string; result: unknown; isError?: boolean } }>;
  content?: ReadonlyArray<{ type: string; toolCallId?: string; error?: unknown }>;
  response?: { messages?: ReadonlyArray<{ role: string; content: unknown }> };
}

const NO_RESULT_ERROR = 'tool call produced no result (it threw or did not complete)';

/**
 * A `tool_call` row for each call Mastra made inside the loop that no tool
 * wrapper recorded live (`liveCallIds`) — one that failed input validation or
 * named no tool never reaches `execute` — paired with its outcome by call id.
 * The steps carry no timing, so `durationMs` is 0, and only a `generate` that
 * returned has steps to read. Calls to a tool named in `skip` are left out,
 * since that tool records its own row.
 *
 * A tool that THROWS never reaches `toolResults`: Mastra emits it as a separate
 * `tool-error` chunk and buffers only `tool-result` chunks there. Its message
 * survives in the tool message the loop fed back to the model (an `error-text`
 * or `error-json` output), so that is read too. A call with no result and no
 * error anywhere is still recorded as failed, never as a success with no output.
 */
function recordStepToolCalls(
  tracer: AgentTracer,
  steps: StepToolCalls[] | undefined,
  skip: ReadonlySet<string> = new Set(),
  liveCallIds: ReadonlySet<string> = new Set()
): void {
  const errors = stepToolErrors(steps ?? []);
  for (const step of steps ?? []) {
    const results = new Map(
      (step.toolResults ?? []).map((r) => [r.payload.toolCallId, r.payload] as const)
    );
    for (const { payload: call } of step.toolCalls ?? []) {
      if (skip.has(call.toolName) || liveCallIds.has(call.toolCallId)) {
        continue;
      }
      const result = results.get(call.toolCallId);
      const succeeded = result !== undefined && !result.isError;
      tracer.addToolCall({
        durationMs: 0,
        error: succeeded
          ? undefined
          : (errors.get(call.toolCallId) ?? (result ? errorText(result.result) : NO_RESULT_ERROR)),
        inputJson: call.args ?? {},
        outputJson: succeeded ? result.result : undefined,
        toolName: call.toolName,
      });
    }
  }
}

/**
 * Error text per failed tool call id, from `tool-error` content parts and the
 * error outputs of `tool` messages. A step's `response.messages` is cumulative,
 * so one call can appear in several steps; it maps to the same text each time.
 */
function stepToolErrors(steps: StepToolCalls[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const step of steps) {
    for (const part of step.content ?? []) {
      if (part.type === 'tool-error' && part.toolCallId) {
        errors.set(part.toolCallId, errorText(part.error));
      }
    }
    for (const message of step.response?.messages ?? []) {
      if (message.role !== 'tool' || !Array.isArray(message.content)) {
        continue;
      }
      for (const part of message.content as ToolMessagePart[]) {
        const kind = part.output?.type;
        if (part.toolCallId && (kind === 'error-text' || kind === 'error-json')) {
          errors.set(part.toolCallId, errorText(part.output?.value));
        }
      }
    }
  }
  return errors;
}

/** The slice of an AI SDK `tool` message part that carries a failed call's error. */
interface ToolMessagePart {
  toolCallId?: string;
  output?: { type?: string; value?: unknown };
}

function errorText(result: unknown): string {
  if (result instanceof Error) {
    return result.message;
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}
