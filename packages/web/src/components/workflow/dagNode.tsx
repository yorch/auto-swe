'use client';

/**
 * Custom React Flow node renderer for workflow spec nodes.
 *
 * One generic component handles every spec node type (step/cond/signal/fanOut/
 * terminate/set/shell) — the type determines which output handles to expose
 * (e.g. cond renders `onTrue` + `onFalse` ports, fanOut renders `subgraph` +
 * `join`). Visual styling follows the Workshop Telemetry design system:
 * dark surface, ember accent on selection, small sans labels, optional status
 * stripe down the left for run viewers, optional diff border for diff viewers.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';
import { type DiffKind, type EdgeKind, NODE_HEIGHT, NODE_WIDTH } from '@/lib/workflowLayout';
import type { FoldedGroup } from './foldGroups';
import { nodeDisplayName, nodeGroupOf } from './nodeDisplay';
import { NODE_TYPE_TONE } from './nodeTypeTone';

/** The source-handle ids a node exposes are exactly the edge kinds the layout
 *  emits for it — one name, so the two cannot disagree. */
export type HandleKind = EdgeKind;

export interface DagNodeData {
  node: SpecNode;
  /** Live status from the run viewer overlay. */
  status?: { status: string; attempt: number };
  /** Per-node diff marker from the diff viewer. */
  diff?: DiffKind;
  /** Optional secondary label (e.g. step name, shell image). */
  subLabel?: string;
  /** When true, expose drag-to-connect handles. */
  editable?: boolean;
  /**
   * Set when this card stands for a collapsed group (see `foldGroups`) rather
   * than a spec node; `node` is then a placeholder. `ran` is how many of its
   * members the run overlay has a status for.
   */
  folded?: FoldedGroup & { ran?: number };
  [key: string]: unknown;
}

const CATEGORY_LABEL: Record<SpecNode['type'], string> = {
  agent: 'Agent',
  cond: 'Condition',
  containerStep: 'Container',
  eval: 'Eval',
  fanOut: 'Fan-out',
  humanApproval: 'Approval',
  humanDecision: 'Decision',
  humanInput: 'Input',
  humanReview: 'Review',
  mcp: 'MCP',
  set: 'Set',
  shell: 'Shell',
  signal: 'Signal',
  step: 'Step',
  terminate: 'Terminate',
};

/** Node types that run arbitrary code and need elevated authoring rights. */
const ELEVATED = new Set<SpecNode['type']>(['containerStep', 'shell']);

const STATUS_STRIPE: Record<string, string> = {
  FAILED: 'bg-brick-400',
  PASSED: 'bg-moss-400',
  PENDING: 'bg-amber-400',
  RUNNING: 'bg-dust-400',
  SKIPPED: 'bg-paper-500',
  SUCCESS: 'bg-moss-400',
};

const DIFF_BORDER: Record<DiffKind, string> = {
  added: 'border-moss-400',
  changed: 'border-amber-400',
  removed: 'border-brick-400 border-dashed',
};

/**
 * One source port per outgoing edge a node can have.
 *
 * `id` is the spec field `nodeEdges` emits for that edge, and doubles as the
 * React Flow handle id — a `humanDecision` therefore draws one port per option
 * (`options[0].next`, …) rather than a single `onSubmit`. It used to expose
 * only `onTimeout`, so every option edge named a handle the node never drew
 * and React Flow silently dropped it: a decision node rendered its timeout
 * branch and none of its actual decisions.
 *
 * `kind` stays an `EdgeKind` for colour and default label, so the option
 * ports read as the submit-coloured ports they are.
 */
export interface HandlePort {
  id: string;
  kind: HandleKind;
  label: string;
}

export function handlePortsFor(node: SpecNode): HandlePort[] {
  if (node.type === 'humanDecision') {
    return [
      port('onTimeout'),
      ...node.options.map((opt, i) => ({
        id: `options[${i}].next`,
        kind: 'onSubmit' as const,
        label: opt.label,
      })),
    ];
  }
  return handleKindsFor(node).map(port);
}

const port = (kind: HandleKind): HandlePort => ({
  id: kind,
  kind,
  label: HANDLE_LABEL[kind],
});

/** Which edge kinds does a given node type emit? */
function handleKindsFor(node: SpecNode): HandleKind[] {
  switch (node.type) {
    case 'step':
    case 'agent':
    case 'mcp':
    case 'eval':
    case 'containerStep':
    case 'set':
    case 'shell':
      return ['next'];
    case 'cond':
      return ['onTrue', 'onFalse'];
    case 'signal':
      return ['onReceive', 'onTimeout'];
    case 'fanOut':
      return ['subgraph', 'join'];
    case 'terminate':
      return [];
    case 'humanApproval':
      return ['onApprove', 'onReject', 'onTimeout'];
    case 'humanDecision':
      // Option edges are not `EdgeKind`s; `handlePortsFor` adds them.
      return ['onTimeout'];
    case 'humanInput':
    case 'humanReview':
      return ['onSubmit', 'onTimeout'];
  }
}

const HANDLE_BG: Record<HandleKind, string> = {
  join: 'bg-ember-400',
  next: 'bg-paper-400',
  onApprove: 'bg-moss-400',
  onFalse: 'bg-brick-400',
  onReceive: 'bg-dust-400',
  onReject: 'bg-brick-400',
  onSubmit: 'bg-moss-400',
  onTimeout: 'bg-amber-400',
  onTrue: 'bg-moss-400',
  subgraph: 'bg-violet-400',
};

