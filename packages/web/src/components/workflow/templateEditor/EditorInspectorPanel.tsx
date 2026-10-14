import type { Node as SpecNode, StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import type { RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';
import { NodeInspector } from '../NodeInspector';

interface EditorInspectorPanelProps {
  spec: WorkflowSpec;
  stepRegistry: StepMetadata[];
  selectedNodeId: string | null;
  selectedNode: SpecNode | null;
  selectedStepMeta: StepMetadata | null | undefined;
  knownGroups: string[];
  inspectorRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string | null) => void;
  onChange: (next: WorkflowSpec) => void;
  onDelete: () => void;
  onRename: (oldId: string, newId: string) => void;
}

/** Inspector: a column from lg up; below it, a sheet over the canvas while a node is selected. */
export function EditorInspectorPanel({
  spec,
  stepRegistry,
  selectedNodeId,
  selectedNode,
  selectedStepMeta,
  knownGroups,
  inspectorRef,
  onSelect,
  onChange,
  onDelete,
  onRename,
}: EditorInspectorPanelProps) {
  return (
    <div
      className={cn(
        'z-20 h-full max-w-full flex-col shadow-xl lg:static lg:flex lg:shadow-none [&>aside]:min-h-0 [&>aside]:max-w-full [&>aside]:flex-1',
        selectedNode ? 'absolute inset-y-0 right-0 flex' : 'hidden'
      )}
      ref={inspectorRef}
    >
      {selectedNode && (
        <div className="flex justify-end border-b border-ink-600 border-l bg-ink-950 px-3 py-1.5 lg:hidden">
          <Button onClick={() => onSelect(null)} size="sm" variant="ghost">
            <Icon name="close" size={13} />
            Close inspector
          </Button>
        </div>
      )}
      <NodeInspector
        allNodeIds={Object.keys(spec.nodes)}
        isEntry={selectedNodeId === spec.entry}
        knownGroups={knownGroups}
        node={selectedNode}
        nodeId={selectedNodeId}
        onChangeNode={(next) => {
          if (!selectedNodeId) {
            return;
          }
          onChange({
            ...spec,
            nodes: { ...spec.nodes, [selectedNodeId]: next },
          });
        }}
        onDelete={onDelete}
        onRename={onRename}
        stepMeta={selectedStepMeta}
        stepRegistry={stepRegistry}
      />
    </div>
  );
}
