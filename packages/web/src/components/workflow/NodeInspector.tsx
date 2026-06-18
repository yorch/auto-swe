'use client';

/**
 * NodeInspector — right rail of the TemplateEditor. Schema-aware editor for
 * the selected node: rename/delete header, per-type config sections, outgoing
 * edge dropdowns, and a raw-JSON escape hatch. Extracted from
 * TemplateEditor.tsx.
 */

import type { Node as SpecNode, StepMetadata } from '@auto-swe/shared/workflow';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { type HandleKind, handleKindsFor } from './dagNode';
import { type Binding, InputsBindingsSection } from './inspectorFields';
import {
  AgentSection,
  CondSection,
  ContainerStepSection,
  FanOutSection,
  McpSection,
  SetSection,
  ShellSection,
  SignalSection,
  StepConfigSection,
  TerminateSection,
} from './inspectorSections';

interface InspectorProps {
  nodeId: string | null;
  node: SpecNode | null;
  stepMeta: StepMetadata | null | undefined;
  stepRegistry: StepMetadata[];
  isEntry: boolean;
  allNodeIds: string[];
  onChangeNode: (next: SpecNode) => void;
  onRename: (oldId: string, newId: string) => void;
  onDelete: () => void;
}

const HANDLE_LABEL_FULL: Record<HandleKind, string> = {
  join: 'Join',
  next: 'Next',
  onApprove: 'On approve',
  onFalse: 'On false',
  onReceive: 'On receive',
  onReject: 'On reject',
  onSubmit: 'On submit',
  onTimeout: 'On timeout',
  onTrue: 'On true',
  subgraph: 'Subgraph',
};

export function NodeInspector({
  nodeId,
  node,
  stepMeta,
  stepRegistry,
  isEntry,
  allNodeIds,
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
                if (v && v !== nodeId) {
                  onRename(nodeId, v);
                }
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
            onChange={onChangeNode}
            stepMeta={stepMeta ?? null}
            stepRegistry={stepRegistry}
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
        {node.type === 'fanOut' && <FanOutSection node={node} onChange={onChangeNode} />}
        {node.type === 'shell' && <ShellSection node={node} onChange={onChangeNode} />}
        {node.type === 'agent' && <AgentSection node={node} onChange={onChangeNode} />}
        {node.type === 'mcp' && <McpSection node={node} onChange={onChangeNode} />}
        {node.type === 'containerStep' && (
          <ContainerStepSection node={node} onChange={onChangeNode} />
        )}
        {(node.type === 'step' ||
          node.type === 'shell' ||
          node.type === 'agent' ||
          node.type === 'mcp' ||
          node.type === 'containerStep') && (
          <InputsBindingsSection
            inputs={(node as { inputs?: Record<string, Binding> }).inputs}
            onChange={(inputs) => onChangeNode({ ...node, inputs } as SpecNode)}
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

        {/* Outgoing-edge connections — explicit dropdowns alongside the
            canvas drag-to-connect. On big graphs with tiny nodes the
            dropdowns are often the only practical way to retarget an edge. */}
        <EdgeConnectionsSection
          allNodeIds={allNodeIds}
          node={node}
          nodeId={nodeId}
          onSetEdge={(field, target) => {
            const patched = { ...(node as unknown as Record<string, unknown>) };
            if (target) {
              patched[field] = target;
            } else {
              delete patched[field];
            }
            onChangeNode(patched as unknown as SpecNode);
          }}
        />

        {/* Raw JSON escape hatch */}
        <details className="mt-6 border-t border-ink-600 pt-4">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 hover:text-paper-200">
            Raw JSON
          </summary>
          <div className="mt-2 flex items-center justify-end">
            <CopyButton value={JSON.stringify(node, null, 2)} />
          </div>
          <pre className="mt-1 max-h-48 overflow-auto rounded-sm border border-ink-600 bg-ink-900 p-2 font-mono text-[10px] text-paper-300">
            {JSON.stringify(node, null, 2)}
          </pre>
        </details>
      </div>
    </aside>
  );
}

function EdgeConnectionsSection({
  node,
  nodeId,
  allNodeIds,
  onSetEdge,
}: {
  node: SpecNode;
  nodeId: string;
  allNodeIds: string[];
  onSetEdge: (field: HandleKind, target: string | null) => void;
}) {
  const handles = handleKindsFor(node);
  if (handles.length === 0) {
    return null;
  }
  const otherIds = allNodeIds.filter((id) => id !== nodeId);
  const nodeRecord = node as unknown as Record<string, unknown>;

  return (
    <div className="mt-6 space-y-3 border-t border-ink-600 pt-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
        Outgoing edges
      </div>
      {handles.map((kind) => {
        const current = (nodeRecord[kind] as string | undefined) ?? '';
        const selectId = `edge-${kind}`;
        return (
          <Select
            className="h-9 px-2 font-mono text-xs"
            id={selectId}
            key={kind}
            label={HANDLE_LABEL_FULL[kind]}
            onChange={(e) => onSetEdge(kind, e.target.value || null)}
            value={current}
          >
            <option value="">— none —</option>
            {otherIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        );
      })}
    </div>
  );
}
