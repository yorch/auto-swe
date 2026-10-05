'use client';

import { useState } from 'react';
import { RunMetaRail } from '@/components/runs/RunMetaRail';
import { SplitRunPanel } from '@/components/runs/SplitRunPanel';
import { TracesTab } from '@/components/runs/TracesTab';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
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

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main content: 1fr */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Execution graph panel */}
        <div className="flex h-[46%] max-h-[380px] min-h-[200px] flex-col border-b border-ink-600/40">
          <div className="flex items-center justify-between px-5 py-3 border-b border-ink-600/30">
            <div className="flex items-center gap-3">
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
              onSelect={setSelectedNodeId}
              outline
              selectedNodeId={selectedNodeId ? specNodeIdOfRecording(selectedNodeId, linker) : null}
              spec={spec}
              statuses={dagOverlay}
            />
          </div>
        </div>

        {/* Console panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-5 py-2.5 border-b border-ink-600/30 shrink-0">
            <div className="flex items-center gap-3">
              <h3 className="font-display text-[15px] font-medium tracking-[-0.01em] text-paper-100">
                Console
              </h3>
              {selectedNodeId && (
                <span className="font-mono text-[11px] text-ember-400">· {selectedNodeId}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <SegmentedControl
                ariaLabel="Console mode"
                onChange={setConsoleMode}
                options={CONSOLE_MODE_OPTIONS}
                value={consoleMode}
              />
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {consoleMode === 'split' ? (
              <SplitRunPanel
                linker={linker}
                onSelectNode={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                steps={run.steps}
                traces={traces}
              />
            ) : (
              <div className="h-full overflow-y-auto">
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
      <RunMetaRail run={run} />
    </div>
  );
}
