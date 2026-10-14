import { evalScreenWorkflowId } from '@auto-swe/shared/lib/workflowId';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import { getTemporalClient } from './temporalClient.js';

/**
 * Start the flake screen of a dataset (`EvalScreenWorkflow`) from an activity,
 * or join the one already running under the dataset's id. The gateway starts
 * the same workflow under the same id, so whichever starter comes first is the
 * one screen every later starter joins.
 */
export async function startDatasetScreen(datasetId: string): Promise<void> {
  try {
    await getTemporalClient().workflow.start('EvalScreenWorkflow', {
      args: [{ datasetId }],
      taskQueue: 'engineering-workflow',
      workflowId: evalScreenWorkflowId(datasetId),
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
  } catch (err) {
    // A server that refuses the conflict policy reports the running screen this way.
    if (!(err instanceof Error && err.name === 'WorkflowExecutionAlreadyStartedError')) {
      throw err;
    }
  }
}
