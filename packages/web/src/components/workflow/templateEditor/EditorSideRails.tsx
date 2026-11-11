import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import { NodePalette, type PaletteDragKind } from '../NodePalette';
import { WorkflowOutline } from '../WorkflowOutline';

interface PaletteRailProps {
  steps: StepMetadata[];
  open: boolean;
  paletteRef: RefObject<HTMLDivElement | null>;
  onAdd: (payload: PaletteDragKind) => void;
  onClose: () => void;
}

/** Left rail: a fixed column from lg up, a drawer over the canvas below it. */
export function PaletteRail({ steps, open, paletteRef, onAdd, onClose }: PaletteRailProps) {
  return (
    <div
      className={cn(
        'z-20 h-full w-full lg:w-56 [&>aside]:w-full shadow-xl lg:static lg:block lg:shadow-none',
        open ? 'absolute inset-y-0 left-0 block' : 'hidden'
      )}
      data-tour="editor:palette"
      ref={paletteRef}
    >
      <NodePalette
        onAdd={(...args) => {
          onAdd(...args);
          onClose();
        }}
        steps={steps}
      />
    </div>
  );
}

interface OutlineRailProps {
  spec: WorkflowSpec;
  selectedNodeId: string | null;
  outlineRef: RefObject<HTMLElement | null>;
  onSelect: (id: string | null) => void;
}

/** The outline rail beside the canvas; rendered only while it is open. */
export function OutlineRail({ spec, selectedNodeId, outlineRef, onSelect }: OutlineRailProps) {
  return (
    <aside
      aria-label="Outline"
      className="absolute inset-y-0 left-0 z-10 flex w-full max-w-full shrink-0 flex-col border-r border-ink-600 bg-ink-900 lg:static lg:w-52"
      ref={outlineRef}
      tabIndex={-1}
    >
      <WorkflowOutline
        className="flex-1"
        height="100%"
        onSelect={onSelect}
        selectedNodeId={selectedNodeId}
        spec={spec}
      />
    </aside>
  );
}
