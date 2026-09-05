'use client';

import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { formatDuration, formatTokens } from '@/lib/utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  bash: 'bash',
  listDirectory: 'ls',
  readFile: 'read',
  writeFile: 'write',
};

// Type glyph — colored chip labelling the trace event kind
const TYPE_GLYPH: Record<string, { label: string; color: string; bg: string }> = {
  activity_event: {
    bg: 'oklch(0.78 0.11 80 / 0.14)',
    color: 'var(--color-amber-400)',
    label: 'event',
  },
  llm_response: { bg: 'oklch(0.66 0.11 235 / 0.14)', color: 'var(--color-dust-400)', label: 'llm' },
  tool_call: { bg: 'oklch(0.66 0 0 / 0.12)', color: 'var(--color-paper-500)', label: 'tool' },
};

/** Strip provider prefix from a model spec: `anthropic/claude-opus-4-8` → `claude-opus-4-8` */
function modelShortName(model: string): string {
  return model.split('/').at(-1) ?? model;
}

function traceSummary(trace: AgentTraceRecord): { label: string; detail: string } {
  const input = trace.inputJson as Record<string, unknown> | null;
  const name = trace.toolName ?? '';

  if (trace.type === 'llm_response') {
    const modelLabel = trace.model ? modelShortName(trace.model) : null;
    return {
      detail: modelLabel ?? trace.agentKey,
      label: name || trace.agentKey,
    };
  }

  if (trace.type === 'activity_event') {
    const output = trace.outputJson as Record<string, unknown> | null;
    let detail = '';
    if (name === 'tdd.test_run' && output) {
      detail = output.passed
        ? `pass ${output.passing}/${output.total}`
        : `fail ${output.failing}/${output.total ?? 0}`;
    } else if ((name === 'pr.created' || name === 'pr.updated') && output) {
      detail = output.prUrl ? String(output.prUrl) : `#${output.prNumber}`;
    } else if (name === 'git.commit_push' && output) {
      detail = String(output.headSha ?? '').slice(0, 8);
    } else if (name === 'lessons.retrieved' && output) {
      detail = `${output.count} lesson${Number(output.count) !== 1 ? 's' : ''}`;
    }
    return { detail, label: TOOL_LABELS[name] ?? name };
  }

  const label = TOOL_LABELS[name] ?? (name || 'call');
  if (!input) {
    return { detail: '', label };
  }
  if (name === 'readFile' || name === 'writeFile') {
    return { detail: String(input.path ?? ''), label };
  }
  if (name === 'listDirectory') {
    return { detail: String(input.path ?? '.'), label };
  }
  if (name === 'bash') {
    return { detail: String(input.command ?? '').slice(0, 80), label };
  }
  return { detail: '', label };
}

const OUTPUT_TEXT_FIELDS = ['text', 'output', 'content', 'listing', 'result'] as const;

// ── CollapsibleSection ────────────────────────────────────────────────────────

function CollapsibleSection({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        className="flex items-center gap-1 text-paper-500 hover:text-paper-300 transition-colors mb-1"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '0.08em' }}
        type="button"
      >
        <span style={{ fontSize: '7px' }}>{open ? '▼' : '▶'}</span>
        {label.toUpperCase()}
      </button>
      {open && children}
    </div>
  );
}

// ── Trace body blocks ─────────────────────────────────────────────────────────

const BODY_LIMIT = 3000;

/**
 * The mono block every trace body renders into.
 *
 * `radius` is a prop only because the call sites disagree: four round to 2px
 * and the tool_call fallback branch to 6px. That divergence predates this
 * component; collapsing it changes what the page renders, so it is a design
 * call rather than part of extracting the duplicate markup.
 */
function TracePre({ children, radius }: { children: ReactNode; radius: '2px' | '6px' }) {
  return (
    <pre
      className="overflow-x-auto max-h-48 whitespace-pre-wrap break-all text-paper-400 p-2.5"
      style={{
        background: 'var(--color-ink-900)',
        border: '1px solid var(--color-ink-500)',
        borderRadius: radius,
        fontFamily: 'var(--font-mono)',
        fontSize: '10px',
        lineHeight: 1.5,
      }}
    >
      {children}
    </pre>
  );
}

