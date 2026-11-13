import { SetupBlockerKindSchema } from '@auto-swe/shared/lib/setupBlocker';
import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  cancel: vi.fn(),
  capture: vi.fn(),
  create: vi.fn(),
  denied: vi.fn(),
  destroy: vi.fn(),
  finish: vi.fn(),
  preview: vi.fn(),
  record: vi.fn(),
  repo: vi.fn(),
  resolve: vi.fn(),
  setup: vi.fn(),
  stop: vi.fn(),
  tail: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { connection: { findUniqueOrThrow: m.repo } } }));
vi.mock('@temporalio/activity', async (original) => ({
  ...(await original<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: async () => ({ authedCloneUrl: 'https://github.com/acme/api.git' }),
  }),
  toRepoRef: (repo: unknown) => repo,
}));
vi.mock('./workspace.js', () => ({ createWorkspace: m.create }));
vi.mock('../lib/repoSetupRun.js', () => ({
  failedStepBlocker: m.denied,
  WORKSPACE_SETUP_FAILED: 'WORKSPACE_SETUP_FAILED',
}));
vi.mock('../lib/setupBlockerRecorder.js', () => ({
  recordSetupFailure: m.record,
  resolveSetupBlockers: m.resolve,
}));
vi.mock('../lib/cancellation.js', () => ({ throwIfActivityCancelled: m.cancel }));
vi.mock('../lib/appPreview.js', async (original) => ({
  ...(await original<typeof import('../lib/appPreview.js')>()),
  startAppPreview: m.preview,
}));

import { PreviewNotReadyError } from '../lib/appPreview.js';
import { repoOnboardingTrial } from './repoOnboardingTrial.js';

const config = {
  readyUrl: 'http://localhost:3000/',
  services: [{ env: { POSTGRES_PASSWORD: 'fixture' }, image: 'postgres:18', name: 'db' }],
  start: 'npm start',
};
const draft = {
  gateCommands: { runLint: '  npm run lint  ', runTests: 'npm test' },
  previewConfig: config,
  setup: { steps: [{ name: 'install', run: 'npm ci' }] },
};
const input = { connectionId: 'repo-1', draft };
beforeEach(() => {
  vi.resetAllMocks();
  m.repo.mockResolvedValue({
    defaultBranch: 'develop',
    detectedStack: null,
    id: 'repo-1',
    teamId: 'team-1',
  });
  m.capture.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'ok' });
  m.create.mockResolvedValue({
    destroy: m.destroy,
    execCapture: m.capture,
    finishSetup: m.finish,
    redact: (text: string) => text.replaceAll('known-secret-value', '***'),
    runSetup: m.setup,
  });
  m.preview.mockResolvedValue({ logTail: m.tail, stop: m.stop });
  m.tail.mockResolvedValue('ready');
  m.denied.mockImplementation(async (_started, fallback) => fallback);
});

