'use client';

import type { AgentTraceRecord, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  recordingMatchesSelection,
  specNodeIdOfRecording,
  type TraceLinker,
} from '@/lib/traceLinkage';
import { cn, FOCUS_RING, formatDate } from '@/lib/utils';
import { TracesTab } from './TracesTab';

interface SplitRunPanelProps {
  linker: TraceLinker;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  steps: WorkflowStepRecord[];
  traces: AgentTraceRecord[];
}

export function SplitRunPanel({
  linker,
  selectedNodeId,
  onSelectNode,
  steps,
  traces,
}: SplitRunPanelProps) {
  const handleSelect = (nodeId: string) => {
    onSelectNode(selectedNodeId === nodeId ? null : nodeId);
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Step list column */}
      <div className="max-h-60 w-full shrink-0 overflow-y-auto border-b border-ink-600/40 lg:max-h-none lg:w-[38%] lg:border-b-0 lg:border-r">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-600/40 bg-ink-900 px-4 py-2">
          <h3 className="text-[13px] font-semibold text-paper-100">Steps</h3>
          <span className="tabular text-xs text-paper-500">{steps.length}</span>
          {selectedNodeId && (
            <span className="ml-auto text-xs text-paper-500 max-sm:hidden">
              Click again to show all
            </span>
          )}
        </div>
        {steps.length === 0 ? (
          <EmptyState
            hint="Steps appear here as the workflow reaches them."
            icon="workflows"
            title="No steps recorded yet"
          />
        ) : (
          <div className="divide-y divide-ink-600/30">
            {steps.map((s) => {
              const isSelected =
                selectedNodeId !== null &&
                recordingMatchesSelection(s.nodeId, selectedNodeId, linker);
              const specId = specNodeIdOfRecording(s.nodeId, linker);
              // The branch path (`fan[0]/`), set apart from the node it ran.
              const branchPrefix = s.nodeId.slice(0, s.nodeId.length - specId.length);
              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    'flex w-full items-start gap-2.5 border-l-2 px-4 py-2.5 text-left transition-colors hover:bg-ink-600/30',
                    FOCUS_RING,
                    isSelected ? 'border-ember-400 bg-ink-700' : 'border-transparent'
                  )}
                  key={s.id}
                  onClick={() => handleSelect(s.nodeId)}
                  type="button"
                >
                  <div className="pt-0.5 shrink-0">
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span
                        className={cn(
                          'min-w-0 break-all font-mono text-xs font-medium',
                          isSelected ? 'text-ember-300' : 'text-paper-100'
                        )}
                      >
                        {branchPrefix && <span className="text-paper-500">{branchPrefix}</span>}
                        {specId}
                      </span>
                      <span
                        className="tabular shrink-0 text-[11px] text-paper-500"
                        title={`Attempt ${s.attempt}`}
                      >
                        ×{s.attempt}
                      </span>
                    </div>
                    {s.error && (
                      <div
                        className="mt-0.5 truncate font-mono text-[11px] text-brick-400"
                        title={s.error}
                      >
                        {s.error}
                      </div>
                    )}
                    {(s.startedAt || s.endedAt) && (
                      <div className="tabular mt-0.5 text-[11px] text-paper-500">
                        {s.startedAt ? formatDate(s.startedAt) : '?'}
                        {s.endedAt ? ` – ${formatDate(s.endedAt)}` : ''}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Trace stream column */}
      <div className="max-lg:min-w-0 lg:flex-1 lg:overflow-y-auto">
        <TracesTab
          filterNodeId={selectedNodeId}
          linker={linker}
          onClearFilter={() => onSelectNode(null)}
          traces={traces}
        />
      </div>
    </div>
  );
}
