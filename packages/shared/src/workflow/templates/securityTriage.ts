import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * After a vuln scan, a human decides: fix now, accept risk, or abandon.
 */
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
