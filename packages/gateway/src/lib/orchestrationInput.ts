/** Temporal workflow type of an orchestration (`worker/src/workflows`). */
export const ORCHESTRATION_WORKFLOW_TYPE = 'OrchestrationWorkflow';

/** The run-pinned bounds the workflow decides on, resolved once when the orchestration launches. */
export interface OrchestrationPins {
  maxChildren: number;
  maxConcurrentChildren: number;
  maxTurns: number;
  maxWallClockSeconds: number;
  maxWriterChildren: number;
}

/**
 * The input `OrchestrationWorkflow` starts with (via `signalWithStart`, so it is used only when
 * the workflow is not already running). `userId` is the launching person, null when a service
 * principal launched it (`serviceId`).
 */
export interface OrchestrationWorkflowInput {
  orchestrationId: string;
  pinned: OrchestrationPins;
  serviceId: string | null;
  teamId: string;
  token: string;
  userId: string | null;
}
