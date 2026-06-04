import { prisma } from '@auto-swe/shared/db';

const MAX_JSON_CHARS = 4_000;

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
}

/**
 * Collects tool-call, LLM-response, and activity events during a single agent
 * activity execution and persists them to `agent_traces` when done.
 *
 * Best-effort: `persist()` swallows DB errors so tracing never breaks runs.
 */
export class AgentTracer {
  private records: TraceRecord[] = [];
  private seq = 0;

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

  /** Record a structured LLM response (non-tool-calling agents: reviewers, security, planner, etc.). */
  addLlmResponse(opts: {
    role?: string;
    inputJson?: unknown;
    outputJson?: unknown;
    durationMs: number;
    error?: string;
  }): void {
    this.records.push({
      durationMs: opts.durationMs,
      error: opts.error,
      inputJson: opts.inputJson !== undefined ? truncateJsonValues(opts.inputJson) : undefined,
      outputJson: opts.outputJson !== undefined ? truncateJsonValues(opts.outputJson) : undefined,
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
    agentRole: string,
    attempt = 1
  ): Promise<void> {
    if (!runId || this.records.length === 0) {
      return;
    }
    try {
      await prisma.agentTrace.createMany({
        data: this.records.map((r) => ({
          agentRole,
          attempt,
          durationMs: r.durationMs,
          error: r.error ?? null,
          inputJson: r.inputJson as object | undefined,
          nodeId,
          outputJson: r.outputJson as object | undefined,
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
