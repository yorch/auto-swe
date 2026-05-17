'use client';

/**
 * TemplateEditor — visual workflow spec editor.
 *
 * Wraps React Flow with:
 *  - Left rail: <NodePalette> with primitives + step registry (drag onto canvas)
 *  - Centre:   ReactFlow canvas with drag-to-create + drag-to-connect
 *  - Right rail: schema-aware <NodeInspector> for the selected node
 *
 * The single source of truth is the `spec` prop. Edits emit through `onChange`
 * — the parent controls validation, save flow, and version management.
 * Initial node positions come from `layoutSpec`; the user can drag to refine
 * for the session but positions are not persisted in the spec (no schema
 * change required).
 */

import type {
  Node as SpecNode,
  StepFieldDef,
  StepMetadata,
  WorkflowSpec,
} from '@auto-swe/shared/workflow';
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type EdgeChange,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Node as RFNode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DagNode, type DagNodeData, type HandleKind, handleKindsFor } from './dagNode';
import { NodePalette, PALETTE_MIME, type PaletteDragKind } from './NodePalette';
import { specToFlow } from './specToFlow';

const NODE_TYPES = { dag: DagNode };

interface Props {
  spec: WorkflowSpec;
  stepRegistry: StepMetadata[];
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: WorkflowSpec) => void;
  costEstimateUsd?: number | null;
  observedCostUsd?: number | null;
  parseError?: string | null;
  /** Action bar shown above the canvas — parent supplies Save/Cancel CTAs. */
  actions?: React.ReactNode;
}

