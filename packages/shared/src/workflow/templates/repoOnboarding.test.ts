import { describe, expect, it } from 'vitest';
import { RepoOnboardingDraftSchema } from '../../lib/onboardingPr.js';
import type { Context } from '../expr.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import { parseWorkflowSpec } from '../spec.js';
import { validateSpec } from '../validateSpec.js';
import { BUILTIN_TEMPLATES } from './index.js';
import { REPO_ONBOARDING_SPEC as spec } from './repoOnboarding.js';

const draft = RepoOnboardingDraftSchema.parse({
  setup: { steps: [] },
  gateCommands: { runTests: 'node --test' },
});
const valid = { valid: true, draft, markdown: 'Draft markdown' };
const invalid = { valid: false, error: 'bad JSON', markdown: 'Invalid JSON' };
const success = { trialPassed: true, repairable: false, markdown: 'Trial passed', blockers: [] };

async function run(
  options: {
    parses?: Record<string, unknown>[];
    trials?: Record<string, unknown>[];
    signals?: unknown[];
  } = {}
) {
  const calls: Array<{
    nodeId: string;
    inputs: Record<string, unknown>;
    config: Record<string, unknown>;
  }> = [];
  const reviews: unknown[] = [];
  const signals = [...(options.signals ?? [{ action: 'approve' }])];
  let parseRound = 0;
  let trialRound = 0;
  const ctx: Context = {
    context: {},
    nodes: {},
    request: { repoId: 'repo-1', payload: { connectionId: 'repo-1' } },
    workflow: { id: 'wf-1' },
  };
  const dispatcher: Dispatcher = {
    async dispatchStep({ nodeId, inputs, config }) {
      calls.push({ nodeId, inputs, config });
      if (nodeId === 'draft') {
        return { text: 'draft reply' };
      }
      if (nodeId === 'parse') {
        const outputs = options.parses ?? [valid];
        return outputs[Math.min(parseRound++, outputs.length - 1)];
      }
      if (nodeId === 'trial') {
        const outputs = options.trials ?? [success];
        return outputs[Math.min(trialRound++, outputs.length - 1)];
      }
      if (nodeId === 'deliver') {
        return { prUrl: 'https://example.test/pull/1' };
      }
      throw new Error(`Unexpected dispatch ${nodeId}`);
    },
    async notifyHumanStep({ context }) {
      reviews.push(structuredClone(context));
    },
    async resolveHumanStep() {},
    async recordStep() {},
    async waitSignal() {
      return signals.shift();
    },
  };
  const result = await runSpec(parseWorkflowSpec(spec), ctx, dispatcher);
  return {
    result,
    calls,
    reviews,
    draftCalls: calls.filter((call) => call.nodeId === 'draft'),
    delivered: calls.filter((call) => call.nodeId === 'deliver'),
  };
}

