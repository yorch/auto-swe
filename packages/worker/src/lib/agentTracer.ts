import { prisma } from '@auto-swe/shared/db';

// Raised from 4 KB — a single bash output or file read commonly exceeds the
// old limit and was silently destroyed. 32 KB preserves almost all real
// payloads while keeping individual rows manageable.
const MAX_JSON_CHARS = 32_000;

function truncateStr(s: string, max = MAX_JSON_CHARS): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Truncate string values inside a plain object one level deep. */
function truncateJsonValues(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return truncateStr(obj);
  }
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(truncateJsonValues);
  }
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, truncateJsonValues(v)])
  );
}

export interface TraceRecord {
  seq: number;
  type: 'tool_call' | 'llm_response' | 'activity_event';
  /** tool name for tool_call; agent role for llm_response; event name for activity_event */
  toolName?: string;
  inputJson?: unknown;
  outputJson?: unknown;
  durationMs: number;
  error?: string;
  /** `<provider>/<model>` spec — only set on llm_response records. */
  model?: string;
  /** Input token count — only set on llm_response records. */
  inputTokens?: number;
  /** Output token count — only set on llm_response records. */
  outputTokens?: number;
  /** USD cost rounded to micro-dollars — only set on llm_response records. */
  costUsd?: number;
}

/**
 * Collects tool-call, LLM-response, and activity events during a single agent
 * activity execution and persists them to `agent_traces` when done.
 *
 * Call `setSpanContext()` before `persist()` to attach W3C OTel trace/span IDs
 * so trace rows can be correlated with Grafana/Tempo spans.
 *
 * Best-effort: `persist()` swallows DB errors so tracing never breaks runs.
 */
export class AgentTracer {
  private records: TraceRecord[] = [];
  private seq = 0;
  private otelTraceId?: string;
  private otelSpanId?: string;

  /** Associate the OTel span active at activity completion with all records in this batch. */
  setSpanContext(traceId: string, spanId: string): void {
    this.otelTraceId = traceId;
    this.otelSpanId = spanId;
  }

  addToolCall(opts: {
    toolName: string;
    inputJson: unknown;
    outputJson?: unknown;
    durationMs: number;
    error?: string;
  }): void {
    this.records.push({
      durationMs: opts.durationMs,
      error: opts.error,
      inputJson: truncateJsonValues(opts.inputJson),
      outputJson: opts.outputJson !== undefined ? truncateJsonValues(opts.outputJson) : undefined,
      seq: this.seq++,
      toolName: opts.toolName,
      type: 'tool_call',
    });
  }

  /**
   * Record an LLM call — both the request (systemPrompt + userMessage) and the
   * response. Pass `model`, `inputTokens`, `outputTokens`, `costUsd` from the
   * return value of `recordLlmUsage()` to attach per-call attribution.
   */
  addLlmResponse(opts: {
    role?: string;
    inputJson?: unknown;
    outputJson?: unknown;
    durationMs: number;
    error?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }): void {
    this.records.push({
      costUsd: opts.costUsd,
      durationMs: opts.durationMs,
      error: opts.error,
      inputJson: opts.inputJson !== undefined ? truncateJsonValues(opts.inputJson) : undefined,
      inputTokens: opts.inputTokens,
      model: opts.model,
      outputJson: opts.outputJson !== undefined ? truncateJsonValues(opts.outputJson) : undefined,
      outputTokens: opts.outputTokens,
      seq: this.seq++,
      toolName: opts.role,
      type: 'llm_response',
    });
  }

  /** Record a non-LLM activity event (git operations, test runs, PR creation, etc.). */
  addActivityEvent(opts: {
    name: string;
    inputJson?: unknown;
    outputJson?: unknown;
    durationMs?: number;
    error?: string;
  }): void {
    this.records.push({
      durationMs: opts.durationMs ?? 0,
      error: opts.error,
      inputJson: opts.inputJson !== undefined ? truncateJsonValues(opts.inputJson) : undefined,
      outputJson: opts.outputJson !== undefined ? truncateJsonValues(opts.outputJson) : undefined,
      seq: this.seq++,
      toolName: opts.name,
      type: 'activity_event',
    });
  }

  async persist(
    runId: string | undefined,
    nodeId: string,
    agentKey: string,
    attempt = 1
  ): Promise<void> {
    if (!runId || this.records.length === 0) {
      return;
    }
    try {
      await prisma.agentTrace.createMany({
        data: this.records.map((r) => ({
          agentKey,
          attempt,
          costUsd: r.costUsd ?? null,
          durationMs: r.durationMs,
          error: r.error ?? null,
          inputJson: r.inputJson as object | undefined,
          inputTokens: r.inputTokens ?? null,
          model: r.model ?? null,
          nodeId,
          otelSpanId: this.otelSpanId ?? null,
          otelTraceId: this.otelTraceId ?? null,
          outputJson: r.outputJson as object | undefined,
          outputTokens: r.outputTokens ?? null,
          runId,
          seq: r.seq,
          toolName: r.toolName ?? null,
          type: r.type,
        })),
      });
    } catch {
      // Tracing is best-effort — never block the workflow
    }
  }
}
