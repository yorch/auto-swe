'use client';

import type { AgentTraceRecord, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDate } from '@/lib/utils';
import { TracesTab } from './TracesTab';

interface SplitRunPanelProps {
  activityToNodeId: Record<string, string>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  steps: WorkflowStepRecord[];
  traces: AgentTraceRecord[];
}

export function SplitRunPanel({
  activityToNodeId,
  selectedNodeId,
  onSelectNode,
  steps,
  traces,
}: SplitRunPanelProps) {
  const handleSelect = (nodeId: string) => {
    onSelectNode(selectedNodeId === nodeId ? null : nodeId);
  };

  return (
    <div className="flex min-h-48 max-h-[60vh]">
      {/* Steps column */}
      <div className="w-[38%] shrink-0 border-r border-ink-600 overflow-y-auto">
        <div className="px-3 py-1.5 bg-ink-900/60 border-b border-ink-600 text-[10px] uppercase tracking-widest text-paper-400">
          Steps · {steps.length}
        </div>
        {steps.length === 0 ? (
          <div className="py-8 text-center text-sm text-paper-400">No steps recorded yet.</div>
        ) : (
          <div className="divide-y divide-ink-600/50">
            {steps.map((s) => (
              <button
                className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-ink-800/40 ${
                  selectedNodeId === s.nodeId ? 'bg-ink-800/60' : ''
                }`}
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
                      className={`text-xs font-mono truncate ${
                        selectedNodeId === s.nodeId ? 'text-ember-300' : 'text-paper-200'
                      }`}
                    >
                      {s.nodeId}
                    </span>
                    <span className="text-[10px] text-paper-400 shrink-0">×{s.attempt}</span>
                  </div>
                  {s.error && (
                    <div className="text-[10px] text-brick-400 mt-0.5 truncate">{s.error}</div>
                  )}
                  {(s.startedAt || s.endedAt) && (
                    <div className="text-[10px] text-paper-400 mt-0.5">
                      {s.startedAt ? formatDate(s.startedAt) : '?'}
                      {s.endedAt ? ` → ${formatDate(s.endedAt)}` : ''}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Traces column */}
      <div className="flex-1 overflow-y-auto">
        <TracesTab
          activityToNodeId={activityToNodeId}
          filterNodeId={selectedNodeId}
          onClearFilter={() => onSelectNode(null)}
          traces={traces}
        />
      </div>
    </div>
  );
}
