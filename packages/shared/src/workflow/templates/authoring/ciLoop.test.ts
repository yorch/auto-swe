import { describe, expect, it } from 'vitest';
import { ciLoop, ciWaitEntry, waitForCi } from './ciLoop.js';
import { expectWellFormed } from './testUtil.js';

describe('waitForCi', () => {
  it('is the lone signal node plus its timeout terminal in signal mode', () => {
    const nodes = waitForCi('signal');
    expect(Object.keys(nodes).sort()).toEqual(['terminateCITimedOut', 'waitForCI']);
    expect(nodes.waitForCI).toMatchObject({
      name: 'ciPipelineSignal',
      onReceive: 'checkCI',
      onTimeout: 'terminateCITimedOut',
      storeAs: 'context.ciResultPayload',
      timeout: '4h',
      type: 'signal',
    });
  });

  it('adds the poll routing in pollOrSignal mode, and its entry moves with it', () => {
    const nodes = waitForCi('pollOrSignal');
    expect(Object.keys(nodes).sort()).toEqual([
      'loadCiWaitConfig',
      'pollForCI',
      'routeCiWait',
      'storePollResult',
      'terminateCITimedOut',
      'waitForCI',
    ]);
    expect(ciWaitEntry('signal')).toBe('waitForCI');
    expect(ciWaitEntry('pollOrSignal')).toBe('loadCiWaitConfig');
    expect(nodes.routeCiWait).toMatchObject({ onFalse: 'waitForCI', onTrue: 'pollForCI' });
    // The poll's `ciPassed` is remapped to `passed`, so the raw step output is never read as a gate.
    expect(nodes.storePollResult).toMatchObject({
      values: { 'context.ciResultPayload.passed': { from: 'nodes.pollForCI.output.ciPassed' } },
    });
    expectWellFormed({ ...nodes, checkCI: checkCiStub }, 'loadCiWaitConfig');
  });
});

const checkCiStub = {
  expr: 'x == 1',
  group: 'CI loop',
  onFalse: 'terminateCITimedOut',
  onTrue: 'terminateCITimedOut',
  title: 'stub',
  type: 'cond',
} as const;

describe('ciLoop', () => {
  it('with a repush handoff: the fix loop closes back on the signal wait', () => {
    const nodes = ciLoop({
      fix: { handoff: { repush: 'repushAfterCIFix' } },
      passed: 'finish',
    });
    expect(Object.keys(nodes).sort()).toEqual([
      'checkCI',
      'checkCILimit',
      'ciFix',
      'fetchLogs',
      'incCIRetries',
      'repushAfterCIFix',
      'storeLogs',
      'terminateCIFailed',
      'terminateCITimedOut',
      'updateCodeAfterCIFix',
      'waitForCI',
    ]);
    expect(nodes.checkCI).toMatchObject({ onFalse: 'incCIRetries', onTrue: 'finish' });
    expect(nodes.updateCodeAfterCIFix).toMatchObject({ next: 'repushAfterCIFix' });
    expect(nodes.repushAfterCIFix).toMatchObject({
      next: 'waitForCI',
      step: 'createOrUpdatePullRequest',
    });
    expectWellFormed(nodes, 'waitForCI', ['finish']);
  });

  it('retryIfUnchanged routes a no-op fix back to the attempt counter, never to the CI wait', () => {
    const nodes = ciLoop({
      fix: { handoff: { repush: 'repushAfterFix' }, retryIfUnchanged: true },
      passed: 'finish',
    });
    expect(nodes.ciFix).toMatchObject({ next: 'checkCiFixChanged' });
    expect(nodes.checkCiFixChanged).toMatchObject({
      expr: 'nodes.ciFix.output.headSha == context.currentCodeResult.headSha',
      onFalse: 'updateCodeAfterCIFix',
      onTrue: 'incCIRetries',
    });
    const plain = ciLoop({ fix: { handoff: { repush: 'repushAfterFix' } }, passed: 'finish' });
    expect('checkCiFixChanged' in plain).toBe(false);
    expect(plain.ciFix).toMatchObject({ next: 'updateCodeAfterCIFix' });
  });

  it('lets the repush step take a different id', () => {
    const nodes = ciLoop({ fix: { handoff: { repush: 'repushAfterFix' } }, passed: 'f' });
    expect(nodes.repushAfterCIFix).toBeUndefined();
    expect(nodes.updateCodeAfterCIFix).toMatchObject({ next: 'repushAfterFix' });
  });

  it('with a rereview handoff: the fix clears the CI result and re-enters the review', () => {
    const nodes = ciLoop({
      fix: { handoff: { rereview: 'setReviewing' } },
      passed: 'merge',
      wait: 'pollOrSignal',
    });
    expect(nodes.updateCodeAfterCIFix).toMatchObject({ next: 'clearCiResult' });
    expect(nodes.clearCiResult).toMatchObject({
      next: 'setReviewing',
      values: { 'context.ciResultPayload': { literal: null } },
    });
    expect(nodes.repushAfterCIFix).toBeUndefined();
    expect(nodes.loadCiWaitConfig).toBeDefined();
    expectWellFormed(nodes, 'loadCiWaitConfig', ['merge', 'setReviewing']);
  });

  it('with fix: false it is a bare gate that fails on the first red CI', () => {
    const nodes = ciLoop({ fix: false, passed: 'finish' });
    expect(Object.keys(nodes).sort()).toEqual([
      'checkCI',
      'terminateCIFailed',
      'terminateCITimedOut',
      'waitForCI',
    ]);
    expect(nodes.checkCI).toMatchObject({ onFalse: 'terminateCIFailed', onTrue: 'finish' });
    expectWellFormed(nodes, 'waitForCI', ['finish']);
  });

  it('puts the attempt limit in the cond, 3 unless told otherwise', () => {
    const limit = (n?: number) =>
      ciLoop({ fix: { handoff: { repush: 'r' }, limit: n }, passed: 'f' }).checkCILimit;
    expect(limit()).toMatchObject({ expr: 'context.ciRetries >= 3' });
    expect(limit(6)).toMatchObject({ expr: 'context.ciRetries >= 6' });
  });

  it('reports the pull request on both CI terminals', () => {
    const nodes = ciLoop({ fix: false, passed: 'f' });
    for (const id of ['terminateCIFailed', 'terminateCITimedOut']) {
      expect(nodes[id]).toMatchObject({
        result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
      });
    }
    expect(nodes.terminateCIFailed).toMatchObject({ status: 'FAILED' });
    expect(nodes.terminateCITimedOut).toMatchObject({ status: 'TIMED_OUT' });
  });
});
