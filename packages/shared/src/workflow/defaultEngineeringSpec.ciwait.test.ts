import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINEERING_SPEC } from './defaultEngineeringSpec.js';
import type { Context } from './expr.js';
import { type Dispatcher, runSpec } from './interpreter.js';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from './spec.js';

describe('DEFAULT_ENGINEERING_SPEC CI-wait wiring', () => {
  it('still parses with the CI-wait routing nodes', () => {
    expect(() => parseWorkflowSpec(DEFAULT_ENGINEERING_SPEC)).not.toThrow();
  });

  it('routes savePrInfo → loadCiWaitConfig → routeCiWait', () => {
    const nodes = DEFAULT_ENGINEERING_SPEC.nodes;
    expect((nodes.savePrInfo as { next: string }).next).toBe('loadCiWaitConfig');
    expect((nodes.loadCiWaitConfig as { step: string; next: string }).step).toBe(
      'resolveCiWaitConfig'
    );
    expect((nodes.loadCiWaitConfig as { next: string }).next).toBe('routeCiWait');
    const route = nodes.routeCiWait as { type: string; onTrue: string; onFalse: string };
    expect(route.type).toBe('cond');
    expect(route.onTrue).toBe('pollForCI');
    expect(route.onFalse).toBe('waitForCI');
    expect((nodes.pollForCI as { next: string }).next).toBe('storePollResult');
    expect((nodes.storePollResult as { next: string }).next).toBe('checkCI');
  });
});

/**
 * Minimal spec replicating the CI-wait subgraph so we can drive both branches
 * through the interpreter without standing up the full engineering workflow.
 */
function ciWaitSubgraph() {
  return parseWorkflowSpec({
    entry: 'loadCiWaitConfig',
    name: 'ci-wait-subgraph',
    nodes: {
      checkCI: {
        expr: 'context.ciResultPayload.passed == true',
        onFalse: 'failed',
        onTrue: 'passed',
        type: 'cond',
      },
      failed: { result: { via: { from: 'context.ciVia' } }, status: 'FAILED', type: 'terminate' },
      loadCiWaitConfig: { next: 'routeCiWait', step: 'resolveCiWaitConfig', type: 'step' },
      passed: { result: { via: { from: 'context.ciVia' } }, status: 'SUCCESS', type: 'terminate' },
      pollForCI: {
        inputs: { ref: { from: 'context.currentCodeResult.branch' } },
        next: 'storePollResult',
        step: 'waitForCiByPolling',
        type: 'step',
      },
      recordSignalVia: {
        next: 'checkCI',
        type: 'set',
        values: { 'context.ciVia': { literal: 'signal' } },
      },
      routeCiWait: {
        expr: "nodes.loadCiWaitConfig.output.mode == 'poll'",
        onFalse: 'waitForCI',
        onTrue: 'pollForCI',
        type: 'cond',
      },
      storePollResult: {
        next: 'checkCI',
        type: 'set',
        values: {
          'context.ciResultPayload.logsUrl': { from: 'nodes.pollForCI.output.logsUrl' },
          'context.ciResultPayload.passed': { from: 'nodes.pollForCI.output.ciPassed' },
          'context.ciVia': { literal: 'poll' },
        },
      },
      waitForCI: {
        name: 'ciPipelineSignal',
        onReceive: 'recordSignalVia',
        onTimeout: 'failed',
        storeAs: 'context.ciResultPayload',
        timeout: '4h',
        type: 'signal',
      },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  });
}

const baseCtx = (): Context => ({
  context: { currentCodeResult: { branch: 'auto/T-1' } },
  nodes: {},
  request: { externalTicketId: 'T-1', repoId: 'r-1' },
  workflow: { id: 'eng-t-1' },
});

function makeDispatcher(opts: {
  stepOutputs: Record<string, unknown>;
  signalQueue: Record<string, unknown[]>;
}): Dispatcher {
  return {
    async dispatchStep({ step }) {
      const out = opts.stepOutputs[step];
      if (out === undefined) {
        throw new Error(`no canned output for step ${step}`);
      }
      return out;
    },
    async recordStep() {},
    async waitSignal(name) {
      return opts.signalQueue[name]?.shift();
    },
  };
}

describe('CI-wait routing behavior', () => {
  it('poll mode runs the poller and gates on its result', async () => {
    const dispatcher = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        resolveCiWaitConfig: { deadlineSec: 600, graceSec: 60, intervalSec: 15, mode: 'poll' },
        waitForCiByPolling: { ciPassed: true },
      },
    });
    const result = await runSpec(ciWaitSubgraph(), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toMatchObject({ via: 'poll' });
  });

  it('signal mode waits for the webhook signal and gates on its payload', async () => {
    const dispatcher = makeDispatcher({
      signalQueue: { ciPipelineSignal: [{ logsUrl: 'x', passed: true }] },
      stepOutputs: {
        resolveCiWaitConfig: { deadlineSec: 600, graceSec: 60, intervalSec: 15, mode: 'signal' },
      },
    });
    const result = await runSpec(ciWaitSubgraph(), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toMatchObject({ via: 'signal' });
  });

  it('poll mode failure routes to the failed terminal', async () => {
    const dispatcher = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        resolveCiWaitConfig: { deadlineSec: 600, graceSec: 60, intervalSec: 15, mode: 'poll' },
        waitForCiByPolling: { ciPassed: false },
      },
    });
    const result = await runSpec(ciWaitSubgraph(), baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
  });
});