describe('repoOnboardingTrial', () => {
  it('runs the exact draft in a fresh base-branch workspace with services, then cleans up', async () => {
    const result = await repoOnboardingTrial(input);
    expect(result).toMatchObject({ blockers: [], repairable: false, trialPassed: true });
    expect(result).not.toHaveProperty('passed');
    expect(result.items.map((item) => item.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
    expect(m.create).toHaveBeenCalledWith(
      'https://github.com/acme/api.git',
      expect.stringMatching(/^auto\/onboarding-trial-/),
      'develop',
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        inheritSetupEgress: true,
        repoSetup: {
          allowTeamSecrets: false,
          connectionId: 'repo-1',
          defer: true,
          field: draft.setup,
          recordBlockers: false,
        },
        services: config.services,
      })
    );
    expect(m.capture.mock.calls).toEqual([
      ['  npm run lint  ', { timeoutMs: 600000 }],
      ['npm test', { timeoutMs: 600000 }],
    ]);
    expect(m.setup.mock.invocationCallOrder[0]).toBeLessThan(
      m.capture.mock.invocationCallOrder[0] ?? 0
    );
    expect(m.preview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(config), {
      allowTeamSecrets: false,
      connectionId: 'repo-1',
    });
    expect(m.stop).toHaveBeenCalledOnce();
    expect(m.destroy).toHaveBeenCalledOnce();
    expect(m.record).not.toHaveBeenCalled();
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it.each(SetupBlockerKindSchema.options)(
    'extracts a %s setup blocker, computes repairability and skips remaining items',
    async (kind) => {
      const blocker = { detail: 'failure', kind, step: 'install', subject: 'subject' };
      m.setup.mockRejectedValue(
        ApplicationFailure.create({
          details: [blocker],
          message: 'setup failed',
          type: 'WORKSPACE_SETUP_FAILED',
        })
      );
      const result = await repoOnboardingTrial(input);
      expect(result.blockers).toEqual([blocker]);
      expect(result.trialPassed).toBe(false);
      expect(result.repairable).toBe(
        ['missing_tool', 'step_failed', 'step_timeout', 'invalid_config', 'secret_leak'].includes(
          kind
        )
      );
      expect(result.items.map((item) => item.status)).toEqual([
        'failed',
        'skipped',
        'skipped',
        'skipped',
      ]);
      expect(result.markdown).toContain(kind);
      expect(m.capture).not.toHaveBeenCalled();
      expect(m.preview).not.toHaveBeenCalled();
      expect(m.destroy).toHaveBeenCalledOnce();
      expect(m.record).not.toHaveBeenCalled();
      expect(m.resolve).not.toHaveBeenCalled();
    }
  );

  it('reports provisioning failure without running gates or leaking credential-shaped output', async () => {
    m.create.mockRejectedValue(new Error('clone failed https://user:password@github.com/repo'));
    const result = await repoOnboardingTrial(input);
    expect(result).toMatchObject({
      blockers: [{ kind: 'internal' }],
      repairable: false,
      trialPassed: false,
    });
    expect(JSON.stringify(result)).not.toContain('user:password');
    expect(m.capture).not.toHaveBeenCalled();
    expect(m.destroy).not.toHaveBeenCalled();
  });

  it('continues after a gate failure and bounds and redacts diagnostics', async () => {
    m.capture.mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'known-secret-value NPM_TOKEN=hidden-token-value',
      stdout: 'x'.repeat(10000),
    });
    const result = await repoOnboardingTrial(input);
    expect(result).toMatchObject({
      blockers: [{ kind: 'step_failed' }],
      repairable: true,
      trialPassed: false,
    });
    expect(result.items[1]).toMatchObject({ exitCode: 1, status: 'failed' });
    expect(result.items[1]?.logTail?.length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(result)).not.toMatch(/known-secret-value|hidden-token-value/);
    expect(result.items[2]?.status).toBe('passed');
    expect(m.preview).toHaveBeenCalledOnce();
    expect(m.stop).toHaveBeenCalledOnce();
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('treats a timed-out gate as a failure even with exit code zero', async () => {
    m.capture.mockResolvedValueOnce({ exitCode: 0, signal: 'SIGTERM', stderr: '', stdout: '' });
    expect(await repoOnboardingTrial(input)).toMatchObject({
      blockers: [{ kind: 'step_timeout' }],
      repairable: true,
      trialPassed: false,
    });
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('reports denied egress as operator-only rather than asking an agent to repair it', async () => {
    m.capture.mockResolvedValueOnce({ exitCode: 1, stderr: 'network failure', stdout: '' });
    m.denied.mockImplementation(async (_started, fallback) => ({
      ...fallback,
      kind: 'egress_denied',
      subject: 'registry.example.com',
    }));
    expect(await repoOnboardingTrial(input)).toMatchObject({
      blockers: expect.arrayContaining([
        { detail: expect.any(String), kind: 'egress_denied', subject: 'registry.example.com' },
      ]),
      repairable: false,
    });
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('returns preview not-ready with its redacted log and destroys the workspace', async () => {
    m.preview.mockRejectedValue(new PreviewNotReadyError('not ready', 'known-secret-value'));
    const result = await repoOnboardingTrial(input);
    expect(result).toMatchObject({ repairable: true, trialPassed: false });
    expect(result.items.at(-1)).toMatchObject({
      kind: 'preview',
      logTail: '***',
      status: 'failed',
    });
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('handles absent preview and empty commands without using fallbacks', async () => {
    const result = await repoOnboardingTrial({
      connectionId: 'repo-1',
      draft: { gateCommands: { runLint: ' ', runTests: null }, setup: {} },
    });
    expect(result).toMatchObject({ repairable: false, trialPassed: true });
    expect(result.items.map((item) => item.status)).toEqual(['passed', 'skipped', 'skipped']);
    expect(m.capture).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('continues cleanup when preview stop fails and reports the internal failure', async () => {
    m.stop.mockRejectedValue(new Error('stop failed'));
    expect(await repoOnboardingTrial(input)).toMatchObject({
      blockers: [{ kind: 'internal' }],
      repairable: false,
      trialPassed: false,
    });
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('reports workspace destruction failure without dropping the report', async () => {
    m.destroy.mockRejectedValue(new Error('destroy failed'));
    expect(await repoOnboardingTrial(input)).toMatchObject({
      blockers: [{ kind: 'internal' }],
      repairable: false,
      trialPassed: false,
    });
  });

  it('destroys the workspace when command execution throws', async () => {
    m.capture.mockRejectedValue(new Error('executor unavailable'));
    expect(await repoOnboardingTrial(input)).toMatchObject({
      repairable: false,
      trialPassed: false,
    });
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('propagates cancellation while still destroying the workspace', async () => {
    const error = new Error('cancelled');
    m.cancel.mockImplementation(() => {
      throw error;
    });
    await expect(repoOnboardingTrial(input)).rejects.toBe(error);
    expect(m.destroy).toHaveBeenCalledOnce();
  });

  it('refuses an invalid draft before provisioning', async () => {
    await expect(repoOnboardingTrial({ connectionId: 'repo-1', draft: {} })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'ONBOARDING_TRIAL_REFUSED',
    });
    expect(m.create).not.toHaveBeenCalled();
  });
});
