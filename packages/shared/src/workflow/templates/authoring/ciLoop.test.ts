import { describe, expect, it } from 'vitest';
import { CI_ATTEMPTS_PATH, ciLoop, ciWaitEntry, waitForCi } from './ciLoop.js';
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
      'ciFix',
      'fetchLogs',
      'repushAfterCIFix',
      'terminateCIFailed',
      'terminateCITimedOut',
      'waitForCI',
    ]);
    expect(nodes.checkCI).toMatchObject({ onFalse: 'fetchLogs', onTrue: 'finish' });
    // The log fetch holds the budget (two fixes of three failures) and keeps its output.
    expect(nodes.fetchLogs).toMatchObject({
      maxVisits: 2,
      next: 'ciFix',
      onExhausted: 'terminateCIFailed',
      storeAs: 'context.lastCILogs',
    });
    expect(nodes.ciFix).toMatchObject({
      next: 'repushAfterCIFix',
      storeAs: 'context.currentCodeResult',
    });
    expect(nodes.repushAfterCIFix).toMatchObject({
      next: 'waitForCI',
      step: 'createOrUpdatePullRequest',
    });
    expectWellFormed(nodes, 'waitForCI', ['finish']);
  });

  it('retryIfUnchanged routes a no-op fix back to spend an attempt, never to the CI wait', () => {
    const nodes = ciLoop({
      fix: { handoff: { repush: 'repushAfterFix' }, retryIfUnchanged: true },
      passed: 'finish',
    });
    // The head is compared before the new code replaces the old, so `ciFix` stores nothing itself.
    expect(nodes.ciFix).toMatchObject({ next: 'checkCiFixChanged' });
    expect(nodes.ciFix).not.toHaveProperty('storeAs');
    expect(nodes.checkCiFixChanged).toMatchObject({
      expr: 'nodes.ciFix.output.headSha == context.currentCodeResult.headSha',
      onFalse: 'updateCodeAfterCIFix',
      onTrue: 'fetchLogs',
    });
    expect(nodes.updateCodeAfterCIFix).toMatchObject({ next: 'repushAfterFix' });
    const plain = ciLoop({ fix: { handoff: { repush: 'repushAfterFix' } }, passed: 'finish' });
    expect('checkCiFixChanged' in plain).toBe(false);
    expect('updateCodeAfterCIFix' in plain).toBe(false);
    expect(plain.ciFix).toMatchObject({ next: 'repushAfterFix' });
  });

  it('with pollOrSignal, a repush re-enters the wait through the poll-or-signal router', () => {
    const nodes = ciLoop({
      fix: { handoff: { repush: 'repushAfterFix' } },
      passed: 'finish',
      wait: 'pollOrSignal',
    });
    expect(nodes.repushAfterFix).toMatchObject({ next: 'loadCiWaitConfig' });
    expectWellFormed(nodes, 'loadCiWaitConfig', ['finish']);
  });

  it('lets the repush step take a different id', () => {
    const nodes = ciLoop({ fix: { handoff: { repush: 'repushAfterFix' } }, passed: 'f' });
    expect(nodes.repushAfterCIFix).toBeUndefined();
    expect(nodes.ciFix).toMatchObject({ next: 'repushAfterFix' });
  });

  it('can stamp a status on the repush step', () => {
    const nodes = ciLoop({
      fix: { handoff: { repush: 'repushAfterFix', status: 'AWAITING_CI' } },
      passed: 'f',
    });
    expect(nodes.repushAfterFix).toMatchObject({ status: 'AWAITING_CI' });
  });

  it('with a rereview handoff: the fix clears the CI result and re-enters the review', () => {
    const nodes = ciLoop({
      fix: { handoff: { rereview: 'review' } },
      passed: 'merge',
      wait: 'pollOrSignal',
    });
    expect(nodes.ciFix).toMatchObject({ next: 'clearCiResult' });
    expect(nodes.clearCiResult).toMatchObject({
      next: 'review',
      values: { 'context.ciResultPayload': { literal: null } },
    });
    expect(nodes.repushAfterCIFix).toBeUndefined();
    expect(nodes.loadCiWaitConfig).toBeDefined();
    expectWellFormed(nodes, 'loadCiWaitConfig', ['merge', 'review']);
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

  it('bounds the fixes with maxVisits on the log fetch: limit - 1, 2 unless told otherwise', () => {
    const fetch = (n?: number) =>
      ciLoop({ fix: { handoff: { repush: 'r' }, limit: n }, passed: 'f' }).fetchLogs;
    expect(fetch()).toMatchObject({ maxVisits: 2 });
    expect(fetch(6)).toMatchObject({ maxVisits: 5 });
    expect(() => fetch(1)).toThrow(/at least 2/);
  });

  it('exports the path a template resets to give a rejected change a fresh CI budget', () => {
    expect(CI_ATTEMPTS_PATH).toBe('nodes.fetchLogs.visits');
  });

  it('takes the limit as an expression, which keeps a counter (maxVisits is a constant)', () => {
    const nodes = ciLoop({
      fix: { handoff: { repush: 'r' }, limit: 'request.payload.n ?? 2' },
      passed: 'f',
    });
    expect(nodes.checkCILimit).toMatchObject({
      expr: 'context.ciRetries >= (request.payload.n ?? 2)',
      onFalse: 'fetchLogs',
    });
    expect(nodes.checkCI).toMatchObject({ onFalse: 'incCIRetries' });
    expect(nodes.incCIRetries).toMatchObject({
      next: 'checkCILimit',
      values: { 'context.ciRetries': { expr: 'context.ciRetries + 1' } },
    });
    expect(nodes.fetchLogs).not.toHaveProperty('maxVisits');
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
