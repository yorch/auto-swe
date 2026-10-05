import type { AgentTraceRecord, WorkflowRunDetail } from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import type { TraceLinker } from '@/lib/traceLinkage';

/** What every run layout receives. Layouts differ only in how they present it. */
export interface RunLayoutProps {
  run: WorkflowRunDetail;
  spec: WorkflowSpec;
  linker: TraceLinker;
  traces: AgentTraceRecord[];
  dagOverlay: { byNodeId: Record<string, { status: string; attempt: number }> } | undefined;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  /** Bumped on every "Jump to failure", so a repeat jump to the same step still re-seeks. */
  jumpNonce?: number;
}
