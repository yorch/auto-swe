import type { StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';

export interface TemplateEditorProps {
  spec: WorkflowSpec;
  stepRegistry: StepMetadata[];
  selectedNodeId: string | null;
  /** The version of `templateId` the spec was loaded from; the check reports newer ones. */
  baseVersion?: number;
  onSelect: (id: string | null) => void;
  onChange: (next: WorkflowSpec) => void;
  costEstimateUsd?: number | null;
  /**
   * What the estimate above leaves out (container runtime, external calls,
   * unpriced steps, retries). Rendered as the estimate's tooltip; a partial sum
   * should say what it is missing.
   */
  costEstimateExclusions?: string | null;
  observedCostUsd?: number | null;
  parseError?: string | null;
  /** A save the server rejected; listed beside the live lint results rather than in a separate banner. */
  serverError?: string | null;
  /** The saved template being edited, so the server check can apply that template's scope. */
  templateId?: string;
  /** The owning team of that template (absent for a platform-wide one). */
  teamId?: string | null;
  /** Action bar shown above the canvas — parent supplies Save/Cancel CTAs. */
  actions?: React.ReactNode;
}
