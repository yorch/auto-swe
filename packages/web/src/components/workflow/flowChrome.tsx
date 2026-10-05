'use client';

import { Background, BackgroundVariant, Controls, MiniMap, useStore } from '@xyflow/react';
import { TOKEN } from '@/lib/palette';

/** `ink-950` at 85% — the minimap's out-of-view mask. Hex alpha, since React Flow takes a colour, not a class. */
const MINIMAP_MASK = `${TOKEN.ink950}d9`;

/**
 * Dotted background, minimap and zoom controls for a workflow `<ReactFlow>`.
 * Render as a child of `<ReactFlow>`; the pieces read the flow's store.
 */
/** Below this canvas width the minimap covers most of the graph, so it is not drawn. */
const MINIMAP_MIN_CANVAS_WIDTH = 640;

export function FlowChrome({ onFit }: { onFit: () => void }) {
  const showMinimap = useStore((s) => s.width >= MINIMAP_MIN_CANVAS_WIDTH);
  return (
    <>
      <Background color={TOKEN.ink600} gap={24} size={1.2} variant={BackgroundVariant.Dots} />
      {showMinimap && (
        <MiniMap
          maskColor={MINIMAP_MASK}
          nodeColor={() => TOKEN.ink700}
          nodeStrokeColor={TOKEN.ink500}
          pannable
          // Compact: the default 200x150 covers a third of the short graph pane on a run page.
          style={{
            background: TOKEN.ink900,
            border: `1px solid ${TOKEN.ink600}`,
            height: 80,
            width: 128,
          }}
          zoomable
        />
      )}
      <Controls onFitView={onFit} showInteractive={false} />
    </>
  );
}