/** Caps a body at `BODY_LIMIT`, marking the cut with a trailing ellipsis line. */
function capped(text: string): string {
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}\n…` : text;
}

/**
 * The red banner carrying `trace.error`.
 *
 * `tone` mirrors the same pre-existing divergence as `TracePre`'s `radius`:
 * the activity_event branch tints with oklch at 2px, the fallback branch with
 * an rgba brick-400 at 6px, and the two reds are not the same red.
 */
function TraceErrorBanner({ children, tone }: { children: ReactNode; tone: 'oklch' | 'brick' }) {
  const oklch = tone === 'oklch';
  return (
    <div
      className="text-brick-400 px-2 py-1.5"
      style={{
        background: oklch ? 'oklch(0.64 0.17 28 / 0.09)' : 'rgba(255, 122, 122, 0.09)',
        border: oklch
          ? '1px solid oklch(0.64 0.17 28 / 0.3)'
          : '1px solid rgba(255, 122, 122, 0.3)',
        borderRadius: oklch ? '2px' : '6px',
        fontFamily: 'var(--font-mono)',
        fontSize: '10px',
      }}
    >
      {children}
    </div>
  );
}

// ── TruncatedText ─────────────────────────────────────────────────────────────

const TRUNCATE_LIMIT = 2000;

function TruncatedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isTruncated = text.length > TRUNCATE_LIMIT;
  const displayed = isTruncated && !expanded ? text.slice(0, TRUNCATE_LIMIT) : text;

  return (
    <>
      <TracePre radius="2px">
        {displayed}
        {isTruncated && !expanded ? '…' : ''}
      </TracePre>
      {isTruncated && (
        <button
          className="text-dust-400 hover:text-dust-300 transition-colors mt-0.5"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}
          type="button"
        >
          {expanded ? 'show less' : `show more (${text.length - TRUNCATE_LIMIT} more chars)`}
        </button>
      )}
    </>
  );
}

// ── TraceOutput ───────────────────────────────────────────────────────────────

function TraceOutput({ trace }: { trace: AgentTraceRecord }) {
  const output = trace.outputJson as Record<string, unknown> | null;
  const input = trace.inputJson as Record<string, unknown> | null;

  // For llm_response records with systemPrompt/userMessage in inputJson: show
  // a collapsible "Request" section (system + user) and a "Response" section.
  if (
    trace.type === 'llm_response' &&
    typeof input === 'object' &&
    input !== null &&
    'systemPrompt' in input
  ) {
    const systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt : null;
    const userMessage = typeof input.userMessage === 'string' ? input.userMessage : null;
    const outputText = output
      ? ((OUTPUT_TEXT_FIELDS.map((k) => output[k]).find((v) => typeof v === 'string') as
          | string
          | undefined) ?? JSON.stringify(output, null, 2))
      : null;

    const hasRequest = systemPrompt !== null || userMessage !== null;
    const hasResponse = Boolean(outputText) || Boolean(trace.error);

    if (!hasRequest && !hasResponse) {
      return null;
    }

    return (
      <div className="mt-2 space-y-2">
        {trace.error && <TraceErrorBanner tone="oklch">{trace.error}</TraceErrorBanner>}
        {hasRequest && (
          <CollapsibleSection defaultOpen={false} label="Request">
            <div className="space-y-1.5">
              {systemPrompt !== null && (
                <div>
                  <div
                    className="text-paper-600 mb-0.5"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}
                  >
                    system
                  </div>
                  <TruncatedText text={systemPrompt} />
                </div>
              )}
              {userMessage !== null && (
                <div>
                  <div
                    className="text-paper-600 mb-0.5"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}
                  >
                    user
                  </div>
                  <TruncatedText text={userMessage} />
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}
        {outputText && (
          <CollapsibleSection defaultOpen={true} label="Response">
            <TracePre radius="2px">{capped(outputText)}</TracePre>
          </CollapsibleSection>
        )}
      </div>
    );
  }

  // For activity_event records: show inputJson (if present) above the output.
  if (trace.type === 'activity_event') {
    const inputText = input ? JSON.stringify(input, null, 2) : null;
    const outputText = output
      ? ((OUTPUT_TEXT_FIELDS.map((k) => output[k]).find((v) => typeof v === 'string') as
          | string
          | undefined) ?? JSON.stringify(output, null, 2))
      : null;

    const hasContent = Boolean(trace.error) || inputText !== null || outputText !== null;
    if (!hasContent) {
      return null;
    }

    return (
      <div className="mt-2 space-y-1.5">
        {trace.error && <TraceErrorBanner tone="oklch">{trace.error}</TraceErrorBanner>}
        {inputText && (
          <div>
            <div
              className="text-paper-600 mb-0.5"
              style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}
            >
              INPUT
            </div>
            <TracePre radius="2px">{capped(inputText)}</TracePre>
          </div>
        )}
        {outputText && <TracePre radius="2px">{capped(outputText)}</TracePre>}
      </div>
    );
  }

  // Default: show outputJson only (tool_call and fallback)
  const text = output
    ? ((OUTPUT_TEXT_FIELDS.map((k) => output[k]).find((v) => typeof v === 'string') as
        | string
        | undefined) ?? JSON.stringify(output, null, 2))
    : null;

  if (!trace.error && !text) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1.5">
      {trace.error && <TraceErrorBanner tone="brick">{trace.error}</TraceErrorBanner>}
      {text && <TracePre radius="6px">{capped(text)}</TracePre>}
    </div>
  );
}

// ── TokenCostChip ─────────────────────────────────────────────────────────────

function TokenCostChip({ trace }: { trace: AgentTraceRecord }) {
  if (trace.type !== 'llm_response') {
    return null;
  }
  const hasTokens = trace.inputTokens != null || trace.outputTokens != null;
  const hasCost = trace.costUsd != null;
  if (!hasTokens && !hasCost) {
    return null;
  }

  const tokenLabel = hasTokens
    ? `↑${formatTokens(trace.inputTokens ?? 0)} ↓${formatTokens(trace.outputTokens ?? 0)}`
    : null;
  const costLabel = hasCost
    ? `$${(typeof trace.costUsd === 'number' ? trace.costUsd : Number(trace.costUsd ?? 0)).toFixed(4)}`
    : null;

  return (
    <span
      className="text-paper-500 shrink-0"
      style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
    >
      {tokenLabel}
      {tokenLabel && costLabel ? ' ' : ''}
      {costLabel}
    </span>
  );
}

// ── OtelLink ──────────────────────────────────────────────────────────────────

import { grafanaUrl } from '@/lib/env';

const GRAFANA_URL = grafanaUrl();

function OtelLink({ trace }: { trace: AgentTraceRecord }) {
  if (trace.type !== 'llm_response' || !trace.otelTraceId) {
    return null;
  }
  const shortId = trace.otelTraceId.slice(0, 16);
  const titleText = trace.otelSpanId
    ? `trace: ${trace.otelTraceId}  span: ${trace.otelSpanId}`
    : `trace: ${trace.otelTraceId}`;
  const href = GRAFANA_URL
    ? `${GRAFANA_URL}/explore?left=${encodeURIComponent(JSON.stringify({ queries: [{ datasource: { type: 'tempo' }, query: trace.otelTraceId, queryType: 'traceId', refId: 'A' }] }))}`
    : null;

  const innerStyle = { fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '0.04em' };

  return href ? (
    <a
      className="text-paper-600 hover:text-dust-400 shrink-0 transition-colors"
      href={href}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      rel="noopener noreferrer"
      style={innerStyle}
      target="_blank"
      title={titleText}
    >
      {shortId}…
    </a>
  ) : (
    <span className="text-paper-600 shrink-0" style={innerStyle} title={titleText}>
      {shortId}…
    </span>
  );
}

// ── EventRow ──────────────────────────────────────────────────────────────────

function EventRow({
  trace,
  isExpanded,
  onToggle,
}: {
  trace: AgentTraceRecord;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { label, detail } = traceSummary(trace);
  const durationLabel = trace.durationMs != null ? formatDuration(trace.durationMs) : '';
  const glyph = TYPE_GLYPH[trace.type] ?? TYPE_GLYPH.tool_call;
  const hasError = Boolean(trace.error);

  return (
    <li>
      {/* biome-ignore lint/a11y/useSemanticElements: row contains nested interactive controls (links, collapse buttons) that cannot live inside a <button> */}
      <div
        aria-controls={`trace-row-${trace.id}`}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? 'Collapse trace row' : 'Expand trace row'}
        className="w-full text-left transition-colors hover:bg-ink-600/20 px-3 py-1.5 cursor-pointer"
        id={`trace-row-${trace.id}`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="flex items-center gap-2">
          {/* Disclosure caret */}
          <span
            className="shrink-0 text-paper-600 w-3 text-center"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '8px' }}
          >
            {isExpanded ? '▼' : '▶'}
          </span>

          {/* Type glyph — .tg */}
          <span
            className="shrink-0 px-1 py-px"
            style={{
              background: glyph.bg,
              borderRadius: '4px',
              color: glyph.color,
              fontFamily: 'var(--font-mono)',
              fontSize: '8.5px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {glyph.label}
          </span>

          {/* Event name */}
          <span
            className={hasError ? 'text-brick-400' : 'text-paper-200'}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 500 }}
          >
            {label}
          </span>

          {/* Detail / model */}
          {detail && (
            <span
              className="text-paper-500 truncate flex-1"
              style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
            >
              {detail}
            </span>
          )}

          {/* Right: token/cost chip + otel link + duration + error chip */}
          <div className="flex items-center gap-2 ml-auto shrink-0">
            <TokenCostChip trace={trace} />
            <OtelLink trace={trace} />
            {durationLabel && (
              <span className="text-paper-600 num" style={{ fontSize: '10px' }}>
                {durationLabel}
              </span>
            )}
            {hasError && (
              <span
                className="text-brick-400"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '0.1em' }}
              >
                ERR
              </span>
            )}
          </div>
        </div>

        {isExpanded && <TraceOutput trace={trace} />}
      </div>
    </li>
  );
}

function TraceEventList({
  traces,
  expandedId,
  onToggle,
}: {
  traces: AgentTraceRecord[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <ol>
      {traces.map((t) => (
        <EventRow
          isExpanded={expandedId === t.id}
          key={t.id}
          onToggle={() => onToggle(t.id)}
          trace={t}
        />
      ))}
    </ol>
  );
}

// ── TracesTab ─────────────────────────────────────────────────────────────────

interface TraceGroup {
  activityName: string;
  dagNodeId: string | null;
  attempt: number;
  traces: AgentTraceRecord[];
}

export function TracesTab({
  traces,
  filterNodeId,
  activityToNodeId,
  onClearFilter,
  compact = false,
}: {
  traces: AgentTraceRecord[];
  filterNodeId: string | null;
  activityToNodeId: Record<string, string>;
  onClearFilter: () => void;
  compact?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const handleToggle = useCallback(
    (id: string) => setExpandedId((prev) => (prev === id ? null : id)),
    []
  );

  const filtered = useMemo(
    () =>
      filterNodeId ? traces.filter((t) => activityToNodeId[t.nodeId] === filterNodeId) : traces,
    [traces, filterNodeId, activityToNodeId]
  );

  const groups = useMemo<TraceGroup[]>(() => {
    const seen = new Map<string, TraceGroup>();
    for (const t of filtered) {
      const key = `${t.nodeId}::${t.attempt}`;
      if (!seen.has(key)) {
        seen.set(key, {
          activityName: t.nodeId,
          attempt: t.attempt,
          dagNodeId: activityToNodeId[t.nodeId] ?? null,
          traces: [],
        });
      }
      seen.get(key)?.traces.push(t);
    }
    return [...seen.values()];
  }, [filtered, activityToNodeId]);

  if (traces.length === 0) {
    return (
      <div className="py-12 text-center text-paper-500 text-sm">
        No trace events recorded for this run.
      </div>
    );
  }

  return (
    <div>
      {!compact && filterNodeId && (
        <div
          className="flex items-center gap-2 px-4 py-2 border-b border-ink-600/50 sticky top-0 z-10"
          style={{ background: 'var(--color-ink-900)' }}
        >
          <span className="text-paper-500 text-[11px]">
            Filtered to{' '}
            <span
              className="text-paper-300 px-1.5 py-0.5"
              style={{
                background: 'var(--color-ink-600)',
                borderRadius: '5px',
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
              }}
            >
              {filterNodeId}
            </span>
          </span>
          <button
            className="text-ember-400 hover:text-ember-300 text-[11px] transition-colors"
            onClick={onClearFilter}
            type="button"
          >
            Show all
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-paper-500 text-sm">
          No trace events for this node.{' '}
          {!compact && (
            <button
              className="text-ember-400 hover:text-ember-300 transition-colors"
              onClick={onClearFilter}
              type="button"
            >
              Show all traces
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-ink-600/30">
          {groups.map((group) => (
            <div key={`${group.activityName}-${group.attempt}`}>
              {/* Group header */}
              <div
                className={`flex items-center gap-2 px-4 py-2 sticky ${
                  !compact && filterNodeId ? 'top-[33px]' : 'top-0'
                } z-[5]`}
                style={{ background: 'var(--color-ink-800)' }}
              >
                <span
                  className="text-paper-200"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 500 }}
                >
                  {group.dagNodeId ?? group.activityName}
                </span>
                {group.dagNodeId && group.dagNodeId !== group.activityName && (
                  <span
                    className="text-paper-600"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                  >
                    ({group.activityName})
                  </span>
                )}
                <span
                  className="text-paper-600"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                >
                  attempt {group.attempt}
                </span>
                <span
                  className="text-paper-600 ml-auto"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                >
                  {group.traces.length} event{group.traces.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="py-0.5">
                <TraceEventList
                  expandedId={expandedId}
                  onToggle={handleToggle}
                  traces={group.traces}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
