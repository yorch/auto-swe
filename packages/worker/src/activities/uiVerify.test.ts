import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  evidence: vi.fn(),
  findRepo: vi.fn(),
  preview: vi.fn(),
  resolveSetting: vi.fn(),
  startBrowser: vi.fn(),
  workspace: {
    destroy: vi.fn(),
    exec: vi.fn(),
    execCapture: vi.fn(),
    gitAuthed: vi.fn(),
    readFile: vi.fn(),
  },
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUniqueOrThrow: mocks.findRepo } },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: mocks.resolveSetting }));
vi.mock('@auto-swe/shared/lib/executorImage', () => ({ executorImageFor: () => 'executor:test' }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));
vi.mock('@auto-swe/shared/lib/workflowId', () => ({ workBranchOf: () => 'auto/T-1' }));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/requireRepoId.js', () => ({ requireRepoId: () => 'repo-1' }));
vi.mock('../lib/runBaseBranch.js', () => ({ resolveRequestBaseBranch: async () => 'main' }));
vi.mock('../lib/runDetection.js', () => ({ withRunDetection: (repo: unknown) => repo }));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({ cloneCredentials: async () => ({ authedCloneUrl: 'https://git/x' }) }),
  toRepoRef: () => ({ host: 'github.com', owner: 'o', repo: 'r' }),
}));
vi.mock('./workspace.js', () => ({
  createWorkspace: mocks.createWorkspace,
  fetchBranchesSubcommand: () => 'fetch',
  shellQuote: (value: string) => `'${value}'`,
}));
vi.mock('./qualityGates.js', () => ({ truncate: (value: string) => value }));
vi.mock('../lib/appPreview.js', () => ({
  PreviewNotReadyError: class PreviewNotReadyError extends Error {},
  startAppPreview: mocks.preview,
}));
vi.mock('../browser/session.js', () => ({ BrowserSession: { start: mocks.startBrowser } }));
vi.mock('../lib/runEvidence.js', () => ({ recordActivityEvidence: mocks.evidence }));

import { runUiVerify } from './uiVerify.js';

const request = { workRequestId: 'work-1' } as RepoWorkRequest;
const previewConfig = {
  readyUrl: 'http://localhost:3000/',
  smoke: [{ name: 'home', path: '/' }],
  start: 'npm start',
};

function sessionWith(call: (command: { cmd: string }) => unknown) {
  return {
    call: vi.fn(async (command: { cmd: string }) => call(command)),
    close: vi.fn(
      async (): Promise<{ errors: string[]; trace?: Buffer; video?: Buffer }> => ({ errors: [] })
    ),
    readOutFile: vi.fn(async () => Buffer.from('png')),
  };
}

