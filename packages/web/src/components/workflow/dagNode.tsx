'use client';

/**
 * Custom React Flow node renderer for workflow spec nodes.
 *
 * One generic component handles every spec node type (step/cond/signal/fanOut/
 * terminate/set/shell) — the type determines which output handles to expose
 * (e.g. cond renders `onTrue` + `onFalse` ports, fanOut renders `subgraph` +
 * `join`). Visual styling follows the Workshop Telemetry design system:
 * dark surface, ember accent on selection, mono micro-labels, optional status
 * stripe down the left for run viewers, optional diff border for diff viewers.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { DiffKind } from '@/lib/workflowLayout';

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 88;

/** Edge "kinds" emitted by collectEdges in workflowLayout — duplicated here
 *  so the node knows which source handle ids it must expose. */
export type HandleKind =
  | 'next'
  | 'onTrue'
  | 'onFalse'
  | 'onReceive'
  | 'onTimeout'
  | 'subgraph'
  | 'join'
  | 'onApprove'
  | 'onReject'
  | 'onSubmit';

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
  [key: string]: unknown;
}

const CATEGORY_RING: Record<SpecNode['type'], string> = {
  agent: 'border-l-indigo-400',
  cond: 'border-l-violet-400',
  fanOut: 'border-l-moss-400',
  humanApproval: 'border-l-amber-500',
  humanDecision: 'border-l-amber-500',
  humanInput: 'border-l-amber-500',
  humanReview: 'border-l-amber-500',
  mcp: 'border-l-dust-400',
  set: 'border-l-amber-400',
  shell: 'border-l-brick-400',
  signal: 'border-l-dust-400',
  step: 'border-l-ember-400',
  terminate: 'border-l-paper-500',
};

const CATEGORY_LABEL: Record<SpecNode['type'], string> = {
  agent: 'agent',
  cond: 'cond',
  fanOut: 'fan-out',
  humanApproval: 'approval',
  humanDecision: 'decision',
  humanInput: 'input',
  humanReview: 'review',
  mcp: 'mcp',
  set: 'set',
  shell: 'shell ⚠',
  signal: 'signal',
  step: 'step',
  terminate: 'terminate',
};

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

/** Which handle ids does a given node type emit? */
export function handleKindsFor(node: SpecNode): HandleKind[] {
  switch (node.type) {
    case 'step':
    case 'agent':
    case 'mcp':
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

export function DagNode({ id, data, selected }: NodeProps) {
  const d = data as DagNodeData;
  const handles = handleKindsFor(d.node);
  const stripeClass = d.status ? STATUS_STRIPE[d.status.status] : null;
  const diffBorder = d.diff ? DIFF_BORDER[d.diff] : null;
  const isLive = d.status?.status === 'RUNNING' || d.status?.status === 'PENDING';

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-sm border bg-ink-800 transition-colors',
        'border-l-[3px]',
        CATEGORY_RING[d.node.type],
        selected
          ? 'border-ember-400 shadow-[0_0_0_1px_var(--color-ember-400)]'
          : diffBorder
            ? diffBorder
            : 'border-ink-500'
      )}
      style={{ height: NODE_HEIGHT, width: NODE_WIDTH }}
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
      <div className="flex h-full flex-col justify-center gap-1 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-display text-[15px] font-medium leading-none text-paper-50">
            {id.length > 26 ? `${id.slice(0, 25)}…` : id}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-paper-500">
            {CATEGORY_LABEL[d.node.type]}
          </span>
        </div>
        {d.subLabel && (
          <div className="truncate font-mono text-[11px] text-paper-400">{d.subLabel}</div>
        )}
        {d.status && (
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ember-400">
            {d.status.status.toLowerCase()}
            {d.status.attempt > 1 && (
              <span className="text-paper-500"> · att {d.status.attempt}</span>
            )}
          </div>
        )}
      </div>

      {/* Source handles — one per outgoing edge kind, stacked on the right */}
      {handles.length === 1 && (
        <Handle
          className={cn('!h-2 !w-2 !rounded-full !border-2 !border-ink-900', HANDLE_BG[handles[0]])}
          id={handles[0]}
          position={Position.Right}
          type="source"
        />
      )}
      {handles.length > 1 &&
        handles.map((kind, i) => {
          const top = `${((i + 1) * 100) / (handles.length + 1)}%`;
          return (
            <Handle
              className={cn('!h-2 !w-2 !rounded-full !border-2 !border-ink-900', HANDLE_BG[kind])}
              id={kind}
              key={kind}
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
          {handles.map((kind) => (
            <span
              className="translate-x-full pl-2 font-mono text-[9px] uppercase tracking-[0.14em] text-paper-500"
              key={kind}
            >
              {HANDLE_LABEL[kind]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
