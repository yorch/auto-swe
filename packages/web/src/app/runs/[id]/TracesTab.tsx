'use client';

import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { type ReactNode, useCallback, useId, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { attributeTrace, type TraceLinker, traceMatchesSelection } from '@/lib/traceLinkage';
import { cn, formatCount, formatDuration, formatTokens } from '@/lib/utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  bash: 'bash',
  listDirectory: 'ls',
  readFile: 'read',
  writeFile: 'write',
};

// Type glyph — colored chip labelling the trace event kind
const TYPE_GLYPH: Record<string, { label: string; tone: BadgeTone }> = {
  activity_event: { label: 'event', tone: 'amber' },
  llm_response: { label: 'llm', tone: 'dust' },
  tool_call: { label: 'tool', tone: 'muted' },
};

/** Strip provider prefix from a model spec: `anthropic/claude-opus-5-5` → `claude-opus-5-5` */
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
        aria-expanded={open}
        className="mb-1 flex items-center gap-1 font-mono text-[9px] tracking-[0.08em] text-paper-500 transition-colors hover:text-paper-300"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        type="button"
      >
        <span className="text-[7px]">{open ? '▼' : '▶'}</span>
        {label.toUpperCase()}
      </button>
      {open && children}
    </div>
  );
}

// ── Trace body blocks ─────────────────────────────────────────────────────────

const BODY_LIMIT = 3000;

/** The mono block every trace body renders into. */
function TracePre({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-48 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-ink-500 bg-ink-900 p-2.5 font-mono text-[10px] leading-normal text-paper-400">
      {children}
    </pre>
  );
}

/**
 * Caps a body at `BODY_LIMIT`, keeping the head *and* the tail and marking the
 * cut between them.
 *
 * Head-only lost the part worth reading: a tool result that was offloaded to
 * the workspace ends with the failing line and the path its full output was
 * saved to, and a truncated LLM response ends with its conclusion. The limit
 * bounds how much is rendered; it does not have to decide which end survives.
 */
function capped(text: string): string {
  if (text.length <= BODY_LIMIT) {
    return text;
  }
  const head = Math.floor(BODY_LIMIT * 0.7);
  const tail = BODY_LIMIT - head;
  return `${text.slice(0, head)}\n… ${text.length - head - tail} characters hidden …\n${text.slice(text.length - tail)}`;
}

/**
 * A trace body capped by `capped()`, with a toggle to render all of it. The cap
 * keeps a long page responsive; it should not be the reason a payload the
 * browser already holds cannot be read.
 */
