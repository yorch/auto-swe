import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from './spec.js';

/**
 * Built-in workflow templates seeded alongside the default engineering spec.
 * Each demonstrates a different Human-in-the-Loop pattern so operators have
 * ready-to-use starting points rather than building from scratch.
 */

// ─── 1. PR Approval Gate ─────────────────────────────────────────────────────
// Simplest supervised flow: implement → tests → human approve → open PR.
export const PR_APPROVAL_GATE_SPEC: WorkflowSpec = {
  description:
    'Implement, run tests, then require explicit human approval before opening the PR. ' +
    'Useful when a human must sign off on every change before it becomes visible to reviewers.',
  entry: 'setValidating',
  name: 'pr-approval-gate',
  nodes: {
    approve: {
      description: 'Tests passed. Approve to open the PR or reject to discard.',
      onApprove: 'setAwaitingCi',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Approve implementation before opening PR',
      type: 'humanApproval',
    },
    checkCI: {
      expr: 'context.ciResultPayload.passed == true',
      onFalse: 'setCompleted',
      onTrue: 'setCompleted',
      type: 'cond',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    implement: {
      next: 'runTests',
      step: 'executeImplementation',
      type: 'step',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    runTests: {
      next: 'storeCodeResult',
      onFail: 'warn',
      step: 'runTests',
      type: 'step',
    },
    savePrInfo: {
      next: 'waitForCI',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    setAwaitingCi: {
      config: { status: 'AWAITING_CI' },
      next: 'openPR',
      step: 'updateDomainState',
      type: 'step',
    },
    setCompleted: {
      config: { status: 'COMPLETED' },
      next: 'done',
      step: 'updateDomainState',
      type: 'step',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'approve',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    terminateCITimedOut: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'TIMED_OUT',
      type: 'terminate',
    },
    terminateRejected: { status: 'FAILED', type: 'terminate' },
    terminateTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
    validate: {
      next: 'setImplementing',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
    waitForCI: {
      name: 'ciPipelineSignal',
      onReceive: 'checkCI',
      onTimeout: 'terminateCITimedOut',
      storeAs: 'context.ciResultPayload',
      timeout: '4h',
      type: 'signal',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

// ─── 2. Scope Clarification ───────────────────────────────────────────────────
// Collects human guidance before implementation starts. Ideal for vague tickets.
export const SCOPE_CLARIFICATION_SPEC: WorkflowSpec = {
  description:
    'Ask a human for additional context before the agent starts implementing. ' +
    'Useful for tickets whose descriptions are intentionally vague or too high-level for the agent to act on without guidance.',
  entry: 'clarify',
  name: 'scope-clarification',
  nodes: {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      onFalse: 'incReviewRetries',
      onTrue: 'openPR',
      type: 'cond',
    },
    checkReviewLimit: {
      expr: 'context.reviewRetries >= 3',
      onFalse: 'reviewFix',
      onTrue: 'terminateReviewFailed',
      type: 'cond',
    },
    clarify: {
      description:
        'Answer as much or as little as you like. Leave fields blank to let the agent decide.',
      fields: [
        {
          key: 'approach',
          label: 'Preferred implementation approach',
          required: false,
          type: 'text',
        },
        {
          key: 'constraints',
          label: 'Constraints or things to avoid',
          required: false,
          type: 'text',
        },
        {
          key: 'testFocus',
          label: 'Areas to focus testing on',
          required: false,
          type: 'text',
        },
      ],
      onSubmit: 'storeClarification',
      onTimeout: 'setImplementing',
      storeAs: 'context.clarification',
      timeout: '30m',
      title: 'Clarify implementation requirements',
      type: 'humanInput',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    implement: {
      next: 'initCounters',
      step: 'executeImplementation',
      type: 'step',
    },
    incReviewRetries: {
      next: 'storeRejection',
      type: 'set',
      values: { 'context.reviewRetries': { expr: 'context.reviewRetries + 1' } },
    },
    initCounters: {
      next: 'setReviewing',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.implement.output' },
        'context.reviewRetries': { literal: 0 },
      },
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'done',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    review: {
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        successCriteria: { from: 'context.successCriteria' },
      },
      next: 'checkApproval',
      step: 'runReviewNetwork',
      type: 'step',
    },
    reviewFix: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.lastRejectionSummary' },
      },
      next: 'updateCodeAfterFix',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setReviewing: {
      config: { status: 'IN_REVIEW' },
      next: 'review',
      step: 'updateDomainState',
      type: 'step',
    },
    storeClarification: {
      next: 'setImplementing',
      type: 'set',
      values: { 'context.clarification': { from: 'nodes.clarify.output.data' } },
    },
    storeRejection: {
      next: 'checkReviewLimit',
      type: 'set',
      values: {
        'context.lastRejectionSummary': {
          default: '',
          from: 'nodes.review.output.rejectionSummary',
        },
      },
    },
    successCriteria: {
      next: 'setImplementing',
      type: 'set',
      values: {
        'context.successCriteria': { default: [], from: 'nodes.validate.output.successCriteria' },
      },
    },
    terminateReviewFailed: { status: 'FAILED', type: 'terminate' },
    updateCodeAfterFix: {
      next: 'setReviewing',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.reviewFix.output' } },
    },
    validate: {
      next: 'successCriteria',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

// ─── 3. Security Triage ───────────────────────────────────────────────────────
// After a vuln scan, a human decides: fix now, accept risk, or abandon.
export const SECURITY_TRIAGE_SPEC: WorkflowSpec = {
  description:
    'Implement, run a vulnerability scan, then ask a human how to proceed. ' +
    'Three paths: fix the issues immediately, accept the risk and open the PR anyway, ' +
    'or abandon the change entirely.',
  entry: 'setValidating',
  name: 'security-triage',
  nodes: {
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    fixVulns: {
      inputs: {
        gateName: { literal: 'runVulnScan' },
        gateOutput: { from: 'nodes.vulnScan.output' },
        previousCodeResult: { from: 'context.currentCodeResult' },
      },
      next: 'updateCodeAfterFix',
      step: 'executeGateFixImplementation',
      type: 'step',
    },
    implement: {
      next: 'storeCodeResult',
      step: 'executeImplementation',
      type: 'step',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    securityDecision: {
      description: 'Vulnerability scan complete. Choose how to proceed.',
      onTimeout: 'openPR',
      options: [
        { label: 'Fix vulnerabilities now', next: 'fixVulns', value: 'fix' },
        { label: 'Accept risk — open PR as-is', next: 'openPR', value: 'accept' },
        { label: 'Abandon — too risky', next: 'terminateAbandoned', value: 'abandon' },
      ],
      storeAs: 'context.securityDecision',
      timeout: '4h',
      title: 'How should we handle the security scan results?',
      type: 'humanDecision',
    },
    setCompleted: {
      config: { status: 'COMPLETED' },
      next: 'done',
      step: 'updateDomainState',
      type: 'step',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'vulnScan',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    terminateAbandoned: { status: 'FAILED', type: 'terminate' },
    updateCodeAfterFix: {
      next: 'openPR',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.fixVulns.output' } },
    },
    validate: {
      next: 'setImplementing',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
    vulnScan: {
      next: 'securityDecision',
      onFail: 'warn',
      step: 'runVulnScan',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

// ─── 4. Human Code Review ─────────────────────────────────────────────────────
// Show the diff to a human reviewer; optionally apply their feedback before PR.
export const HUMAN_CODE_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Implement, lint, typecheck, then show the diff to a human reviewer before opening the PR. ' +
    'The reviewer can leave notes and the agent will address them, or approve the diff as-is.',
  entry: 'setValidating',
  name: 'human-code-review',
  nodes: {
    addressFeedback: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.reviewFeedback' },
      },
      next: 'updateCodeAfterFeedback',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    applyFeedbackDecision: {
      onTimeout: 'openPR',
      options: [
        { label: 'Yes — apply the notes', next: 'addressFeedback', value: 'apply' },
        { label: 'No — looks good, open PR', next: 'openPR', value: 'skip' },
      ],
      timeout: '30m',
      title: 'Apply the reviewer notes before opening the PR?',
      type: 'humanDecision',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    humanReview: {
      contentFrom: 'context.currentCodeResult.diff',
      description: 'Review the diff and leave notes for the agent. Submit to continue.',
      onSubmit: 'storeFeedback',
      onTimeout: 'openPR',
      storeAs: 'context.reviewFeedback',
      timeout: '8h',
      title: 'Review the implementation diff',
      type: 'humanReview',
    },
    implement: {
      next: 'runLint',
      step: 'executeImplementation',
      type: 'step',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    runLint: {
      next: 'runTypecheck',
      onFail: 'warn',
      step: 'runLint',
      type: 'step',
    },
    runTypecheck: {
      next: 'storeCodeResult',
      onFail: 'warn',
      step: 'runTypecheck',
      type: 'step',
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    setCompleted: {
      config: { status: 'COMPLETED' },
      next: 'done',
      step: 'updateDomainState',
      type: 'step',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'humanReview',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    storeFeedback: {
      next: 'applyFeedbackDecision',
      type: 'set',
      values: { 'context.reviewFeedback': { from: 'nodes.humanReview.output.feedback' } },
    },
    updateCodeAfterFeedback: {
      next: 'openPR',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.addressFeedback.output' } },
    },
    validate: {
      next: 'setImplementing',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

// ─── 5. Tiered Escalation ─────────────────────────────────────────────────────
// Human categorises risk level; higher risk → stricter approval chain.
export const TIERED_ESCALATION_SPEC: WorkflowSpec = {
  description:
    'After implementation, a human categorises the change risk (low / medium / high). ' +
    'Low-risk changes go straight to PR; medium require senior sign-off; ' +
    'high-risk changes require team-lead approval with a 48-hour window.',
  entry: 'setValidating',
  name: 'tiered-escalation',
  nodes: {
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    implement: {
      next: 'storeCodeResult',
      step: 'executeImplementation',
      type: 'step',
    },
    leadApproval: {
      description: 'High-risk change — this touches auth, payments, or data migration.',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '48h',
      title: 'Team lead sign-off required',
      type: 'humanApproval',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    riskDecision: {
      description: 'This helps route the change to the right approval chain.',
      onTimeout: 'seniorApproval',
      options: [
        { label: 'Low risk (docs, config, typos)', next: 'openPR', value: 'low' },
        { label: 'Medium risk (logic, new APIs)', next: 'seniorApproval', value: 'medium' },
        { label: 'High risk (auth, payments, migrations)', next: 'leadApproval', value: 'high' },
      ],
      storeAs: 'context.riskLevel',
      timeout: '2h',
      title: 'What is the risk level of this change?',
      type: 'humanDecision',
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    seniorApproval: {
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Senior developer sign-off required',
      type: 'humanApproval',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'riskDecision',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    terminateRejected: { status: 'FAILED', type: 'terminate' },
    terminateTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
    validate: {
      next: 'setImplementing',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

// ─── 6. Full Supervised Workflow ──────────────────────────────────────────────
// All four HITL node types chained: input → implement → review → decision → approve → PR.
export const FULL_SUPERVISED_SPEC: WorkflowSpec = {
  description:
    'The kitchen-sink supervised workflow: collect requirements upfront, implement, ' +
    'show the diff for review, let the reviewer decide whether to apply their notes, ' +
    'then require final approval before the PR is opened. ' +
    'Demonstrates all four HITL node types in sequence.',
  entry: 'gatherContext',
  name: 'full-supervised',
  nodes: {
    addressNotes: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.reviewNotes' },
      },
      next: 'updateCodeAfterNotes',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    applyNotesDecision: {
      onTimeout: 'finalApproval',
      options: [
        { label: 'Yes — apply notes and re-review', next: 'addressNotes', value: 'apply' },
        { label: 'No — looks good', next: 'finalApproval', value: 'skip' },
      ],
      timeout: '30m',
      title: 'Apply the review notes?',
      type: 'humanDecision',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    finalApproval: {
      description: 'This will open a pull request that reviewers can see.',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Final approval — open the PR?',
      type: 'humanApproval',
    },
    gatherContext: {
      description:
        'Your answers are passed directly to the agent. Leave fields blank to let the agent decide.',
      fields: [
        {
          key: 'approach',
          label: 'Preferred approach or constraints',
          required: false,
          type: 'text',
        },
        {
          key: 'relatedPRs',
          label: 'Related PR numbers to reference',
          required: false,
          type: 'text',
        },
        { key: 'testFocus', label: 'Areas to focus testing on', required: false, type: 'text' },
      ],
      onSubmit: 'storeContext',
      onTimeout: 'setImplementing',
      storeAs: 'context.requirements',
      timeout: '15m',
      title: 'Provide implementation context',
      type: 'humanInput',
    },
    implement: {
      next: 'storeCodeResult',
      step: 'executeImplementation',
      type: 'step',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    reviewDiff: {
      contentFrom: 'context.currentCodeResult.diff',
      description: 'Review the diff and leave notes. Submit when done.',
      onSubmit: 'storeReviewNotes',
      onTimeout: 'finalApproval',
      storeAs: 'context.reviewNotes',
      timeout: '8h',
      title: 'Review the implementation diff',
      type: 'humanReview',
    },
    runTests: {
      next: 'storeCodeResult',
      onFail: 'warn',
      step: 'runTests',
      type: 'step',
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'reviewDiff',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    storeContext: {
      next: 'setImplementing',
      type: 'set',
      values: { 'context.requirements': { from: 'nodes.gatherContext.output.data' } },
    },
    storeReviewNotes: {
      next: 'applyNotesDecision',
      type: 'set',
      values: { 'context.reviewNotes': { from: 'nodes.reviewDiff.output.feedback' } },
    },
    terminateRejected: { status: 'FAILED', type: 'terminate' },
    terminateTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
    updateCodeAfterNotes: {
      next: 'finalApproval',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.addressNotes.output' } },
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

export const BUILTIN_TEMPLATES: Array<{
  name: string;
  description: string;
  spec: WorkflowSpec;
}> = [
  {
    description: PR_APPROVAL_GATE_SPEC.description,
    name: PR_APPROVAL_GATE_SPEC.name,
    spec: PR_APPROVAL_GATE_SPEC,
  },
  {
    description: SCOPE_CLARIFICATION_SPEC.description,
    name: SCOPE_CLARIFICATION_SPEC.name,
    spec: SCOPE_CLARIFICATION_SPEC,
  },
  {
    description: SECURITY_TRIAGE_SPEC.description,
    name: SECURITY_TRIAGE_SPEC.name,
    spec: SECURITY_TRIAGE_SPEC,
  },
  {
    description: HUMAN_CODE_REVIEW_SPEC.description,
    name: HUMAN_CODE_REVIEW_SPEC.name,
    spec: HUMAN_CODE_REVIEW_SPEC,
  },
  {
    description: TIERED_ESCALATION_SPEC.description,
    name: TIERED_ESCALATION_SPEC.name,
    spec: TIERED_ESCALATION_SPEC,
  },
  {
    description: FULL_SUPERVISED_SPEC.description,
    name: FULL_SUPERVISED_SPEC.name,
    spec: FULL_SUPERVISED_SPEC,
  },
];
