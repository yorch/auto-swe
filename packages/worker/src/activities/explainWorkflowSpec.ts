/**
 * explainWorkflowSpec — the inverse of `generateWorkflowSpec`: read a validated
 * {@link WorkflowSpec} and produce a plain-language Markdown explanation via the
 * seeded `workflowExplainer` agent. Used by the canvas/CLI "Explain" affordance.
 */

import {
  buildExplainRequestMessage,
  type WorkflowExplanation,
  WorkflowExplanationSchema,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { runAgent } from './runAgent.js';

export interface ExplainWorkflowSpecInput {
  spec: WorkflowSpec;
  /** Team scope for agent resolution (null = global). */
  teamId?: string | null;
}

export interface ExplainWorkflowSpecResult {
  /** Markdown explanation of the workflow. */
  explanation: string;
}

export async function explainWorkflowSpec(
  input: ExplainWorkflowSpecInput
): Promise<ExplainWorkflowSpecResult> {
  heartbeat('explain workflow');
  const agentSpec = await resolveAgentSpec(
    {
      agentKey: 'workflowExplainer' as ModelBackedAgentKey,
      outputSchema: WorkflowExplanationSchema,
    },
    { teamId: input.teamId ?? undefined }
  );

  const result = await runAgent<WorkflowExplanation>(
    agentSpec,
    buildExplainRequestMessage(input.spec),
    { spanName: 'llm.workflow_explainer' }
  );

  // Prefer the structured field; fall back to free text if the provider didn't
  // honor the schema, so a missing wrapper never fails an otherwise-good answer.
  const explanation = result.object?.explanation?.trim() || result.text?.trim();
  if (!explanation) {
    throw new Error('workflowExplainer returned no explanation');
  }
  return { explanation };
}