export function TemplateEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({
  spec,
  stepRegistry,
  selectedNodeId,
  onSelect,
  onChange,
  costEstimateUsd,
  observedCostUsd,
  parseError,
  actions,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const stepRegistryByName = useMemo(
    () => new Map(stepRegistry.map((s) => [s.name, s])),
    [stepRegistry]
  );

  const initial = useMemo(() => specToFlow(spec, { editable: true }), [spec]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<DagNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  // Resync when the parent spec changes (e.g. after Save, version switch,
  // starter template load). We compare ids cheaply by serializing them — for
  // <100 nodes the cost is negligible and avoids deep-equality library noise.
  const specSig = useMemo(
    () => `${Object.keys(spec.nodes).join('|')}::${spec.entry}::${JSON.stringify(spec.nodes)}`,
    [spec]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — reseed flow state only when the structural spec changes, not on every node-drag.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [specSig]);

  const nodesWithSelection = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [nodes, selectedNodeId]
  );

  /** When the user drag-connects two handles, mutate the spec to set the
   *  source node's outgoing field for that handle kind. */
  const handleConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle) return;
      const handleKind = c.sourceHandle as HandleKind;
      const sourceNode = spec.nodes[c.source];
      if (!sourceNode) return;
      const valid = handleKindsFor(sourceNode);
      if (!valid.includes(handleKind)) return;
      const patched = {
        ...(sourceNode as unknown as Record<string, unknown>),
        [handleKind]: c.target,
      };
      onChange({
        ...spec,
        nodes: {
          ...spec.nodes,
          [c.source]: patched as WorkflowSpec['nodes'][string],
        },
      });
    },
    [spec, onChange]
  );

  /** Drop-from-palette → new node in the spec at the cursor position. We
   *  don't persist position in the spec (spec is purely logical), but the
   *  newly added node will render at the drop position for this session
   *  because we'll seed an override in the local React Flow state. */
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const payloadRaw = event.dataTransfer.getData(PALETTE_MIME);
      if (!payloadRaw) return;
      let payload: PaletteDragKind;
      try {
        payload = JSON.parse(payloadRaw) as PaletteDragKind;
      } catch {
        return;
      }

      const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      const existingIds = Object.keys(spec.nodes);
      const baseName =
        payload.kind === 'step'
          ? payload.step.replace(/[^a-zA-Z0-9]/g, '_')
          : payload.kind === 'primitive'
            ? payload.nodeType
            : 'node';
      let newId = baseName;
      let counter = 2;
      while (existingIds.includes(newId)) {
        newId = `${baseName}_${counter++}`;
      }

      const newNode: SpecNode = makeDefaultNodeFor(payload);
      onChange({
        ...spec,
        nodes: { ...spec.nodes, [newId]: newNode },
      });
      onSelect(newId);

      // Override the layout-assigned position for the new node so it lands
      // where the user dropped it. This is session-local: a structural spec
      // change resets via the effect above.
      requestAnimationFrame(() => {
        setNodes((prev) => prev.map((n) => (n.id === newId ? { ...n, position: pos } : n)));
      });
    },
    [spec, onChange, onSelect, screenToFlowPosition, setNodes]
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  /** Delete handles edge removal — keeping the spec field cleared. */
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
      const removed = changes.filter(
        (c): c is Extract<EdgeChange, { type: 'remove' }> => c.type === 'remove'
      );
      if (removed.length === 0) return;
      const nextNodes = { ...spec.nodes };
      let mutated = false;
      for (const r of removed) {
        const edge = edges.find((e) => e.id === r.id);
        if (!edge?.sourceHandle) continue;
        const source = nextNodes[edge.source];
        if (!source) continue;
        const patched = { ...(source as unknown as Record<string, unknown>) };
        if (patched[edge.sourceHandle] === edge.target) {
          delete patched[edge.sourceHandle];
          nextNodes[edge.source] = patched as WorkflowSpec['nodes'][string];
          mutated = true;
        }
      }
      if (mutated) onChange({ ...spec, nodes: nextNodes });
    },
    [onEdgesChange, edges, spec, onChange]
  );

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId || selectedNodeId === spec.entry) return;
    const { [selectedNodeId]: _removed, ...rest } = spec.nodes;
    // Clear any references pointing at the deleted node.
    const cleaned = Object.fromEntries(
      Object.entries(rest).map(([nid, node]) => {
        const patched = { ...(node as unknown as Record<string, unknown>) };
        for (const k of [
          'next',
          'onTrue',
          'onFalse',
          'onReceive',
          'onTimeout',
          'subgraph',
          'join',
        ] as const) {
          if (patched[k] === selectedNodeId) delete patched[k];
        }
        return [nid, patched];
      })
    ) as WorkflowSpec['nodes'];
    onChange({ ...spec, nodes: cleaned });
    onSelect(null);
  }, [selectedNodeId, spec, onChange, onSelect]);

  const handleRename = useCallback(
    (oldId: string, newId: string) => {
      if (!newId || oldId === newId || spec.nodes[newId]) return;
      const renamed: WorkflowSpec['nodes'] = {};
      for (const [k, v] of Object.entries(spec.nodes)) {
        const patched = { ...(v as unknown as Record<string, unknown>) };
        for (const f of [
          'next',
          'onTrue',
          'onFalse',
          'onReceive',
          'onTimeout',
          'subgraph',
          'join',
        ] as const) {
          if (patched[f] === oldId) patched[f] = newId;
        }
        renamed[k === oldId ? newId : k] = patched as WorkflowSpec['nodes'][string];
      }
      onChange({
        ...spec,
        entry: spec.entry === oldId ? newId : spec.entry,
        nodes: renamed,
      });
      onSelect(newId);
    },
    [spec, onChange, onSelect]
  );

  const selectedNode = selectedNodeId ? spec.nodes[selectedNodeId] : null;
  const selectedStepMeta =
    selectedNode && selectedNode.type === 'step' ? stepRegistryByName.get(selectedNode.step) : null;

  return (
    <div className="flex h-[calc(100vh-180px)] min-h-[560px] flex-col overflow-hidden rounded-sm border border-ink-600 bg-ink-900">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-4 border-b border-ink-600 px-4 py-2">
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          <span>nodes</span>
          <span className="tabular text-paper-200">{Object.keys(spec.nodes).length}</span>
          <span className="text-ink-500">·</span>
          <span>entry</span>
          <span className="tabular text-ember-400">{spec.entry}</span>
          {costEstimateUsd != null && costEstimateUsd > 0 && (
            <>
              <span className="text-ink-500">·</span>
              <span>est</span>
              <span className="tabular text-paper-200">${costEstimateUsd.toFixed(2)}/run</span>
            </>
          )}
          {observedCostUsd != null && (
            <>
              <span className="text-ink-500">·</span>
              <span>observed</span>
              <span className="tabular text-paper-200">${observedCostUsd.toFixed(2)}/run</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </div>

      {parseError && (
        <div className="border-b border-ink-600 bg-brick-400/10 px-4 py-2 font-mono text-[11px] text-brick-400">
          ! {parseError}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden" ref={wrapperRef}>
        <NodePalette steps={stepRegistry} />

        {/* Canvas */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for HTML5 drag-and-drop wraps the React Flow canvas; the inner canvas itself is the interactive surface. */}
        <div className="relative flex-1 bg-ink-900" onDragOver={handleDragOver} onDrop={handleDrop}>
          <ReactFlow
            connectionLineStyle={{ stroke: '#e26b3c', strokeWidth: 2 }}
            edges={edges}
            fitView
            fitViewOptions={{ maxZoom: 1.2, padding: 0.2 }}
            maxZoom={2.5}
            minZoom={0.15}
            nodes={nodesWithSelection}
            nodesConnectable
            nodesDraggable
            nodeTypes={NODE_TYPES}
            onConnect={handleConnect}
            onEdgesChange={handleEdgesChange}
            onNodeClick={(_, n) => onSelect(n.id === selectedNodeId ? null : n.id)}
            onNodesChange={onNodesChange}
            onPaneClick={() => onSelect(null)}
            proOptions={{ hideAttribution: true }}
            zoomOnDoubleClick={false}
          >
            <Background color="#1f2530" gap={24} size={1.2} variant={BackgroundVariant.Dots} />
            <MiniMap
              maskColor="rgba(7,9,12,0.85)"
              nodeColor={() => '#171c26'}
              nodeStrokeColor="#2a323f"
              pannable
              style={{ background: '#0b0e13', border: '1px solid #1f2530' }}
              zoomable
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <NodeInspector
          isEntry={selectedNodeId === spec.entry}
          node={selectedNode}
          nodeId={selectedNodeId}
          onChangeNode={(next) => {
            if (!selectedNodeId) return;
            onChange({
              ...spec,
              nodes: { ...spec.nodes, [selectedNodeId]: next },
            });
          }}
          onDelete={handleDeleteNode}
          onRename={handleRename}
          stepMeta={selectedStepMeta}
        />
      </div>
    </div>
  );
}

/* ─── Inspector ─────────────────────────────────────────────────────────── */

interface InspectorProps {
  nodeId: string | null;
  node: SpecNode | null;
  stepMeta: StepMetadata | null | undefined;
  isEntry: boolean;
  onChangeNode: (next: SpecNode) => void;
  onRename: (oldId: string, newId: string) => void;
  onDelete: () => void;
}

function NodeInspector({
  nodeId,
  node,
  stepMeta,
  isEntry,
  onChangeNode,
  onRename,
  onDelete,
}: InspectorProps) {
  const [idDraft, setIdDraft] = useState(nodeId ?? '');

  useEffect(() => {
    setIdDraft(nodeId ?? '');
  }, [nodeId]);

  if (!node || !nodeId) {
    return (
      <aside className="flex w-80 flex-col items-center justify-center border-l border-ink-600 bg-ink-950/40 px-6 text-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
          ¶ Inspector
        </div>
        <p className="mt-3 text-xs leading-relaxed text-paper-400">
          Select a node on the canvas to edit its config, or drag a primitive from the palette to
          add a new one.
        </p>
      </aside>
    );
  }

  return (
    <aside className="flex w-80 flex-col overflow-hidden border-l border-ink-600 bg-ink-950/40">
      <header className="border-b border-ink-600 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
          ¶ {node.type}
          {isEntry ? ' · entry' : ''}
        </div>
        <div className="mt-1.5 flex items-end gap-2">
          <div className="flex-1">
            <Input
              hint="rename — references update automatically"
              label="Node ID"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== nodeId) onRename(nodeId, v);
              }}
              onChange={(e) => setIdDraft(e.target.value)}
              value={idDraft}
            />
          </div>
          <Button
            disabled={isEntry}
            onClick={onDelete}
            size="sm"
            title={isEntry ? 'Cannot delete the entry node' : undefined}
            variant="danger"
          >
            Delete
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* Step-specific schema-aware form */}
        {node.type === 'step' && (
          <StepConfigSection
            node={node}
            onChange={(config) => onChangeNode({ ...node, config } as SpecNode)}
            onStepChange={(step) => onChangeNode({ ...node, step } as SpecNode)}
            stepMeta={stepMeta ?? null}
          />
        )}
        {node.type === 'cond' && (
          <CondSection expr={node.expr} onChange={(expr) => onChangeNode({ ...node, expr })} />
        )}
        {node.type === 'signal' && (
          <SignalSection
            name={node.name}
            onNameChange={(name) => onChangeNode({ ...node, name })}
            onTimeoutChange={(timeout) => onChangeNode({ ...node, timeout })}
            timeout={node.timeout}
          />
        )}
        {node.type === 'fanOut' && (
          <FanOutSection
            itemKey={node.itemKey ?? 'subtask'}
            onItemKeyChange={(itemKey) => onChangeNode({ ...node, itemKey })}
            onOverFromChange={(from) => onChangeNode({ ...node, over: { from: from || '' } })}
            overFrom={'from' in node.over ? node.over.from : ''}
          />
        )}
        {node.type === 'shell' && (
          <ShellSection
            command={node.command ?? ''}
            image={node.image ?? ''}
            onCommandChange={(command) => onChangeNode({ ...node, command } as SpecNode)}
            onImageChange={(image) => onChangeNode({ ...node, image } as SpecNode)}
          />
        )}
        {node.type === 'terminate' && (
          <TerminateSection
            onChange={(status) => onChangeNode({ ...node, status })}
            status={node.status}
          />
        )}
        {node.type === 'set' && (
          <SetSection
            onChange={(values) =>
              onChangeNode({
                ...node,
                values: values as (typeof node)['values'],
              })
            }
            values={node.values ?? {}}
          />
        )}

        {/* Raw JSON escape hatch */}
        <details className="mt-6 border-t border-ink-600 pt-4">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 hover:text-paper-200">
            Raw JSON
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-sm border border-ink-600 bg-ink-900 p-2 font-mono text-[10px] text-paper-300">
            {JSON.stringify(node, null, 2)}
          </pre>
        </details>
      </div>
    </aside>
  );
}

