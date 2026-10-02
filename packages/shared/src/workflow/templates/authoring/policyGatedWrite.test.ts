import { describe, expect, it } from 'vitest';
import type { PolicyGatedWriteOptions } from './policyGatedWrite.js';
import { policyGatedWrite } from './policyGatedWrite.js';
import { expectWellFormed } from './testUtil.js';

const opts = (over: Partial<PolicyGatedWriteOptions> = {}): PolicyGatedWriteOptions => ({
  action: 'external_write',
  approval: { contextFrom: 'request.payload.title', description: 'Approve it', title: 'Approve' },
  describeFrom: 'request.payload.title',
  rejectedResult: { approved: { literal: false } },
  write: { inputs: { title: { from: 'request.payload.title' } } },
  writes: 'split',
  ...over,
});

// humanApproval is the node that carries the inbox title, which the helper must not overwrite.
const expectGated = (nodes: ReturnType<typeof policyGatedWrite>) =>
  expectWellFormed(nodes, 'publishOutcome', ['done']);

describe('policyGatedWrite', () => {
  it('split: auto and manual writes are separate nodes with the same call', () => {
    const nodes = policyGatedWrite(opts());
    expect(Object.keys(nodes).sort()).toEqual([
      'autoWrite',
      'checkAuto',
      'doneRejected',
      'humanApproval',
      'manualWrite',
      'publishOutcome',
    ]);
    expectGated(nodes);
    expect(nodes.checkAuto).toMatchObject({ onFalse: 'autoWrite', onTrue: 'humanApproval' });
    expect(nodes.humanApproval).toMatchObject({ onApprove: 'manualWrite' });
    const { title: _a, ...auto } = nodes.autoWrite as Record<string, unknown>;
    const { title: _m, ...manual } = nodes.manualWrite as Record<string, unknown>;
    expect(auto).toEqual(manual);
  });

  it('single: one writeOutcome serves both paths', () => {
    const nodes = policyGatedWrite(opts({ writes: 'single' }));
    expect(nodes.autoWrite).toBeUndefined();
    expect(nodes.manualWrite).toBeUndefined();
    expect(nodes.checkAuto).toMatchObject({ onFalse: 'writeOutcome' });
    expect(nodes.humanApproval).toMatchObject({ onApprove: 'writeOutcome' });
    expectGated(nodes);
  });

  it('never routes publishOutcome into a write without the cond between them', () => {
    const nodes = policyGatedWrite(opts());
    expect(nodes.publishOutcome).toMatchObject({ next: 'checkAuto' });
    expect(nodes.checkAuto).toMatchObject({
      expr: "nodes.publishOutcome.output.decision == 'require_approval'",
      type: 'cond',
    });
  });

  it('rejection and timeout both end in doneRejected, which reports nothing was written', () => {
    const nodes = policyGatedWrite(opts());
    expect(nodes.humanApproval).toMatchObject({
      onReject: 'doneRejected',
      onTimeout: 'doneRejected',
      timeout: '24h',
    });
    expect(nodes.doneRejected).toMatchObject({
      result: { approved: { literal: false } },
      status: 'SUCCESS',
    });
  });

  it('uses the approval text as the inbox title and never stamps over it', () => {
    const nodes = policyGatedWrite(
      opts({ approval: { contextFrom: 'x', description: 'D', title: 'Inbox heading' } })
    );
    expect(nodes.humanApproval).toMatchObject({ description: 'D', title: 'Inbox heading' });
    expect(nodes.humanApproval.group).toBe('policy gate');
  });

  it('passes the policy action and approver count through', () => {
    const nodes = policyGatedWrite(opts({ action: 'external_communication' }));
    expect(nodes.publishOutcome).toMatchObject({
      config: { action: 'external_communication' },
      inputs: { description: { from: 'request.payload.title' } },
    });
    expect(nodes.humanApproval).toMatchObject({
      approverCount: { from: 'nodes.publishOutcome.output.approverCount' },
    });
  });

  it('keeps an explicit empty write config (writeOutcome tolerates {}), and omits an absent one', () => {
    const withConfig = policyGatedWrite(
      opts({ write: { config: {}, inputs: {} }, writes: 'single' })
    );
    expect(withConfig.writeOutcome).toMatchObject({ config: {} });
    expect('config' in policyGatedWrite(opts()).autoWrite).toBe(false);
  });

  it('does not let the two write nodes share inputs', () => {
    const nodes = policyGatedWrite(opts());
    expect((nodes.autoWrite as { inputs: object }).inputs).not.toBe(
      (nodes.manualWrite as { inputs: object }).inputs
    );
  });

  it('can hand a successful write to a node other than done', () => {
    const nodes = policyGatedWrite(opts({ done: 'finish' }));
    expect(nodes.autoWrite).toMatchObject({ next: 'finish' });
    expect(nodes.manualWrite).toMatchObject({ next: 'finish' });
  });
});
