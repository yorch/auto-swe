import type {
  CancelIntent,
  MessageIntent,
  OrchestrationStatusValue,
  RequestRepoIntent,
  SpawnIntent,
} from '@auto-swe/shared/lib/orchestration';
import type {
  ApprovalResolvedSignal,
  AttachResolvedSignal,
  ChildFinishedSignal,
  UserMessageSignal,
} from '@auto-swe/shared/lib/orchestrationApi';

/**
 * Types shared by the orchestration workflow and its activities. Types only, so a workflow file
 * may `import type` from here and stay inside the Temporal V8 isolate rules.
 */

/** What wakes the orchestrator. Events that arrive together are batched into one turn. */
export type OrchestrationEvent =
  | ({ type: 'userMessage' } & UserMessageSignal)
  | ({ type: 'childFinished' } & ChildFinishedSignal)
  | ({ type: 'attachResolved' } & AttachResolvedSignal)
  | ({ type: 'approvalResolved' } & ApprovalResolvedSignal)
  /** Notices (a refused intent, say) the orchestrator has not yet seen. */
  | { type: 'notices' };

/** One thing the orchestrator asked for, recorded by a tool and applied by fixed code. */
export type OrchestratorIntent =
  | { kind: 'spawn'; intent: SpawnIntent }
  | { kind: 'message'; intent: MessageIntent }
  | { kind: 'cancel'; intent: CancelIntent }
  | { kind: 'requestRepo'; intent: RequestRepoIntent };

/** The bounds the workflow decides on, run-pinned at launch so a replay never takes another path. */
export interface OrchestrationPinned {
  maxTurns: number;
  maxWallClockSeconds: number;
  maxChildren: number;
  maxConcurrentChildren: number;
  maxWriterChildren: number;
}

/** Counters carried across `continueAsNew`. Absent on the first execution. */
export interface OrchestrationCarried {
  /** Turns taken over the orchestration's whole life. */
  turns: number;
  /**
   * Makes turn keys unique across a restart: the turn count a fresh start reads from the database
   * counts only turns that posted text, so it can fall behind the count of a previous execution
   * chain, and `<id>-t<n>` would then repeat a key the gateway already spawned under. Set from the
   * run id at a fresh start and carried unchanged through `continueAsNew`.
   */
  keyEpoch?: string;
  /** Absolute time (epoch ms) at which the orchestration's lifetime ends. */
  deadlineMs: number;
  /** Consecutive turns triggered only by refusals, so a refused intent cannot loop. */
  refusalStreak: number;
  /** Children believed to be running. */
  runningChildren: number;
  /** MCP approvals believed to be pending. */
  pendingApprovals: number;
  /** Consecutive turns that failed; at the cap the workflow waits for a person's event. */
  failedTurns?: number;
  /** A cancel arrived and has not been acted on, so a `continueAsNew` cannot lose it. */
  cancelRequested?: boolean;
}

export interface OrchestrationWorkflowInput {
  orchestrationId: string;
  /** The launcher. Informational: every activity reads the authoritative launcher from the row. */
  userId: string;
  teamId: string;
  /** The orchestration token the apply activity calls the gateway with. Never logged, never stored. */
  token: string;
  pinned: OrchestrationPinned;
  /** Events queued across a `continueAsNew`. */
  pending?: OrchestrationEvent[];
  carried?: OrchestrationCarried;
}

// ── Activity inputs and results ──────────────────────────────────────────────

export interface BeginOrchestrationInput {
  orchestrationId: string;
}

export interface BeginOrchestrationResult {
  /** False when the orchestration is already over: a stale start does nothing. */
  proceed: boolean;
  createdAtMs: number;
  /** Orchestrator turns taken so far over the orchestration's whole life. */
  turns: number;
  runningChildren: number;
  pendingApprovals: number;
}

export interface RunOrchestratorTurnInput {
  orchestrationId: string;
  /** Stable for the turn; the idempotency key of the spawns it leads to. */
  turnKey: string;
  /** The turn's number over the orchestration's whole life; written on the message the turn posts. */
  turn: number;
  events: OrchestrationEvent[];
}

export interface RunOrchestratorTurnResult {
  status: 'COMPLETE' | 'FAILED' | 'SKIPPED';
  intents: OrchestratorIntent[];
  runningChildren: number;
  pendingApprovals: number;
}

export interface ApplyOrchestrationIntentsInput {
  orchestrationId: string;
  token: string;
  turnKey: string;
  intents: OrchestratorIntent[];
}

export interface ApplyOrchestrationIntentsResult {
  /** Children the gateway started. */
  spawned: number;
  /** Intents refused or that failed; each left a SYSTEM notice for the next turn. */
  refused: number;
  /** A repository request is waiting for the launcher. */
  pendingAttach: boolean;
  runningChildren: number;
  pendingApprovals: number;
  /** Whether something is still outstanding that will wake the orchestrator. */
  wait: boolean;
}

export interface RefreshOrchestrationChildrenInput {
  orchestrationId: string;
}

export interface RefreshOrchestrationChildrenResult {
  /** Children found finished that no signal had reported. */
  finishedChildIds: string[];
  runningChildren: number;
  pendingApprovals: number;
}

export interface RecordOrchestrationStatusInput {
  orchestrationId: string;
  status: OrchestrationStatusValue;
  /** A SYSTEM notice written with the change. */
  notice?: { code: string; body: string };
}

export interface CancelOrchestrationChildrenInput {
  orchestrationId: string;
  token: string;
}

export interface CancelOrchestrationChildrenResult {
  cancelled: number;
}
