import { describe, expect, it } from 'vitest';
import { openPullRequest } from './openPullRequest.js';
import { expectWellFormed } from './testUtil.js';

describe('openPullRequest', () => {
  it('opens the PR then records its number and url, then hands over to `next`', () => {
    const nodes = openPullRequest({ next: 'waitForCI' });
    expect(Object.keys(nodes).sort()).toEqual(['openPR', 'savePrInfo']);
    expect(nodes.openPR).toMatchObject({
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
    });
    expect(nodes.savePrInfo).toMatchObject({
      next: 'waitForCI',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    });
    expectWellFormed(nodes, 'openPR', ['waitForCI']);
  });

  it('does not touch the CI retry counter by default', () => {
    const values = (openPullRequest({ next: 'n' }).savePrInfo as { values: object }).values;
    expect(Object.keys(values)).not.toContain('context.ciRetries');
  });

  it('can reset the CI retry counter when the PR is recorded', () => {
    expect(openPullRequest({ next: 'n', resetCiRetries: true }).savePrInfo).toMatchObject({
      values: { 'context.ciRetries': { literal: 0 } },
    });
  });
});
