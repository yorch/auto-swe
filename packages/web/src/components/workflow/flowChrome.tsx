'use client';

import { Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react';
import { TOKEN } from '@/lib/palette';

/** `ink-950` at 85% — the minimap's out-of-view mask. Hex alpha, since React Flow takes a colour, not a class. */
const MINIMAP_MASK = `${TOKEN.ink950}d9`;

/**
 * Dotted background, minimap and zoom controls for a workflow `<ReactFlow>`.
 * Render as a child of `<ReactFlow>`; the pieces read the flow's store.
 */
export function FlowChrome({ onFit }: { onFit: () => void }) {
  return (
    <>
      <Background color={TOKEN.ink600} gap={24} size={1.2} variant={BackgroundVariant.Dots} />
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
      <Controls onFitView={onFit} showInteractive={false} />
    </>
  );
}
