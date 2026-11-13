import { renderOnboardingFiles } from '@auto-swe/shared/lib/onboardingPr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ hash: vi.fn(), launcher: vi.fn(), open: vi.fn() }));
vi.mock('../lib/runLauncher.js', () => ({ currentRunLauncherId: m.launcher }));
vi.mock('./openOnboardingPr.js', () => ({ contentHashOf: m.hash, openOnboardingPr: m.open }));

import { repoOnboardingPr } from './repoOnboardingPr.js';

const draft = {
  gateCommands: { runTests: 'npm test' },
  setup: { steps: [{ name: 'install', run: 'npm ci' }] },
};
const outcome = { changed: ['.auto-swe/setup.yml', '.auto-swe/gates.yml'], status: 'opened' };

beforeEach(() => {
  vi.resetAllMocks();
  m.launcher.mockResolvedValue('launcher-1');
  m.hash.mockReturnValue('derived-hash');
  m.open.mockResolvedValue(outcome);
});

describe('repoOnboardingPr', () => {
  it('passes the trial report separately from the hashed files', async () => {
    await repoOnboardingPr({
      connectionId: 'repo-1',
      draft,
      trialReport: 'Trial failed: missing secret TOKEN',
    });
    expect(m.open.mock.calls[0]?.[0]).toMatchObject({
      contentHash: 'derived-hash',
      proposedById: 'launcher-1',
      trialReport: 'Trial failed: missing secret TOKEN',
    });
    const first = m.hash.mock.calls[0]?.[0];
    await repoOnboardingPr({ connectionId: 'repo-1', draft, trialReport: 'Trial passed' });
    expect(m.hash.mock.calls[1]?.[0]).toEqual(first);
  });
  it('derives hash and proposer, ignoring caller-supplied attribution and hash', async () => {
    const input = {
      connectionId: 'repo-1',
      contentHash: 'spoofed',
      draft,
      proposedById: 'attacker',
    };
    expect(await repoOnboardingPr(input)).toEqual(outcome);
    const files = [
      { kind: 'setup' as const, setup: draft.setup },
      { gateCommands: draft.gateCommands, kind: 'gates' as const },
    ];
    expect(m.hash).toHaveBeenCalledWith(renderOnboardingFiles({ files }));
    expect(m.open).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'repo-1',
      contentHash: 'derived-hash',
      files,
      proposedById: 'launcher-1',
    });
  });

  it.each([undefined, null])(
    'omits an unset preview (%s), and accepts empty definitions',
    async (previewConfig) => {
      await repoOnboardingPr({
        connectionId: 'repo-1',
        draft: { gateCommands: {}, previewConfig, setup: {} },
      });
      expect(m.open.mock.calls[0]?.[0].files).toEqual([
        { kind: 'setup', setup: {} },
        { gateCommands: {}, kind: 'gates' },
      ]);
    }
  );

  it('delivers a validated preview with normalized defaults', async () => {
    await repoOnboardingPr({
      connectionId: 'repo-1',
      draft: {
        ...draft,
        previewConfig: { readyUrl: 'http://localhost:3000/', start: 'npm start' },
      },
    });
    expect(m.open.mock.calls[0]?.[0].files[2]).toEqual({
      kind: 'preview',
      previewConfig: {
        baseUrl: 'http://localhost:3000',
        readyTimeoutMs: 180000,
        readyUrl: 'http://localhost:3000/',
        start: 'npm start',
      },
    });
  });

  it.each([null, {}, { ...draft, gateCommands: { unknown: 'bad' } }])(
    'refuses invalid drafts before delivery: %j',
    async (value) => {
      await expect(
        repoOnboardingPr({ connectionId: 'repo-1', draft: value })
      ).rejects.toMatchObject({ nonRetryable: true, type: 'ONBOARDING_PR_REFUSED' });
      expect(m.launcher).not.toHaveBeenCalled();
      expect(m.open).not.toHaveBeenCalled();
    }
  );

  it('refuses a run with no verified launcher', async () => {
    m.launcher.mockResolvedValue(null);
    await expect(repoOnboardingPr({ connectionId: 'repo-1', draft })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'ONBOARDING_PR_REFUSED',
    });
    expect(m.open).not.toHaveBeenCalled();
  });

  it('propagates launcher lookup failures rather than falling back to another identity', async () => {
    const error = new Error('database unavailable');
    m.launcher.mockRejectedValue(error);
    await expect(repoOnboardingPr({ connectionId: 'repo-1', draft })).rejects.toBe(error);
    expect(m.open).not.toHaveBeenCalled();
  });

  it('refuses an unrenderable draft without retrying delivery', async () => {
    const env = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`VALUE_${i}`, 'x'.repeat(4000)])
    );
    await expect(
      repoOnboardingPr({
        connectionId: 'repo-1',
        draft: {
          ...draft,
          previewConfig: { env, readyUrl: 'http://localhost:3000/', start: 'npm start' },
        },
      })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'ONBOARDING_PR_REFUSED' });
    expect(m.open).not.toHaveBeenCalled();
  });

  it('propagates transient delivery failures for the activity retry policy', async () => {
    const error = new Error('network unavailable');
    m.open.mockRejectedValue(error);
    await expect(repoOnboardingPr({ connectionId: 'repo-1', draft })).rejects.toBe(error);
  });
});