describe('runUiVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evidence.mockResolvedValue({ artifactId: 'a-1', evidenceId: 'e-1', ok: true });
    mocks.resolveSetting.mockResolvedValue(5_000_000);
    mocks.createWorkspace.mockResolvedValue(mocks.workspace);
    mocks.workspace.exec.mockResolvedValue('');
    mocks.workspace.readFile.mockResolvedValue(Buffer.from('png'));
    mocks.preview.mockResolvedValue({
      baseUrl: 'http://localhost:3000',
      logTail: async () => 'app log',
      stop: async () => undefined,
    });
  });

  it('returns the exact successful skip result when no preview is configured', async () => {
    mocks.findRepo.mockResolvedValue({ previewConfig: null });

    await expect(runUiVerify({ request })).resolves.toEqual({
      exitCode: 0,
      passed: true,
      skipped: true,
      summary: 'UI verification skipped: the repository has no app preview configured',
    });
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
  });

  it('fails the gate when a navigation reports a driver error', async () => {
    mocks.findRepo
      .mockResolvedValueOnce({ previewConfig })
      .mockResolvedValue({ installation: null, previewConfig });
    mocks.startBrowser.mockResolvedValue(
      sessionWith((command) =>
        command.cmd === 'goto' ? { error: 'net::ERR_CONNECTION_REFUSED', ok: false } : { ok: true }
      )
    );

    const result = await runUiVerify({ request });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain('home: navigation failed: net::ERR_CONNECTION_REFUSED');
    expect(result.pages?.[0]?.status).toBeNull();
  });

  it('fails the gate when the screenshot command fails', async () => {
    mocks.findRepo
      .mockResolvedValueOnce({ previewConfig })
      .mockResolvedValue({ installation: null, previewConfig });
    mocks.startBrowser.mockResolvedValue(
      sessionWith((command) => {
        if (command.cmd === 'screenshot') {
          return { error: 'Target page closed', ok: false };
        }
        return { ok: true, status: 200, url: 'http://localhost:3000/' };
      })
    );

    const result = await runUiVerify({ request });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain('screenshot failed: Target page closed');
  });

  it('fails the gate when a waited-for selector never appears', async () => {
    mocks.findRepo
      .mockResolvedValueOnce({
        previewConfig: { ...previewConfig, smoke: [{ path: '/', waitFor: '#ready' }] },
      })
      .mockResolvedValue({ installation: null, previewConfig });
    mocks.startBrowser.mockResolvedValue(
      sessionWith((command) =>
        command.cmd === 'wait'
          ? { error: 'Timeout 30000ms exceeded', ok: false }
          : { ok: true, status: 200, url: 'http://localhost:3000/' }
      )
    );

    const result = await runUiVerify({ request });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain('wait for #ready failed: Timeout 30000ms exceeded');
  });

  it('still runs the smoke check when the browser records video and a trace', async () => {
    mocks.findRepo
      .mockResolvedValueOnce({ previewConfig })
      .mockResolvedValue({ installation: null, previewConfig });
    const session = sessionWith((command) =>
      command.cmd === 'goto'
        ? { ok: true, status: 200, url: 'http://localhost:3000/' }
        : command.cmd === 'screenshot'
          ? { file: '/tmp/.asw/browser/x/out/smoke-0.png', height: 800, ok: true, width: 1280 }
          : { console: [], ok: true, pageErrors: [] }
    );
    session.close.mockResolvedValue({
      errors: [],
      trace: Buffer.from('zip'),
      video: Buffer.from('webm'),
    });
    mocks.startBrowser.mockResolvedValue(session);

    const result = await runUiVerify({ request });

    expect(result.passed).toBe(true);
    expect(mocks.evidence).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'video/webm', kind: 'video', source: 'uiVerify' })
    );
    expect(mocks.evidence).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/zip', kind: 'trace' })
    );
    expect(result.evidenceIds).toEqual(['e-1', 'e-1', 'e-1', 'e-1']);
  });

  it('persists the trace when saving the recording fails', async () => {
    mocks.findRepo
      .mockResolvedValueOnce({ previewConfig })
      .mockResolvedValue({ installation: null, previewConfig });
    const session = sessionWith((command) =>
      command.cmd === 'goto'
        ? { ok: true, status: 200, url: 'http://localhost:3000/' }
        : command.cmd === 'screenshot'
          ? { file: '/tmp/.asw/browser/x/out/smoke-0.png', ok: true }
          : { console: [], ok: true, pageErrors: [] }
    );
    session.close.mockResolvedValue({
      errors: [],
      trace: Buffer.from('zip'),
      video: Buffer.from('webm'),
    });
    mocks.startBrowser.mockResolvedValue(session);
    mocks.evidence.mockImplementation(async (input: { kind: string }) => {
      if (input.kind === 'video') {
        throw new Error('artifact store unavailable');
      }
      return { artifactId: 'a-1', evidenceId: `e-${input.kind}`, ok: true };
    });

    const result = await runUiVerify({ request });

    expect(mocks.evidence).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/zip', kind: 'trace' })
    );
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('Could not save video evidence: artifact store unavailable');
  });

  it('reports evidence a cap dropped instead of failing the gate', async () => {
    mocks.findRepo
      .mockResolvedValueOnce({ previewConfig })
      .mockResolvedValue({ installation: null, previewConfig });
    mocks.evidence.mockResolvedValue({ ok: false, reason: 'too_large' });
    mocks.startBrowser.mockResolvedValue(
      sessionWith((command) =>
        command.cmd === 'goto'
          ? { ok: true, status: 200, url: 'http://localhost:3000/' }
          : command.cmd === 'screenshot'
            ? { file: '/tmp/.asw/browser/x/out/smoke-0.png', ok: true }
            : { ok: true }
      )
    );

    const result = await runUiVerify({ request });

    expect(result.passed).toBe(true);
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('over the configured size limit')])
    );
  });

  it('keeps collecting e2e evidence after one artifact cannot be read', async () => {
    const e2eConfig = {
      e2e: { command: 'npm e2e' },
      readyUrl: 'http://localhost:3000/',
      start: 'npm start',
    };
    mocks.findRepo
      .mockResolvedValueOnce({ previewConfig: e2eConfig })
      .mockResolvedValue({ installation: null, previewConfig: e2eConfig });
    mocks.workspace.exec.mockImplementation(async (command: string) => {
      if (command === 'pwd') {
        return '/workspace/target-repo\n';
      }
      return command.includes("-iname '*.png'") ? 'test-results/a.png\ntest-results/b.png\n' : '';
    });
    mocks.workspace.execCapture.mockResolvedValue({ exitCode: 0, signal: null });
    mocks.workspace.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('a.png')) {
        throw new Error('file disappeared');
      }
      return Buffer.from('png');
    });

    const result = await runUiVerify({ mode: 'e2e', request });

    expect(mocks.evidence).toHaveBeenCalledTimes(2);
    expect(result.evidenceIds).toHaveLength(2);
    expect(result.summary).toContain('Could not save screenshot evidence from test-results/a.png');
  });
});
