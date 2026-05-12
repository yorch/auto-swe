'use client';

import type { Node, WorkflowSpec } from '@auto-swe/shared/workflow';
import { useMemo } from 'react';
import {
  type LayoutEdge,
  type LayoutNode,
  layoutSpec,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeCategoryColor,
  statusFill,
} from '@/lib/workflowLayout';

export interface DagStatusOverlay {
  /** Latest status per nodeId (after dedup by attempt). */
  byNodeId: Record<string, { status: string; attempt: number } | undefined>;
}

interface Props {
  spec: WorkflowSpec;
  /** Optional per-node status — used by the run viewer to colour live state. */
  statuses?: DagStatusOverlay;
  selectedNodeId?: string | null;
  onSelect?: (id: string | null) => void;
  /** When true, the diagram fills its container; otherwise uses natural width. */
  responsive?: boolean;
}

function edgeStrokeColor(kind: LayoutEdge['kind']): string {
  switch (kind) {
    case 'onTrue':
      return '#16a34a';
    case 'onFalse':
      return '#dc2626';
    case 'onTimeout':
      return '#d97706';
    case 'subgraph':
      return '#7c3aed';
    case 'join':
      return '#0d9488';
    default:
      return '#94a3b8';
  }
}

function nodeSubLabel(node: Node): string | null {
  switch (node.type) {
    case 'step':
      return node.step;
    case 'cond':
      return node.expr;
    case 'signal':
      return node.name;
    case 'fanOut':
      return `fanOut · ${node.itemKey ?? 'subtask'}`;
    case 'terminate':
      return `→ ${node.status}`;
    case 'set':
      return Object.keys(node.values ?? {})
        .slice(0, 3)
        .join(', ');
  }
}

function edgePath(from: LayoutNode, to: LayoutNode): string {
  const fromX = from.x + NODE_WIDTH;
  const fromY = from.y + NODE_HEIGHT / 2;
  const toX = to.x;
  const toY = to.y + NODE_HEIGHT / 2;
  const mid = (fromX + toX) / 2;
  return `M ${fromX} ${fromY} C ${mid} ${fromY}, ${mid} ${toY}, ${toX} ${toY}`;
}

export function WorkflowDag({
  spec,
  statuses,
  selectedNodeId,
  onSelect,
  responsive = true,
}: Props) {
  const layout = useMemo(() => layoutSpec(spec), [spec]);
  const padding = 24;
  const viewBox = `${-padding} ${-padding} ${layout.width + padding * 2} ${layout.height + padding * 2}`;
  const nodeIndex = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <svg
      aria-label="Workflow DAG"
      height={layout.height + padding * 2}
      role="img"
      style={{ maxWidth: '100%' }}
      viewBox={viewBox}
      width={responsive ? '100%' : layout.width + padding * 2}
    >
      <defs>
        <marker
          id="dag-arrow"
          markerHeight="6"
          markerWidth="6"
          orient="auto-start-reverse"
          refX="6"
          refY="3"
          viewBox="0 0 6 6"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" fill="#94a3b8" />
        </marker>
      </defs>

      {layout.edges.map((e) => {
        const from = nodeIndex.get(e.from);
        const to = nodeIndex.get(e.to);
        if (!from || !to) return null;
        const stroke = edgeStrokeColor(e.kind);
        return (
          <g key={`edge-${e.from}-${e.to}-${e.kind}`}>
            <path
              d={edgePath(from, to)}
              fill="none"
              markerEnd="url(#dag-arrow)"
              stroke={stroke}
              strokeWidth={1.5}
            />
          </g>
        );
      })}

      {layout.nodes.map((n) => {
        const color = nodeCategoryColor(n.node);
        const status = statuses?.byNodeId[n.id];
        const statusColor = statusFill(status?.status);
        const isSelected = n.id === selectedNodeId;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> with role=button is the conventional accessible widget pattern here
          <g
            aria-label={`workflow node ${n.id}`}
            key={n.id}
            onClick={onSelect ? () => onSelect(n.id === selectedNodeId ? null : n.id) : undefined}
            onKeyDown={
              onSelect
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(n.id === selectedNodeId ? null : n.id);
                    }
                  }
                : undefined
            }
            role={onSelect ? 'button' : undefined}
            style={{ cursor: onSelect ? 'pointer' : 'default' }}
            tabIndex={onSelect ? 0 : undefined}
            transform={`translate(${n.x}, ${n.y})`}
          >
            <rect
              fill={color.fill}
              height={NODE_HEIGHT}
              rx={8}
              stroke={isSelected ? '#0f172a' : color.stroke}
              strokeWidth={isSelected ? 2.5 : 1.5}
              width={NODE_WIDTH}
            />
            {statusColor && <rect fill={statusColor} height={NODE_HEIGHT} rx={8} width={4} />}
            <text fill={color.text} fontSize={13} fontWeight={600} x={12} y={20}>
              {n.id.length > 22 ? `${n.id.slice(0, 21)}…` : n.id}
            </text>
            <text fill={color.text} fontSize={11} opacity={0.75} x={12} y={38}>
              {nodeSubLabel(n.node) ?? n.node.type}
            </text>
            {status && (
              <text fill={color.text} fontSize={10} opacity={0.85} x={12} y={51}>
                {status.status}
                {status.attempt > 1 ? ` · attempt ${status.attempt}` : ''}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
