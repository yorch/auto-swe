import { randomUUID } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import type { NodeTag } from '../workflows/nodeTag.js';
import { nodeTagColumns } from './activityNodeTag.js';

// Raised from 4 KB — a single bash output or file read commonly exceeds the
// old limit and was silently destroyed. 32 KB preserves almost all real
// payloads while keeping individual rows manageable.
const MAX_JSON_CHARS = 32_000;

/** Keys that commonly carry credentials or session material (normalized form). */
const SENSITIVE_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'client_secret',
  'cookie',
  'credentials',
  'password',
  'private_key',
  'refresh_token',
  'secret',
  'token',
  'x_api_key',
]);

/**
 * Normalized key suffixes that mean "credential": `aws_secret_access_key`
 * ends with `access_key`, `next_page_token` with `_token`. Deliberately no
 * bare `_key`/`key` suffix — `tool_key`, `max_tokens`, `input_tokens`,
 * `budget_tokens`, `total_tokens` and the like are not secrets.
 */
const SENSITIVE_KEY_SUFFIXES = [
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'access_key',
  'private_key',
  '_token',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/-/g, '_');
  return SENSITIVE_KEYS.has(k) || SENSITIVE_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

export function redactString(s: string): string {
  // URLs with embedded credentials: https://user:pass@host/…
  let out = s.replace(/(\/\/)[^/:@]+:[^/@]+@/g, '$1***:***@');
  // Authorization headers / bearer tokens in common formats.
  out = out.replace(/(Authorization\s*[:=]\s*(?:Bearer|Basic|Token)\s+)[^\s\r\n]+/gi, '$1***');
  // Loose key-name assignments carrying a credential value.
  out = out.replace(
    /((?:api[_-]?key|apikey|token|secret|access[_-]?token|secret[_-]?access[_-]?key|private[_-]?key|password|credentials)\s*[:=]\s*)[^\s\r\n'"]+/gi,
    '$1***'
  );
  // Value shapes that are credentials wherever they appear.
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '***'
  );
  // Every value-shape pattern anchors on a left boundary — a secret prefix
  // inside a longer identifier (a task id, a branch name) is not a secret.
  const B = '(^|[^A-Za-z0-9_-])';
  out = out.replace(new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{20,}`, 'g'), '$1***');
  out = out.replace(new RegExp(`${B}sk-(?:proj-)?[A-Za-z0-9_-]{20,}`, 'g'), '$1***');
  out = out.replace(new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{36,}`, 'g'), '$1***');
  out = out.replace(new RegExp(`${B}github_pat_[A-Za-z0-9_]{22,}`, 'g'), '$1***');
  out = out.replace(new RegExp(`${B}xox[abprs]-[A-Za-z0-9-]{10,}`, 'g'), '$1***');
  out = out.replace(new RegExp(`${B}AKIA[0-9A-Z]{16}`, 'g'), '$1***');
  out = out.replace(new RegExp(`${B}AIza[0-9A-Za-z_-]{35}`, 'g'), '$1***');
  out = out.replace(
    new RegExp(`${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`, 'g'),
    '$1***'
  );
  return out;
}

/**
 * Redact likely secrets in a JSON value WITHOUT truncating: key-based
 * redaction plus `redactString` on every string. The transcript recorder uses
 * this — full fidelity is the point of a transcript, so unlike
 * `sanitizeJsonValues` nothing here shortens values.
 */
export function redactJsonValues(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return redactString(obj);
  }
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(redactJsonValues);
  }
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
      if (isSensitiveKey(k)) {
        if (typeof v === 'string') {
          return [k, '***'];
        }
        // An object or array under a sensitive key keeps its shape — nested
        // sensitive keys inside are still redacted on the way down.
        if (v !== null && typeof v === 'object') {
          return [k, redactJsonValues(v)];
        }
        return [k, '[REDACTED]'];
      }
      return [k, redactJsonValues(v)];
    })
  );
}

function truncateStr(s: string, max = MAX_JSON_CHARS): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Redact likely secrets, then truncate string values for persistence. */
function sanitizeJsonValues(obj: unknown): unknown {
  const redacted = redactJsonValues(obj);
  if (typeof redacted === 'string') {
    return truncateStr(redacted);
  }
  if (redacted === null || typeof redacted !== 'object') {
    return redacted;
  }
  if (Array.isArray(redacted)) {
    return redacted.map(sanitizeJsonValues);
  }
  return Object.fromEntries(
    Object.entries(redacted as Record<string, unknown>).map(([k, v]) => [k, sanitizeJsonValues(v)])
  );
}

export interface TraceRecord {
  /** Fixed when recorded, so a batch re-sent after an ambiguous failure inserts nothing twice. */
  id: string;
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
 * activity execution and persists them to `agent_traces` — at the end, and
 * optionally while it runs (see `startTraceFlushing`). `persist()` drops only
 * the records it wrote, so repeated calls never write a record twice.
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
  private recordListener?: () => void;

