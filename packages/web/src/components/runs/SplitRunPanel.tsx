'use client';

import type { AgentTraceRecord, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  recordingMatchesSelection,
  specNodeIdOfRecording,
  type TraceLinker,
} from '@/lib/traceLinkage';
import { cn, formatDate } from '@/lib/utils';
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
    <div className="flex h-full">
      {/* Step list column */}
      <div className="w-[38%] shrink-0 overflow-y-auto border-r border-ink-600/40">
        <div className="kicker sticky top-0 z-10 border-b border-ink-600/40 bg-ink-900 px-4 py-2">
          Steps · {steps.length}
        </div>
        {steps.length === 0 ? (
          <EmptyState className="text-paper-500" title="No steps recorded yet." />
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
                  className={cn(
                    'flex w-full items-start gap-2.5 border-l-2 px-4 py-3 text-left transition-colors hover:bg-ink-600/20',
                    isSelected ? 'border-ember-400 bg-ink-600' : 'border-transparent'
                  )}
                  key={s.id}
                  onClick={() => handleSelect(s.nodeId)}
                  type="button"
                >
                  <div className="pt-0.5 shrink-0">
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'font-mono text-[11px] font-medium',
                          isSelected ? 'text-ember-300' : 'text-paper-200'
                        )}
                      >
                        {branchPrefix && <span className="text-paper-600">{branchPrefix}</span>}
                        {specId}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-paper-600">
                        ×{s.attempt}
                      </span>
                    </div>
                    {s.error && (
                      <div className="mt-0.5 truncate font-mono text-[10px] text-brick-400">
                        {s.error}
                      </div>
                    )}
                    {(s.startedAt || s.endedAt) && (
                      <div className="mt-0.5 font-mono text-[10px] text-paper-600">
                        {s.startedAt ? formatDate(s.startedAt) : '?'}
                        {s.endedAt ? ` → ${formatDate(s.endedAt)}` : ''}
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
      <div className="flex-1 overflow-y-auto">
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
