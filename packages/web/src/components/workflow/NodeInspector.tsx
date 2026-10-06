'use client';

/**
 * NodeInspector — right rail of the TemplateEditor. Schema-aware editor for
 * the selected node: rename/delete header, per-type config sections, outgoing
 * edge dropdowns, and a raw-JSON escape hatch. Extracted from
 * TemplateEditor.tsx.
 */

import type { Node as SpecNode, StepMetadata } from '@auto-swe/shared/workflow';
import {
  MAX_NODE_GROUP_LENGTH,
  MAX_NODE_TITLE_LENGTH,
  readNodeEdge,
  setNodeEdge,
} from '@auto-swe/shared/workflow';
import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { cn, FOCUS_RING } from '@/lib/utils';
import { type HandleKind, handlePortsFor } from './dagNode';
import {
  type Binding,
  InputsBindingsSection,
  InspectorNote,
  InspectorSection,
} from './inspectorFields';
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
import { NODE_TYPE_LABEL, NODE_TYPE_TONE } from './nodeTypeTone';
import { isEdgeFieldRequired } from './specEdits';

interface InspectorProps {
  nodeId: string | null;
  node: SpecNode | null;
  stepMeta: StepMetadata | null | undefined;
  stepRegistry: StepMetadata[];
  isEntry: boolean;
  allNodeIds: string[];
  /** Group labels already used in the spec, offered as suggestions. */
  knownGroups?: string[];
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

/**
 * Which node types the sections above configure.
 *
 * The dispatch is a chain of `node.type === …` guards, so a new node type
 * silently gets an inspector with no fields at all. Classifying every type
 * here makes that a compile error, and the `false` entries render a pointer
 * to JSON mode instead of blank space.
 */
const HAS_CONFIG_SECTION: Record<SpecNode['type'], boolean> = {
  agent: true,
  cond: true,
  containerStep: true,
  eval: false,
  fanOut: true,
  humanApproval: false,
  humanDecision: false,
  humanInput: false,
  humanReview: false,
  mcp: true,
  set: true,
  shell: true,
  signal: true,
  step: true,
  terminate: true,
};

export function NodeInspector({
  nodeId,
  node,
  stepMeta,
  stepRegistry,
  isEntry,
  allNodeIds,
  knownGroups,
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
      <aside
        aria-label="Node inspector"
        className="flex w-80 flex-col items-center justify-center border-l border-ink-600 bg-ink-950 px-6"
      >
        <EmptyState
          hint="Select a node on the canvas to edit it, or add one from the palette."
          icon="canvas"
          title="No node selected"
        />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Node inspector"
      className="flex w-80 flex-col overflow-hidden border-l border-ink-600 bg-ink-950"
    >
      <header className="space-y-3 border-b border-ink-600 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn('h-2 w-2 shrink-0 rounded-full', NODE_TYPE_TONE[node.type].swatch)}
          />
          <h2 className="text-sm font-semibold text-paper-100">
            {NODE_TYPE_LABEL[node.type]} node
          </h2>
          {isEntry && (
            <Badge title="The workflow starts here" tone="ember" variant="outline">
              First step
            </Badge>
          )}
          <Button
            aria-label={`Delete node ${nodeId}`}
            className="ml-auto px-2 hover:text-brick-400"
            disabled={isEntry}
            onClick={onDelete}
            size="sm"
            title={isEntry ? 'The first step cannot be deleted' : 'Delete node'}
            variant="ghost"
          >
            <Icon name="trash" size={14} />
          </Button>
        </div>
        <Input
          className="font-mono text-xs"
          compact
          hint="Renaming updates every reference to it"
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
      </header>

      <div className="flex-1 overflow-y-auto pb-4 [&>section:first-child]:border-t-0">
        <NodeMetaFields
          knownGroups={knownGroups}
          node={node}
          nodeId={nodeId}
          onChange={onChangeNode}
        />

        {HAS_CONFIG_SECTION[node.type] && (
          <InspectorSection title="Configuration">
            <NodeConfig
              node={node}
              onChangeNode={onChangeNode}
              stepMeta={stepMeta}
              stepRegistry={stepRegistry}
            />
          </InspectorSection>
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
        {!HAS_CONFIG_SECTION[node.type] && (
          <InspectorSection title="Configuration">
            <InspectorNote>
              There are no form fields for this node type yet. Edit its settings in JSON mode; its
              outgoing edges are below.
            </InspectorNote>
          </InspectorSection>
        )}

        {/* Outgoing-edge connections — explicit dropdowns alongside the
            canvas drag-to-connect. On big graphs with tiny nodes the
            dropdowns are often the only practical way to retarget an edge. */}
        <EdgeConnectionsSection
          allNodeIds={allNodeIds}
          node={node}
          nodeId={nodeId}
          // A handle id is the spec field the edge leaves through, and a
          // decision option's is `options[i].next` — an indexed path, not a
          // top-level key. Assigning it directly wrote a literal
          // `"options[0].next"` property onto the node and left the real
          // routing untouched, so the write goes through `setNodeEdge`.
          // `Not connected` is only offered for fields the schema lets us clear
          // (see EdgeConnectionsSection), so a null here is always safe.
          onSetEdge={(field, target) => onChangeNode(setNodeEdge(node, field, target))}
        />

        {/* Raw JSON escape hatch */}
        <details className="group border-t border-ink-600 px-4 pt-4">
          <summary
            className={cn(
              'flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-[13px] font-semibold text-paper-100 [&::-webkit-details-marker]:hidden',
              FOCUS_RING
            )}
          >
            <Icon
              className="text-paper-500 transition-transform group-open:rotate-90"
              name="chevronRight"
              size={13}
            />
            Raw JSON
          </summary>
          <div className="mt-2 flex items-center justify-end">
            <CopyButton value={JSON.stringify(node, null, 2)} />
          </div>
          <pre className="mt-1 max-h-60 overflow-auto rounded-md border border-ink-600 bg-ink-900 p-2.5 font-mono text-[11px] leading-relaxed text-paper-300">
            {JSON.stringify(node, null, 2)}
          </pre>
        </details>
      </div>
    </aside>
  );
}

/** The type-specific settings of the selected node. */
function NodeConfig({
  node,
  onChangeNode,
  stepMeta,
  stepRegistry,
}: {
  node: SpecNode;
  onChangeNode: (next: SpecNode) => void;
  stepMeta: StepMetadata | null | undefined;
  stepRegistry: StepMetadata[];
}) {
  return (
    <>
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
    </>
  );
}

const HUMAN_TYPES = new Set<SpecNode['type']>([
  'humanApproval',
  'humanDecision',
  'humanInput',
  'humanReview',
]);

/**
 * `title` and `group`: presentation-only, read by the canvas, the outline and the
 * run viewer, never by the engine. Committed on blur (like the id), and an empty
 * value removes the key rather than saving an empty string.
 *
 * The four human nodes already carry a REQUIRED title — what an approver sees in
 * the inbox — so there it can be changed but not cleared.
 */
function NodeMetaFields({
  node,
  nodeId,
  knownGroups,
  onChange,
}: {
  node: SpecNode;
  nodeId: string;
  knownGroups?: string[];
  onChange: (next: SpecNode) => void;
}) {
  const isHuman = HUMAN_TYPES.has(node.type);
  const listId = useId();
  const [title, setTitle] = useState(node.title ?? '');
  const [group, setGroup] = useState(node.group ?? '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: resync when another node is selected or the value changes underneath
  useEffect(() => {
    setTitle(node.title ?? '');
    setGroup(node.group ?? '');
  }, [nodeId, node.title, node.group]);

  const commit = (key: 'title' | 'group', raw: string) => {
    const value = raw.trim();
    if (key === 'title' && isHuman && !value) {
      setTitle(node.title ?? '');
      return;
    }
    if ((node[key] ?? '') === value) {
      return;
    }
    const next = { ...node } as Record<string, unknown>;
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    onChange(next as unknown as SpecNode);
  };

  return (
    <InspectorSection title="Details">
      <Input
        compact
        hint={
          isHuman
            ? 'Shown to approvers in the inbox, and as this node’s name on the canvas'
            : 'Shown on the canvas and in the outline instead of the ID'
        }
        label="Title"
        maxLength={isHuman ? 200 : MAX_NODE_TITLE_LENGTH}
        onBlur={(e) => commit('title', e.target.value)}
        onChange={(e) => setTitle(e.target.value)}
        value={title}
      />
      <Input
        compact
        hint="Nodes in the same group are listed together and can be collapsed"
        label="Group"
        list={listId}
        maxLength={MAX_NODE_GROUP_LENGTH}
        onBlur={(e) => commit('group', e.target.value)}
        onChange={(e) => setGroup(e.target.value)}
        value={group}
      />
      <datalist id={listId}>
        {(knownGroups ?? []).map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </InspectorSection>
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
  onSetEdge: (field: string, target: string | null) => void;
}) {
  const handles = handlePortsFor(node);
  if (handles.length === 0) {
    return null;
  }
  const otherIds = allNodeIds.filter((id) => id !== nodeId);

  return (
    <InspectorSection title="Outgoing edges">
      {handles.map((h) => {
        // An option port has no entry in HANDLE_LABEL_FULL — its label is the
        // option's own text, which says more than "submit" would anyway.
        const label = h.id === h.kind ? HANDLE_LABEL_FULL[h.kind] : h.label;
        // Most edge fields are required by the schema (every `human*` edge, a
        // decision option's `next`, both `cond` branches, …). Offering `Not connected`
        // for one of those offers a choice the spec cannot represent: it would
        // save a node that no longer parses. Don't render the option rather than
        // let the user pick it and hit a schema error on save.
        const clearable = !isEdgeFieldRequired(node, h.id);
        return (
          <Select
            compact
            id={`edge-${h.id}`}
            key={h.id}
            label={label}
            onChange={(v) => onSetEdge(h.id, v || null)}
            options={[
              ...(clearable ? [{ label: 'Not connected', value: '' }] : []),
              ...otherIds.map((id) => ({ label: id, value: id })),
            ]}
            value={readNodeEdge(node, h.id) ?? ''}
          />
        );
      })}
    </InspectorSection>
  );
}
