import { describe, expect, it } from 'vitest';
import { type SignalGateOptions, signalGate } from './signalGate.js';
import { expectWellFormed } from './testUtil.js';

const opts: SignalGateOptions = {
  expr: 'context.stagingPayload.deployed == true',
  ids: {
    check: 'checkStaging',
    rejected: 'terminateStagingFailed',
    timedOut: 'terminateStagingTimedOut',
    wait: 'waitForStaging',
  },
  label: 'staging deploy',
  passed: 'next',
  signal: 'stagingDeploySignal',
  storeAs: 'context.stagingPayload',
  timeout: '1h',
};

describe('signalGate', () => {
  it('is four plain nodes under the ids it is given', () => {
    const nodes = signalGate(opts);
    expect(Object.keys(nodes).sort()).toEqual([
      'checkStaging',
      'terminateStagingFailed',
      'terminateStagingTimedOut',
      'waitForStaging',
    ]);
    expectWellFormed(nodes, 'waitForStaging', ['next']);
  });

  it('waits on the named signal and stores the payload', () => {
    expect(signalGate(opts).waitForStaging).toMatchObject({
      name: 'stagingDeploySignal',
      onReceive: 'checkStaging',
      onTimeout: 'terminateStagingTimedOut',
      storeAs: 'context.stagingPayload',
      timeout: '1h',
      type: 'signal',
    });
  });

  it('routes a go onward and a no-go to the rejected terminal', () => {
    expect(signalGate(opts).checkStaging).toMatchObject({
      expr: 'context.stagingPayload.deployed == true',
      onFalse: 'terminateStagingFailed',
      onTrue: 'next',
    });
  });

  it('fails on a no-go and times out on silence, reporting the pull request either way', () => {
    const nodes = signalGate(opts);
    expect(nodes.terminateStagingFailed).toMatchObject({
      result: { prNumber: { from: 'context.prNumber' } },
      status: 'FAILED',
    });
    expect(nodes.terminateStagingTimedOut).toMatchObject({
      result: { prUrl: { from: 'context.prUrl' } },
      status: 'TIMED_OUT',
    });
  });

  it('uses the label as the group', () => {
    for (const node of Object.values(signalGate(opts))) {
      expect(node.group).toBe('staging deploy');
    }
  });
});
