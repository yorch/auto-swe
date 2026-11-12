import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ deliver: vi.fn(), parse: vi.fn(), trial: vi.fn() }));
vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return {
    ...actual,
    genericActivities: { ...actual.genericActivities, parseAgentOutput: m.parse },
    onboardingPrActivities: { repoOnboardingPr: m.deliver },
    onboardingTrialActivities: { repoOnboardingTrial: m.trial },
  };
});

const { dispatchStepImpl } = await import('./runnableSteps.js');
const ctx = {
  context: { workspace: { connectionId: 'run-repo' } },
  workflow: { id: 'wf-1' },
} as never;
const request = {} as never;
beforeEach(() => vi.clearAllMocks());

describe('onboarding spec steps', () => {
  it.each([undefined, 'bound-repo'])(
    'dispatches trial draft and bound or workspace connection (%s)',
    async (connectionId) => {
      const draft = { gateCommands: {}, setup: {} };
      m.trial.mockResolvedValue({ repairable: true, trialPassed: false });
      expect(
        await dispatchStepImpl(
          'repoOnboardingTrial',
          ctx,
          request,
          {},
          { connectionId, draft },
          'trial'
        )
      ).toEqual({ repairable: true, trialPassed: false });
      expect(m.trial).toHaveBeenCalledWith({ connectionId: connectionId ?? 'run-repo', draft });
    }
  );

  it('refuses trial without a repository', async () => {
    await expect(
      dispatchStepImpl('repoOnboardingTrial', { context: {} } as never, request, {}, {}, 'trial')
    ).rejects.toThrow('requires inputs.connectionId');
    expect(m.trial).not.toHaveBeenCalled();
  });
  it('dispatches the onboarding parser kind and text', async () => {
    m.parse.mockResolvedValue({ markdown: 'invalid', valid: false });
    expect(
      await dispatchStepImpl(
        'parseAgentOutput',
        ctx,
        request,
        { kind: 'repoOnboardingDraft' },
        { text: 'draft' },
        'parse'
      )
    ).toEqual({ markdown: 'invalid', valid: false });
    expect(m.parse).toHaveBeenCalledWith({ kind: 'repoOnboardingDraft', text: 'draft' });
  });

  it('passes only connection and draft to delivery', async () => {
    const draft = { gateCommands: {}, setup: {} };
    m.deliver.mockResolvedValue({ status: 'nothing_to_do' });
    expect(
      await dispatchStepImpl(
        'repoOnboardingPr',
        ctx,
        request,
        { proposedById: 'spoofed' },
        { connectionId: 'bound-repo', contentHash: 'spoofed', draft, proposedById: 'spoofed' },
        'deliver'
      )
    ).toEqual({ status: 'nothing_to_do' });
    expect(m.deliver).toHaveBeenCalledExactlyOnceWith({ connectionId: 'bound-repo', draft });
  });

  it('falls back to the run connection and leaves missing draft for activity validation', async () => {
    await dispatchStepImpl('repoOnboardingPr', ctx, request, {}, {}, 'deliver');
    expect(m.deliver).toHaveBeenCalledWith({ connectionId: 'run-repo', draft: undefined });
  });

  it('refuses a missing connection rather than inventing a target', async () => {
    await expect(
      dispatchStepImpl('repoOnboardingPr', { context: {} } as never, request, {}, {}, 'deliver')
    ).rejects.toThrow('requires inputs.connectionId');
    expect(m.deliver).not.toHaveBeenCalled();
  });
});