describe('repository onboarding', () => {
  it('is a valid, registered git-repository template with exactly three draft visits', () => {
    expect(validateSpec(parseWorkflowSpec(spec)).errors).toEqual([]);
    expect(spec.nodes.draft).toMatchObject({
      type: 'agent',
      workspace: true,
      agentRef: 'repo-onboarder',
      maxVisits: 3,
      onExhausted: 'review',
    });
    const builtin = BUILTIN_TEMPLATES.find((template) => template.name === spec.name);
    expect(builtin?.kind).toBeUndefined();
    expect(builtin?.inputSchema).toEqual({
      type: 'object',
      properties: { connectionId: { type: 'connection', connectionType: 'git_repo' } },
      required: ['connectionId'],
    });
  });

  it('shows both reports and opens one PR only after approval', async () => {
    const outcome = await run();
    expect(outcome.calls.map(({ nodeId }) => nodeId)).toEqual([
      'draft',
      'parse',
      'trial',
      'deliver',
    ]);
    expect(outcome.reviews).toEqual([
      expect.objectContaining({
        draftMarkdown: valid.markdown,
        trialMarkdown: success.markdown,
        trialAppliesToCurrentDraft: true,
      }),
    ]);
    expect(outcome.delivered[0]?.inputs).toEqual({ connectionId: 'repo-1', draft });
    expect(outcome.result.status).toBe('SUCCESS');
    expect(outcome.draftCalls[0]?.config).not.toHaveProperty('userMessage');
    expect(outcome.draftCalls[0]?.inputs).toMatchObject({
      parseError: '',
      trialReport: '',
      previousDraft: null,
    });
  });

  it('returns invalid output to draft with the parse error in resolved inputs', async () => {
    const outcome = await run({ parses: [invalid, valid] });
    expect(outcome.draftCalls).toHaveLength(2);
    expect(outcome.draftCalls[1]?.inputs.parseError).toBe('bad JSON');
    expect(outcome.calls.filter(({ nodeId }) => nodeId === 'trial')).toHaveLength(1);
    expect(outcome.delivered).toHaveLength(1);
  });

  it('returns repairable trials to draft with the trial markdown and previous draft', async () => {
    const outcome = await run({
      trials: [
        {
          ...success,
          trialPassed: false,
          repairable: true,
          markdown: 'Install the missing dependency',
        },
        success,
      ],
    });
    expect(outcome.draftCalls).toHaveLength(2);
    expect(outcome.draftCalls[1]?.inputs).toMatchObject({
      trialReport: 'Install the missing dependency',
      previousDraft: draft,
    });
    expect(outcome.delivered).toHaveLength(1);
  });

  it('routes operator-only failures to review, where a failed trial can be approved', async () => {
    const outcome = await run({
      trials: [
        {
          ...success,
          trialPassed: false,
          markdown: 'Missing secret TOKEN',
          blockers: [{ kind: 'missing_secret', subject: 'TOKEN', detail: 'Not configured' }],
        },
      ],
    });
    expect(outcome.draftCalls).toHaveLength(1);
    expect(outcome.reviews[0]).toMatchObject({ trialMarkdown: 'Missing secret TOKEN' });
    expect(outcome.delivered).toHaveLength(1);
  });

  it('exhausts invalid drafts into review but refuses delivery even when approved', async () => {
    const outcome = await run({ parses: [invalid] });
    expect(outcome.draftCalls).toHaveLength(3);
    expect(outcome.reviews[0]).toMatchObject({
      status: expect.stringContaining('No valid draft'),
      draftMarkdown: 'Invalid JSON',
      trialMarkdown: 'No trial has run.',
      trialAppliesToCurrentDraft: false,
    });
    expect(outcome.delivered).toHaveLength(0);
    expect(outcome.result.status).toBe('FAILED');
  });

  it('bounds repeated repairable failures and reviews the last valid draft', async () => {
    const outcome = await run({ trials: [{ ...success, trialPassed: false, repairable: true }] });
    expect(outcome.draftCalls).toHaveLength(3);
    expect(outcome.calls.filter(({ nodeId }) => nodeId === 'trial')).toHaveLength(3);
    expect(outcome.delivered).toHaveLength(1);
  });

  it('marks a previous trial as inapplicable when the final parse is invalid', async () => {
    const outcome = await run({
      parses: [valid, invalid],
      trials: [{ ...success, trialPassed: false, repairable: true }],
    });
    expect(outcome.reviews[0]).toMatchObject({
      trialAppliesToCurrentDraft: false,
      status: expect.stringContaining('No valid draft'),
    });
    expect(outcome.delivered).toHaveLength(0);
  });

  it('threads human requested changes back to the drafting agent', async () => {
    const outcome = await run({
      signals: [{ action: 'request_changes', comment: 'Use the lockfile' }, { action: 'approve' }],
    });
    expect(outcome.draftCalls[1]?.inputs.humanFeedback).toMatchObject({
      comment: 'Use the lockfile',
    });
    expect(outcome.reviews).toHaveLength(2);
    expect(outcome.delivered).toHaveLength(1);
  });

  it.each([{ action: 'reject' }, undefined])(
    'does not deliver on rejection or timeout: %j',
    async (signal) => {
      const outcome = await run({ signals: [signal] });
      expect(outcome.delivered).toHaveLength(0);
      expect(outcome.result.status).toBe('FAILED');
    }
  );

  it('does not reset the visit budget for human requests after exhaustion', async () => {
    const outcome = await run({
      trials: [{ ...success, trialPassed: false, repairable: true }],
      signals: [{ action: 'request_changes', comment: 'again' }, { action: 'approve' }],
    });
    expect(outcome.draftCalls).toHaveLength(3);
    expect(outcome.reviews).toHaveLength(2);
    expect(outcome.delivered).toHaveLength(1);
  });
});