  /**
   * Called after every record is added. Single slot: a later call replaces the
   * listener, so only one consumer (the live flusher) can watch a tracer.
   * Returns a function that removes it. A throwing listener never breaks recording.
   */
  onRecord(listener: () => void): () => void {
    this.recordListener = listener;
    return () => {
      if (this.recordListener === listener) {
        this.recordListener = undefined;
      }
    };
  }

  private notifyRecord(): void {
    try {
      this.recordListener?.();
    } catch {
      // Recording must never fail because a flush could not be scheduled.
    }
  }

  /** Associate an OTel span with all records in this batch. */
  setSpanContext(traceId: string, spanId: string): void {
    this.otelTraceId = traceId;
    this.otelSpanId = spanId;
  }

  /** Number of records collected so far. */
  get size(): number {
    return this.records.length;
  }

  /** True once a span context has been attached; a more specific span set earlier wins. */
  hasSpanContext(): boolean {
    return this.otelTraceId !== undefined;
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
      id: randomUUID(),
      inputJson: sanitizeJsonValues(opts.inputJson),
      outputJson: opts.outputJson !== undefined ? sanitizeJsonValues(opts.outputJson) : undefined,
      seq: this.seq++,
      toolName: opts.toolName,
      type: 'tool_call',
    });
    this.notifyRecord();
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
      id: randomUUID(),
      inputJson: opts.inputJson !== undefined ? sanitizeJsonValues(opts.inputJson) : undefined,
      inputTokens: opts.inputTokens,
      model: opts.model,
      outputJson: opts.outputJson !== undefined ? sanitizeJsonValues(opts.outputJson) : undefined,
      outputTokens: opts.outputTokens,
      seq: this.seq++,
      toolName: opts.role,
      type: 'llm_response',
    });
    this.notifyRecord();
  }

  /** Summed tokens of the LLM calls recorded so far. */
  llmTokenTotals(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const r of this.records) {
      if (r.type === 'llm_response') {
        input += r.inputTokens ?? 0;
        output += r.outputTokens ?? 0;
      }
    }
    return { input, output };
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
      id: randomUUID(),
      inputJson: opts.inputJson !== undefined ? sanitizeJsonValues(opts.inputJson) : undefined,
      outputJson: opts.outputJson !== undefined ? sanitizeJsonValues(opts.outputJson) : undefined,
      seq: this.seq++,
      toolName: opts.name,
      type: 'activity_event',
    });
    this.notifyRecord();
  }

  /**
   * `runId` is undefined for workflows that keep no WorkflowRun row. Their
   * traces are still written, keyed by `workflowId`, so their LLM spend is
   * recorded somewhere rather than dropped. `teamId`/`orgId` name whose spend
   * the rows are (see `currentSpendOwner`); absent, the rows belong to nobody.
   *
   * Never throws; resolves false when the write failed, and the records stay
   * buffered for the next call. Rows are numbered from `seqOffset` in the order
   * written, so batches flushed at different times by one attempt never collide.
   */
  async persist(
    ids: {
      runId: string | undefined;
      workflowId: string;
      temporalRunId?: string | null;
      teamId?: string;
      orgId?: string;
      /** The in-app assistant reply whose turn wrote these rows. */
      assistantMessageId?: string;
    },
    nodeId: string,
    agentKey: string,
    attempt = 1,
    /** The spec node the activity was dispatched for; absent outside the interpreter. */
    nodeTag?: NodeTag,
    /** `seq` of the first record written; the rest follow it, so batches of one attempt do not collide. */
    seqOffset = 0
  ): Promise<boolean> {
    // Records added while the write is in flight stay for the next call.
    const batch = this.records.slice();
    if (batch.length === 0) {
      return true;
    }
    const node = nodeTagColumns(nodeTag);
    try {
      await prisma.agentTrace.createMany({
        data: batch.map((r, index) => ({
          ...node,
          agentKey,
          assistantMessageId: ids.assistantMessageId ?? null,
          attempt,
          costUsd: r.costUsd ?? null,
          durationMs: r.durationMs,
          error: r.error ?? null,
          id: r.id,
          inputJson: r.inputJson as object | undefined,
          inputTokens: r.inputTokens ?? null,
          model: r.model ?? null,
          nodeId,
          orgId: ids.orgId ?? null,
          otelSpanId: this.otelSpanId ?? null,
          otelTraceId: this.otelTraceId ?? null,
          outputJson: r.outputJson as object | undefined,
          outputTokens: r.outputTokens ?? null,
          runId: ids.runId ?? null,
          seq: seqOffset + index,
          teamId: ids.teamId ?? null,
          temporalRunId: ids.temporalRunId ?? null,
          toolName: r.toolName ?? null,
          type: r.type,
          workflowId: ids.workflowId,
        })),
        // A write the client saw fail may still have committed; the ids make a re-send a no-op.
        skipDuplicates: true,
      });
      this.records.splice(0, batch.length);
      return true;
    } catch {
      // Tracing is best-effort — never block the workflow
      return false;
    }
  }
}