/* ─── Per-type inspector sections ───────────────────────────────────────── */

function StepConfigSection({
  node,
  stepMeta,
  onStepChange,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'step' }>;
  stepMeta: StepMetadata | null;
  onStepChange: (name: string) => void;
  onChange: (config: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-4">
      <Input
        hint={stepMeta?.label ?? 'Reference a registered step name'}
        label="Step"
        onChange={(e) => onStepChange(e.target.value)}
        value={node.step}
      />
      {stepMeta?.description && (
        <p className="text-[11px] leading-relaxed text-paper-400">{stepMeta.description}</p>
      )}
      {stepMeta && stepMeta.configFields.length > 0 && (
        <SchemaAwareForm
          fields={stepMeta.configFields}
          onChange={(k, v) => {
            const cur = node.config ?? {};
            const next = { ...cur };
            if (v === undefined) delete next[k];
            else next[k] = v;
            onChange(next);
          }}
          values={(node.config ?? {}) as Record<string, unknown>}
        />
      )}
      {!stepMeta && (
        <p className="font-mono text-[10px] uppercase tracking-wider text-amber-400">
          ! Step not in registry — config schema unknown
        </p>
      )}
    </div>
  );
}

function CondSection({ expr, onChange }: { expr: string; onChange: (v: string) => void }) {
  return (
    <Input
      hint="JS-like expression evaluated against the workflow context"
      label="Expression"
      onChange={(e) => onChange(e.target.value)}
      placeholder="ctx.foo === 'bar'"
      value={expr}
    />
  );
}

