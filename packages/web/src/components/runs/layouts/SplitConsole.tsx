'use client';

import { useState } from 'react';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { SplitRunPanel } from '@/components/runs/SplitRunPanel';
import { TracesTab } from '@/components/runs/TracesTab';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { specNodeIdOfRecording } from '@/lib/traceLinkage';
import type { RunLayoutProps } from './types';

// ── Console mode (◧ Split / ≡ Stream) ──────────────────────────────────────────

const CONSOLE_MODE_OPTIONS: SegmentedOption<'split' | 'stream'>[] = [
  { label: '◧ Split', value: 'split' },
  { label: '≡ Stream', value: 'stream' },
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
          <div className="flex flex-wrap items-center justify-between max-lg:gap-x-3 max-lg:gap-y-1 lg:flex-nowrap px-4 py-3 border-b border-ink-600/30 lg:px-5">
            <div className="flex flex-wrap items-center gap-3 max-lg:gap-y-1 lg:flex-nowrap">
              <span className="kicker">Execution graph</span>
              <span className="font-mono text-[10px] text-paper-600">
                {Object.keys(spec.nodes ?? {}).length} nodes · pan + zoom
              </span>
            </div>
            <StatusBadge status={run.status} />
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
          <div className="flex flex-wrap items-center justify-between max-lg:gap-x-3 max-lg:gap-y-2 lg:flex-nowrap px-4 py-2.5 border-b border-ink-600/30 shrink-0 lg:px-5">
            <div className="flex flex-wrap items-center gap-3 max-lg:min-w-0 max-lg:gap-y-1 lg:flex-nowrap">
              <h3 className="font-display text-[15px] font-medium tracking-[-0.01em] text-paper-100">
                Console
              </h3>
              {selectedNodeId && (
                <span className="font-mono text-[11px] text-ember-400 max-lg:break-all">
                  · {selectedNodeId}
                </span>
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