function CappedPre({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isCapped = text.length > BODY_LIMIT;
  return (
    <>
      <TracePre>{expanded ? text : capped(text)}</TracePre>
      {isCapped && (
        <button
          className="mt-0.5 font-mono text-[9px] text-dust-400 transition-colors hover:text-dust-600"
          onClick={() => setExpanded((v) => !v)}
          type="button"
        >
          {expanded ? 'show less' : `show all (${formatCount(text.length)} chars)`}
        </button>
      )}
    </>
  );
}

/** The red banner carrying `trace.error`. */
function TraceErrorBanner({ children }: { children: ReactNode }) {
  return <Alert className="px-2 py-1.5 font-mono text-[10px]">{children}</Alert>;
}

// ── TruncatedText ─────────────────────────────────────────────────────────────

const TRUNCATE_LIMIT = 2000;

function TruncatedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isTruncated = text.length > TRUNCATE_LIMIT;
  const displayed = isTruncated && !expanded ? text.slice(0, TRUNCATE_LIMIT) : text;

  return (
    <>
      <TracePre>
        {displayed}
        {isTruncated && !expanded ? '…' : ''}
      </TracePre>
      {isTruncated && (
        <button
          className="mt-0.5 font-mono text-[9px] text-dust-400 transition-colors hover:text-dust-600"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          onKeyDown={(e) => e.stopPropagation()}
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
        {trace.error && <TraceErrorBanner>{trace.error}</TraceErrorBanner>}
        {hasRequest && (
          <CollapsibleSection defaultOpen={false} label="Request">
            <div className="space-y-1.5">
              {systemPrompt !== null && (
                <div>
                  <div className="mb-0.5 font-mono text-[9px] text-paper-600">system</div>
                  <TruncatedText text={systemPrompt} />
                </div>
              )}
              {userMessage !== null && (
                <div>
                  <div className="mb-0.5 font-mono text-[9px] text-paper-600">user</div>
                  <TruncatedText text={userMessage} />
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}
        {outputText && (
          <CollapsibleSection defaultOpen={true} label="Response">
            <CappedPre text={outputText} />
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
        {trace.error && <TraceErrorBanner>{trace.error}</TraceErrorBanner>}
        {inputText && (
          <div>
            <div className="mb-0.5 font-mono text-[9px] text-paper-600">INPUT</div>
            <CappedPre text={inputText} />
          </div>
        )}
        {outputText && <CappedPre text={outputText} />}
      </div>
    );
  }

  // Default (tool_call and fallback): the call's input, then its output. The
  // row's one-line summary truncates a bash command at 80 chars and shows
  // nothing at all for other tools, so the input has to be readable here.
  const toolInputText = input ? JSON.stringify(input, null, 2) : null;
  const text = output
    ? ((OUTPUT_TEXT_FIELDS.map((k) => output[k]).find((v) => typeof v === 'string') as
        | string
        | undefined) ?? JSON.stringify(output, null, 2))
    : null;

  if (!trace.error && !text && !toolInputText) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1.5">
      {trace.error && <TraceErrorBanner>{trace.error}</TraceErrorBanner>}
      {toolInputText && (
        <div>
          <div className="mb-0.5 font-mono text-[9px] text-paper-600">INPUT</div>
          <CappedPre text={toolInputText} />
        </div>
      )}
      {text && <CappedPre text={text} />}
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
    <span className="shrink-0 font-mono text-[10px] text-paper-500">
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

  const inner = 'shrink-0 font-mono text-[9px] tracking-[0.04em] text-paper-600';

  return href ? (
    <a
      className={`${inner} transition-colors hover:text-dust-400`}
      href={href}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      rel="noopener noreferrer"
      target="_blank"
      title={titleText}
    >
      {shortId}…
    </a>
  ) : (
    <span className={inner} title={titleText}>
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
      <div className="w-full text-left transition-colors hover:bg-ink-600/20 px-3 py-1.5">
        <div className="flex items-center gap-2">
          {/* The toggle covers the summary only: the OTel link on the right and
              the expanded body's own collapse buttons cannot live inside a <button>. */}
          <button
            aria-controls={`trace-output-${trace.id}`}
            aria-expanded={isExpanded}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            onClick={onToggle}
            type="button"
          >
            {/* Disclosure caret */}
            <span className="w-3 shrink-0 text-center font-mono text-[8px] text-paper-600">
              {isExpanded ? '▼' : '▶'}
            </span>

            {/* Type glyph — .tg */}
            <Badge
              className="shrink-0 px-1 py-px text-[8.5px] tracking-[0.08em]"
              tone={glyph.tone}
              uppercase
            >
              {glyph.label}
            </Badge>

            {/* Event name */}
            <span
              className={cn(
                'font-mono text-[11px] font-medium',
                hasError ? 'text-brick-400' : 'text-paper-200'
              )}
            >
              {label}
            </span>

            {/* Detail / model */}
            {detail && (
              <span className="flex-1 truncate font-mono text-[10px] text-paper-500">{detail}</span>
            )}
          </button>

          {/* Right: token/cost chip + otel link + duration + error chip */}
          <div className="flex items-center gap-2 ml-auto shrink-0">
            <TokenCostChip trace={trace} />
            <OtelLink trace={trace} />
            {durationLabel && (
              <span className="num text-[10px] text-paper-600">{durationLabel}</span>
            )}
            {hasError && (
              <Badge className="text-[9px] tracking-[0.1em]" tone="brick" variant="text">
                ERR
              </Badge>
            )}
          </div>
        </div>

        {isExpanded && (
          <div id={`trace-output-${trace.id}`}>
            <TraceOutput trace={trace} />
          </div>
        )}
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
  /** What the group is attributed to: a recording id when recorded, else the candidate node ids. */
  nodeLabels: string[];
  /** Fan-out branch path (`fan[0]`) when the execution was recorded inside one. */
  branch: string | null;
  /** Inferred from the activity name rather than recorded; the node may be another candidate. */
  ambiguous: boolean;
  attempt: number;
  stepAttempt: number | null;
  traces: AgentTraceRecord[];
}

interface TraceSection {
  branch: string | null;
  groups: TraceGroup[];
}

export function TracesTab({
  traces,
  filterNodeId,
  linker,
  onClearFilter,
  compact = false,
  untaggedAmbiguous = false,
}: {
  traces: AgentTraceRecord[];
  filterNodeId: string | null;
  linker: TraceLinker;
  onClearFilter: () => void;
  compact?: boolean;
  /** The traces were picked for one branch execution, which an untagged trace cannot confirm. */
  untaggedAmbiguous?: boolean;
}) {
  const noteId = useId();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const handleToggle = useCallback(
    (id: string) => setExpandedId((prev) => (prev === id ? null : id)),
    []
  );

  const filtered = useMemo(
    () =>
      filterNodeId ? traces.filter((t) => traceMatchesSelection(t, filterNodeId, linker)) : traces,
    [traces, filterNodeId, linker]
  );

  // A recording-id selection names one branch; an old trace cannot say which.
  const selectionNamesBranch =
    filterNodeId !== null && !linker.specNodeIds.has(filterNodeId) && filterNodeId.includes('[');

  const sections = useMemo<TraceSection[]>(() => {
    const groups = new Map<string, TraceGroup>();
    for (const t of filtered) {
      const at = attributeTrace(t, linker);
      const key = `${at.recordingId ?? t.nodeId}::${t.stepAttempt ?? ''}::${t.attempt}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          activityName: t.nodeId,
          ambiguous:
            at.ambiguous ||
            (!at.exact && (selectionNamesBranch || untaggedAmbiguous) && at.candidates.length > 0),
          attempt: t.attempt,
          branch: at.branch,
          nodeLabels: at.recordingId ? [at.recordingId] : [...at.candidates],
          stepAttempt: t.stepAttempt,
          traces: [],
        };
        groups.set(key, group);
      }
      group.traces.push(t);
    }
    // Branches in first-seen order, each holding its groups in first-seen order.
    const bySection = new Map<string, TraceSection>();
    for (const group of groups.values()) {
      const key = group.branch ?? '';
      let section = bySection.get(key);
      if (!section) {
        section = { branch: group.branch, groups: [] };
        bySection.set(key, section);
      }
      section.groups.push(group);
    }
    return [...bySection.values()];
  }, [filtered, linker, selectionNamesBranch, untaggedAmbiguous]);

  const showBranchHeaders = sections.some((s) => s.branch !== null);
  const anyAmbiguous = sections.some((sec) => sec.groups.some((g) => g.ambiguous));

  if (traces.length === 0) {
    return <EmptyState className="py-12" title="No trace events recorded for this run." />;
  }

  return (
    <div>
      {!compact && filterNodeId && (
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-600/50 bg-ink-900 px-4 py-2">
          <span className="text-paper-500 text-[11px]">
            Filtered to{' '}
            <span className="rounded-[5px] bg-ink-600 px-1.5 py-0.5 font-mono text-[10px] text-paper-300">
              {filterNodeId}
            </span>
          </span>
          <button
            className="text-ember-400 hover:text-ember-600 text-[11px] transition-colors"
            onClick={onClearFilter}
            type="button"
          >
            Show all
          </button>
        </div>
      )}

      {anyAmbiguous && (
        <p className="border-ink-600/40 border-b px-4 py-2 text-[11px] text-amber-400" id={noteId}>
          Traces marked ambiguous were recorded before traces named their node. They are matched by
          activity name, so they may belong to another node or fan-out branch.
        </p>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          action={
            compact ? undefined : (
              <button
                className="text-ember-400 transition-colors hover:text-ember-600"
                onClick={onClearFilter}
                type="button"
              >
                Show all traces
              </button>
            )
          }
          className="py-12"
          title="No trace events for this node."
        />
      ) : (
        <div className="divide-y divide-ink-600/30">
          {sections.map((section) => (
            <div key={section.branch ?? 'no-branch'}>
              {showBranchHeaders && section.branch !== null && (
                <div
                  className="border-ink-600/40 border-y bg-ink-900 px-4 py-1.5 font-mono text-[10px] text-ember-300 uppercase tracking-wider"
                  data-testid="trace-branch"
                >
                  Branch {section.branch}
                </div>
              )}
              <div className="divide-y divide-ink-600/30">
                {section.groups.map((group) => (
                  <div
                    key={`${group.nodeLabels.join('|')}-${group.activityName}-${group.stepAttempt}-${group.attempt}`}
                  >
                    {/* Group header */}
                    <div
                      className={cn(
                        'sticky z-[5] flex items-center gap-2 bg-ink-800 px-4 py-2',
                        !compact && filterNodeId ? 'top-[33px]' : 'top-0'
                      )}
                    >
                      <span className="font-mono text-[11px] font-medium text-paper-200">
                        {group.nodeLabels.length > 0
                          ? group.nodeLabels.join(' | ')
                          : group.activityName}
                      </span>
                      {group.nodeLabels.length > 0 &&
                        !group.nodeLabels.includes(group.activityName) && (
                          <span className="font-mono text-[10px] text-paper-600">
                            ({group.activityName})
                          </span>
                        )}
                      {group.ambiguous && (
                        <span
                          aria-describedby={noteId}
                          className="rounded-[5px] bg-amber-400/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-400"
                        >
                          ambiguous
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-paper-600">
                        attempt {group.attempt}
                      </span>
                      {group.stepAttempt !== null && group.stepAttempt > 1 && (
                        <span className="font-mono text-[10px] text-paper-600">
                          · node attempt {group.stepAttempt}
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[10px] text-paper-600">
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