const HANDLE_LABEL: Record<HandleKind, string> = {
  join: 'join',
  next: '→',
  onApprove: 'approve',
  onFalse: 'false',
  onReceive: 'recv',
  onReject: 'reject',
  onSubmit: 'submit',
  onTimeout: 'timeout',
  onTrue: 'true',
  subgraph: 'sub',
};

function GroupBadge({ group }: { group: string }) {
  return (
    <div className="flex">
      <span className="max-w-full truncate rounded border border-ink-500 px-1.5 text-[11px] leading-4 text-paper-400">
        {group}
      </span>
    </div>
  );
}

export function DagNode({ id, data, selected }: NodeProps) {
  const d = data as DagNodeData;
  const folded = d.folded;
  const handles: HandlePort[] = folded
    ? folded.exits.map((e) => ({ id: e.port, kind: 'next' as const, label: e.label }))
    : handlePortsFor(d.node);
  const name = folded ? folded.group : nodeDisplayName(d.node, id);
  const group = folded ? undefined : nodeGroupOf(d.node);
  const stripeClass = d.status ? STATUS_STRIPE[d.status.status] : null;
  const diffBorder = d.diff ? DIFF_BORDER[d.diff] : null;
  const isLive = d.status?.status === 'RUNNING' || d.status?.status === 'PENDING';

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-md border bg-ink-800 transition-colors',
        'border-l-[3px]',
        folded && 'border-dashed',
        NODE_TYPE_TONE[d.node.type].border,
        selected
          ? 'border-ember-400 shadow-[0_0_0_1px_var(--color-ember-400)]'
          : diffBorder
            ? diffBorder
            : 'border-ink-500'
      )}
      // Sized from the same constants dagre is fed when it computes positions,
      // rather than a local copy, so the card cannot drift out of the slot the
      // layout planned for it.
      style={{ height: NODE_HEIGHT, width: NODE_WIDTH }}
      // The id is the node's identity (edges, analytics, run history key on it),
      // so it stays reachable even when a title is what the card shows.
      title={folded ? `${folded.group}: ${folded.memberIds.join(', ')}` : id}
    >
      {/* Target handle — left edge, accepts all incoming edges */}
      <Handle
        className="!h-2 !w-2 !rounded-full !border-2 !border-ink-900 !bg-paper-500"
        id="in"
        position={Position.Left}
        type="target"
      />

      {/* Status stripe (live RUN viewer overlay) */}
      {stripeClass && (
        <div
          className={cn(
            'absolute left-0 top-0 bottom-0 w-[3px]',
            stripeClass,
            isLive && 'pulse-dot'
          )}
        />
      )}

      {/* Body */}
      <div className="flex h-full flex-col justify-center gap-1 px-3 py-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-display text-[15px] font-medium leading-none text-paper-50">
            {name}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-paper-500">
            {!folded && ELEVATED.has(d.node.type) && (
              <span className="text-brick-400" title="Elevated: runs code in a container">
                <Icon name="lock" size={11} />
              </span>
            )}
            {folded ? 'Group' : CATEGORY_LABEL[d.node.type]}
          </span>
        </div>
        {folded && (
          <div className="truncate text-[11px] text-paper-400">
            {folded.memberIds.length} steps
            {folded.ran !== undefined && ` · ${folded.ran} ran`}
          </div>
        )}
        {d.subLabel && (
          <div className="truncate font-mono text-[11px] text-paper-400">{d.subLabel}</div>
        )}
        {folded && (
          <div className="flex items-center gap-0.5 text-[11px] text-paper-500">
            <Icon name="chevronRight" size={11} />
            Expand
          </div>
        )}
        {group && !d.status && <GroupBadge group={group} />}
        {d.status && (
          <div className="text-[11px] font-medium text-ember-300">
            <span className="inline-block first-letter:uppercase">
              {d.status.status.replace(/_/g, ' ').toLowerCase()}
            </span>
            {d.status.attempt > 1 && (
              <span className="font-normal text-paper-500"> · attempt {d.status.attempt}</span>
            )}
          </div>
        )}
        {group && d.status && <GroupBadge group={group} />}
      </div>

      {/* Source handles — one per outgoing edge, stacked on the right */}
      {handles.length === 1 && (
        <Handle
          className={cn(
            '!h-2 !w-2 !rounded-full !border-2 !border-ink-900',
            HANDLE_BG[handles[0].kind]
          )}
          id={handles[0].id}
          position={Position.Right}
          type="source"
        />
      )}
      {handles.length > 1 &&
        handles.map((h, i) => {
          const top = `${((i + 1) * 100) / (handles.length + 1)}%`;
          return (
            <Handle
              className={cn('!h-2 !w-2 !rounded-full !border-2 !border-ink-900', HANDLE_BG[h.kind])}
              id={h.id}
              key={h.id}
              position={Position.Right}
              style={{ top }}
              type="source"
            />
          );
        })}

      {/* Handle labels — only visible when the node is selected, gives the
          user something to aim for when drag-connecting from a specific port. */}
      {selected && handles.length > 1 && (
        <div className="pointer-events-none absolute -right-1 top-0 bottom-0 flex flex-col justify-evenly pr-3 text-right">
          {handles.map((h) => (
            <span className="translate-x-full pl-2 text-[11px] text-paper-400" key={h.id}>
              {h.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
