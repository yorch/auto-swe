// ── MVP Workflow Types ──
// Subset of the full system types — only what Phase 1 needs.

export interface RepoWorkRequest {
  workRequestId: string;
  repoId: string;
  externalTicketId: string;
  description: string;          // What the agent should implement
  requestPayload: string;
}

export interface CodeResult {
  branch: string;
  headSha: string;
  diff: string;
  filesChanged: FileChange[];
  testResults: TestRunResult;
  implementationNotes: string;
}

export interface FileChange {
  path: string;
  operation: 'CREATE' | 'MODIFY' | 'DELETE';
  language: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface TestRunResult {
  passed: boolean;
  total: number;
  passing: number;
  failing: number;
  stdout: string;    // Truncated to 10KB
  duration_ms: number;
}

export interface WorkflowResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT';
  prNumber?: number;
  prUrl?: string;
}

export type WorkflowStatus =
  | 'IMPLEMENTING'
  | 'AWAITING_HUMAN_MERGE'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT';