function SignalSection({
  name,
  timeout,
  onNameChange,
  onTimeoutChange,
}: {
  name: string;
  timeout: string;
  onNameChange: (v: string) => void;
  onTimeoutChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Input
        label="Signal name"
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="e.g. human.approval"
        value={name}
      />
      <Input
        hint="Duration string — fires onTimeout if exceeded"
        label="Timeout"
        onChange={(e) => onTimeoutChange(e.target.value)}
        placeholder="24h"
        value={timeout}
      />
    </div>
  );
}

function FanOutSection({
  itemKey,
  overFrom,
  onItemKeyChange,
  onOverFromChange,
}: {
  itemKey: string;
  overFrom: string;
  onItemKeyChange: (v: string) => void;
  onOverFromChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Input
        hint="Context path that yields the parallel items (array)"
        label="Over (from path)"
        onChange={(e) => onOverFromChange(e.target.value)}
        placeholder="ctx.targets"
        value={overFrom}
      />
      <Input
        hint="Name each element is bound under inside the per-branch context"
        label="Item key"
        onChange={(e) => onItemKeyChange(e.target.value)}
        placeholder="subtask"
        value={itemKey}
      />
    </div>
  );
}

function ShellSection({
  image,
  command,
  onImageChange,
  onCommandChange,
}: {
  image: string;
  command: string;
  onImageChange: (v: string) => void;
  onCommandChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-sm border border-brick-400/40 bg-brick-400/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-brick-400">
        ⚠ shell — elevated privileges · team-admin authoring only
      </div>
      <Input
        hint="Must be on the team's image allowlist"
        label="Container image"
        onChange={(e) => onImageChange(e.target.value)}
        placeholder="node:24-alpine"
        value={image}
      />
      <div>
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
          htmlFor="shell-command"
        >
          Command
        </label>
        <textarea
          className="mt-1.5 h-24 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none placeholder:text-paper-600 focus:border-ember-400"
          id="shell-command"
          onChange={(e) => onCommandChange(e.target.value)}
          placeholder="echo hello"
          spellCheck={false}
          value={command}
        />
      </div>
    </div>
  );
}

type TerminateStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED';

function TerminateSection({
  status,
  onChange,
}: {
  status: TerminateStatus;
  onChange: (v: TerminateStatus) => void;
}) {
  return (
    <div>
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
        htmlFor="terminate-status"
      >
        Status
      </label>
      <select
        className="mt-1.5 h-10 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none focus:border-ember-400"
        id="terminate-status"
        onChange={(e) => onChange(e.target.value as TerminateStatus)}
        value={status}
      >
        {(['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED'] satisfies TerminateStatus[]).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}

function SetSection({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState(JSON.stringify(values, null, 2));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(JSON.stringify(values, null, 2));
  }, [values]);

  return (
    <div>
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
        htmlFor="set-values"
      >
        Values (JSON)
      </label>
      <textarea
        className="mt-1.5 h-40 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none placeholder:text-paper-600 focus:border-ember-400"
        id="set-values"
        onBlur={() => {
          try {
            const parsed = JSON.parse(draft);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              setErr(null);
              onChange(parsed as Record<string, unknown>);
            } else {
              setErr('Must be a JSON object');
            }
          } catch (e) {
            setErr(e instanceof Error ? e.message : 'invalid JSON');
          }
        }}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        value={draft}
      />
      {err && (
        <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-brick-400">
          ! {err}
        </div>
      )}
    </div>
  );
}

