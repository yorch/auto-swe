'use client';

import { useState } from 'react';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { SplitRunPanel } from '@/components/runs/SplitRunPanel';
import { TracesTab } from '@/components/runs/TracesTab';
import { Badge } from '@/components/ui/Badge';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { specNodeIdOfRecording } from '@/lib/traceLinkage';
import { cn } from '@/lib/utils';
import { PANEL_BAR, PANEL_META, PANEL_TITLE } from './panel';
import type { RunLayoutProps } from './types';

// ── Console mode (by step / one stream) ────────────────────────────────────────

const CONSOLE_MODE_OPTIONS: SegmentedOption<'split' | 'stream'>[] = [
  { label: 'By step', title: 'Steps beside the events of the selected one', value: 'split' },
  { label: 'Stream', title: 'Every event in one stream', value: 'stream' },
];

// ── Direction A — Split Console ────────────────────────────────────────────────

export function SplitConsole({
  linker,
  dagOverlay,
  run,
  selectedNodeId,
  setSelectedNodeId,
  spec,
  traces,
}: RunLayoutProps) {
  const [consoleMode, setConsoleMode] = useState<'split' | 'stream'>('split');
  // Below the breakpoint everything stacks in one column and the page scrolls; the details
  // rail then sits between the graph and the console instead of beside them.
  const narrow = useIsNarrow();
  const rail = <RunMetaRail collapsible={narrow} run={run} />;

  return (
    <div className="flex flex-1 flex-col max-lg:min-w-0 lg:flex-row lg:overflow-hidden">
      {/* Main content: 1fr */}
      <div className="flex flex-1 flex-col max-lg:min-w-0 lg:overflow-hidden">
        {/* Execution graph panel */}
        <div className="flex h-[clamp(220px,52dvh,440px)] max-lg:landscape:h-[clamp(160px,56dvh,440px)] shrink-0 flex-col border-b border-ink-600/40 lg:h-[46%] lg:max-h-[380px] lg:min-h-[200px] lg:shrink">
          <div className={PANEL_BAR}>
            <h2 className={PANEL_TITLE}>Execution graph</h2>
            <span className={PANEL_META}>
              {Object.keys(spec.nodes ?? {}).length} nodes · drag to pan, scroll to zoom
            </span>
            <span className="ml-auto text-xs text-paper-500 max-sm:hidden">
              Select a node to filter the console
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <WorkflowDag
              height="100%"
              narrowScrollSafe
              onSelect={setSelectedNodeId}
              outline
              selectedNodeId={selectedNodeId ? specNodeIdOfRecording(selectedNodeId, linker) : null}
              spec={spec}
              statuses={dagOverlay}
            />
          </div>
        </div>

        {narrow && rail}

        {/* Console panel */}
        <div className="flex flex-1 flex-col lg:overflow-hidden">
          <div className={cn(PANEL_BAR, 'justify-between max-lg:gap-y-2')}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className={PANEL_TITLE}>Console</h2>
              {selectedNodeId && (
                <Badge className="font-mono max-lg:whitespace-normal max-lg:break-all" tone="ember">
                  {selectedNodeId}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3">
              <SegmentedControl
                ariaLabel="Console mode"
                onChange={setConsoleMode}
                optionClassName="min-h-[40px] lg:min-h-0"
                options={CONSOLE_MODE_OPTIONS}
                value={consoleMode}
              />
            </div>
          </div>

          <div className="flex-1 lg:overflow-hidden">
            {consoleMode === 'split' ? (
              <SplitRunPanel
                linker={linker}
                onSelectNode={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                steps={run.steps}
                traces={traces}
              />
            ) : (
              <div className="lg:h-full lg:overflow-y-auto">
                <TracesTab
                  filterNodeId={selectedNodeId}
                  linker={linker}
                  onClearFilter={() => setSelectedNodeId(null)}
                  traces={traces}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right meta rail */}
      {!narrow && rail}
    </div>
  );
}
