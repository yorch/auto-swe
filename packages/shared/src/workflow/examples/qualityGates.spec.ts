/**
 * Example spec — engineering workflow with phase-2 quality gates wired in.
 *
 * Drop this between `implement` and the review loop to enforce lint /
 * typecheck / tests / build before any reviewer ever sees the diff. Each
 * gate uses `onFail: { retry: 1 }` to absorb transient flakes, then falls
 * back to `block` semantics; the `executeGateFixImplementation` branch lets
 * the implementer re-attempt with the failed gate's output as context.
 *
 * Consumers can copy this and trim/extend it. The spec is intentionally not
 * exported as a registered template; teams seed it explicitly if they want
 * it as their default.
 */

import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const QUALITY_GATES_EXAMPLE_SPEC: WorkflowSpec = {
  description:
    'Example workflow that runs lint → typecheck → tests → build as blocking gates after implementation, with a gate-fix loop and a non-blocking vuln scan before PR open.',
  entry: 'implement',
  name: 'engineering-with-gates',
  nodes: {
    // ── Build ────────────────────────────────────────────────────────────
    build: {
      next: 'checkBuild',
      step: 'runBuild',
      type: 'step',
    },
    checkBuild: {
      expr: 'nodes.build.output.passed == true',
      onFalse: 'recordBuildFailure',
      onTrue: 'vulnScan',
      type: 'cond',
    },

    // ── Gate-fix loop ────────────────────────────────────────────────────
    checkGateFixBudget: {
      expr: 'context.gateFixRetries >= 3',
      onFalse: 'gateFix',
      onTrue: 'terminateGateFailed',
      type: 'cond',
    },
    checkLint: {
      expr: 'nodes.lint.output.passed == true',
      onFalse: 'recordLintFailure',
      onTrue: 'typecheck',
      type: 'cond',
    },
    checkTests: {
      expr: 'nodes.tests.output.passed == true',
      onFalse: 'recordTestsFailure',
      onTrue: 'build',
      type: 'cond',
    },
    checkTypecheck: {
      expr: 'nodes.typecheck.output.passed == true',
      onFalse: 'recordTypecheckFailure',
      onTrue: 'tests',
      type: 'cond',
    },

    // ── Terminals ────────────────────────────────────────────────────────
    done: {
      result: {},
      status: 'SUCCESS',
      type: 'terminate',
    },
    gateFix: {
      inputs: {
        gateName: { from: 'context.lastGateName' },
        gateOutput: { from: 'context.lastGateOutput' },
        previousCodeResult: { from: 'context.currentCodeResult' },
      },
      next: 'updateAfterGateFix',
      step: 'executeGateFixImplementation',
      type: 'step',
    },
    implement: {
      next: 'initGateRetries',
      step: 'executeImplementation',
      type: 'step',
    },
    initGateRetries: {
      next: 'lint',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.implement.output' },
        'context.gateFixRetries': { literal: 0 },
      },
    },

    // ── Lint ──────────────────────────────────────────────────────────────
    lint: {
      next: 'checkLint',
      onFail: { retry: 1 },
      step: 'runLint',
      type: 'step',
    },
    recordBuildFailure: {
      next: 'checkGateFixBudget',
      type: 'set',
      values: {
        'context.lastGateName': { literal: 'runBuild' },
        'context.lastGateOutput': { from: 'nodes.build.output' },
      },
    },
    recordLintFailure: {
      next: 'checkGateFixBudget',
      type: 'set',
      values: {
        'context.lastGateName': { literal: 'runLint' },
        'context.lastGateOutput': { from: 'nodes.lint.output' },
      },
    },
    recordTestsFailure: {
      next: 'checkGateFixBudget',
      type: 'set',
      values: {
        'context.lastGateName': { literal: 'runTests' },
        'context.lastGateOutput': { from: 'nodes.tests.output' },
      },
    },
    recordTypecheckFailure: {
      next: 'checkGateFixBudget',
      type: 'set',
      values: {
        'context.lastGateName': { literal: 'runTypecheck' },
        'context.lastGateOutput': { from: 'nodes.typecheck.output' },
      },
    },
    terminateGateFailed: {
      result: { failedGate: { from: 'context.lastGateName' } },
      status: 'FAILED',
      type: 'terminate',
    },

    // ── Tests (always fresh, full suite — not the implementer's TDD run) ──
    tests: {
      next: 'checkTests',
      onFail: { retry: 1 },
      step: 'runTests',
      type: 'step',
    },

    // ── Typecheck ────────────────────────────────────────────────────────
    typecheck: {
      next: 'checkTypecheck',
      onFail: { retry: 1 },
      step: 'runTypecheck',
      type: 'step',
    },
    updateAfterGateFix: {
      next: 'lint',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.gateFix.output' },
        'context.gateFixRetries': { expr: 'context.gateFixRetries + 1' },
      },
    },

    // ── Vuln scan (non-blocking warning) ─────────────────────────────────
    vulnScan: {
      next: 'done',
      // `warn`: a failed scan records FAILED but the workflow proceeds.
      // Teams can promote to `block` once their dependency hygiene is clean.
      onFail: 'warn',
      step: 'runVulnScan',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