function SchemaAwareForm({
  fields,
  values,
  onChange,
}: {
  fields: ReadonlyArray<StepFieldDef>;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-3 border-t border-ink-600 pt-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">Config</div>
      {fields.map((f) => {
        const current = values[f.key];
        return (
          <SchemaField field={f} key={f.key} onChange={(v) => onChange(f.key, v)} value={current} />
        );
      })}
    </div>
  );
}

function SchemaField({
  field,
  value,
  onChange,
}: {
  field: StepFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `cfg-${field.key}`;
  const baseInput =
    'h-9 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400';

  return (
    <div className="space-y-1">
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
        htmlFor={id}
      >
        <span className="text-paper-200">{field.key}</span>
        {field.required && <span className="text-brick-400"> *</span>}
        <span className="ml-2 text-paper-500">— {field.label}</span>
      </label>
      {field.type === 'boolean' ? (
        <label className="inline-flex items-center gap-2 text-xs text-paper-200" htmlFor={id}>
          <input
            checked={Boolean(value)}
            className="h-4 w-4 accent-ember-400"
            id={id}
            onChange={(e) => onChange(e.target.checked)}
            type="checkbox"
          />
          enabled
        </label>
      ) : field.type === 'number' ? (
        <input
          className={baseInput}
          id={id}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? undefined : Number(v));
          }}
          type="number"
          value={typeof value === 'number' ? value : ''}
        />
      ) : field.type === 'enum' ? (
        <select
          className={baseInput}
          id={id}
          onChange={(e) => onChange(e.target.value || undefined)}
          value={typeof value === 'string' ? value : ''}
        >
          <option value="">— none —</option>
          {(field.enumValues ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : field.type === 'json' ? (
        <textarea
          className="h-20 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 py-1 font-mono text-[11px] text-paper-100 outline-none focus:border-ember-400"
          id={id}
          onChange={(e) => {
            const t = e.target.value;
            if (t === '') return onChange(undefined);
            try {
              onChange(JSON.parse(t));
            } catch {
              onChange(t);
            }
          }}
          spellCheck={false}
          value={
            value === undefined || value === null
              ? ''
              : typeof value === 'string'
                ? value
                : JSON.stringify(value, null, 2)
          }
        />
      ) : (
        <input
          className={baseInput}
          id={id}
          onChange={(e) => onChange(e.target.value || undefined)}
          type="text"
          value={typeof value === 'string' ? value : ''}
        />
      )}
      {field.description && (
        <p className="text-[10px] leading-snug text-paper-500">{field.description}</p>
      )}
    </div>
  );
}

/* ─── Defaults for newly created nodes ──────────────────────────────────── */

function makeDefaultNodeFor(payload: PaletteDragKind): SpecNode {
  if (payload.kind === 'step') {
    return { step: payload.step, type: 'step' } as SpecNode;
  }
  switch (payload.nodeType) {
    case 'step':
      return { step: '', type: 'step' } as SpecNode;
    case 'cond':
      return { expr: 'true', onFalse: '', onTrue: '', type: 'cond' } as SpecNode;
    case 'signal':
      return {
        name: '',
        onReceive: '',
        onTimeout: '',
        timeout: '1h',
        type: 'signal',
      } as SpecNode;
    case 'fanOut':
      return {
        itemKey: 'subtask',
        join: '',
        onBranchFail: 'block',
        over: { from: '' },
        subgraph: '',
        type: 'fanOut',
      } as SpecNode;
    case 'set':
      return { type: 'set', values: {} } as SpecNode;
    case 'shell':
      return { command: '', image: 'node:24-alpine', type: 'shell' } as SpecNode;
    case 'terminate':
      return { status: 'SUCCESS', type: 'terminate' } as SpecNode;
  }
}
