'use client';

import type { AgentTraceRecord, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { EmptyState } from '@/components/ui/EmptyState';
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
    <div className="flex h-full">
      {/* Step list column */}
      <div className="shrink-0 overflow-y-auto border-r border-ink-600/40" style={{ width: '38%' }}>
        <div
          className="sticky top-0 z-10 px-4 py-2 border-b border-ink-600/40 kicker"
          style={{ background: 'var(--color-ink-900)' }}
        >
          Steps · {steps.length}
        </div>
        {steps.length === 0 ? (
          <EmptyState className="text-paper-500" title="No steps recorded yet." />
        ) : (
          <div className="divide-y divide-ink-600/30">
            {steps.map((s) => {
              const isSelected = selectedNodeId === s.nodeId;
              return (
                <button
                  className="w-full flex items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-ink-600/20"
                  key={s.id}
                  onClick={() => handleSelect(s.nodeId)}
                  style={{
                    background: isSelected ? 'var(--color-ink-600)' : undefined,
                    borderLeft: isSelected
                      ? '2px solid var(--color-ember-400)'
                      : '2px solid transparent',
                  }}
                  type="button"
                >
                  <div className="pt-0.5 shrink-0">
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={isSelected ? 'text-ember-300' : 'text-paper-200'}
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '11px',
                          fontWeight: 500,
                        }}
                      >
                        {s.nodeId}
                      </span>
                      <span
                        className="text-paper-600 shrink-0"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}
                      >
                        ×{s.attempt}
                      </span>
                    </div>
                    {s.error && (
                      <div
                        className="text-brick-400 mt-0.5 truncate"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                      >
                        {s.error}
                      </div>
                    )}
                    {(s.startedAt || s.endedAt) && (
                      <div
                        className="text-paper-600 mt-0.5"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                      >
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
          activityToNodeId={activityToNodeId}
          filterNodeId={selectedNodeId}
          onClearFilter={() => onSelectNode(null)}
          traces={traces}
        />
      </div>
    </div>
  );
}
