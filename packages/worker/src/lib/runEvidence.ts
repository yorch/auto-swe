import {
  type RecordRunEvidenceInput,
  type RecordRunEvidenceResult,
  recordRunEvidence,
} from '@auto-swe/shared/lib/runEvidence';
import { currentWorkflowRunId } from './activityContext.js';
import { currentNodeTag } from './activityNodeTag.js';
import type { AgentTracer } from './agentTracer.js';

type ActivityEvidenceInput = Omit<RecordRunEvidenceInput, 'runId' | 'specNodeId' | 'stepAttempt'>;

export async function recordActivityEvidence(
  input: ActivityEvidenceInput,
  tracer?: AgentTracer
): Promise<RecordRunEvidenceResult> {
  const runId = await currentWorkflowRunId();
  if (!runId) {
    throw new Error('UI evidence requires a WorkflowRun');
  }
  const tag = currentNodeTag();
  const result = await recordRunEvidence({
    ...input,
    runId,
    specNodeId: tag?.specNodeId,
    stepAttempt: tag?.stepAttempt,
  });
  if (result.ok) {
    tracer?.addActivityEvent({
      name: 'ui.evidence',
      outputJson: {
        caption: input.caption,
        evidenceId: result.evidenceId,
        kind: input.kind,
        pageUrl: input.pageUrl,
      },
    });
  }
  return result;
}
