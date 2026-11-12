import { beforeEach, describe, expect, it, vi } from 'vitest';

const startPreview = vi.hoisted(() =>
  vi.fn(async () => ({
    baseUrl: 'http://localhost:3000',
    logTail: async () => '',
    stop: async () => {},
  }))
);
vi.mock('../lib/appPreview.js', () => ({ startAppPreview: startPreview }));

const { auditLog, evidence, findRepo, screenMcpResult, startBrowser, resolveSetting } = vi.hoisted(
  () => ({
    auditLog: vi.fn(),
    evidence: vi.fn(),
    findRepo: vi.fn(),
    resolveSetting: vi.fn(),
    screenMcpResult: vi.fn(),
    startBrowser: vi.fn(),
  })
);

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: findRepo } },
}));
vi.mock('@auto-swe/shared/config/resolveSetting', () => ({ resolveSetting }));
vi.mock('../browser/session.js', () => ({ BrowserSession: { start: startBrowser } }));
vi.mock('../lib/runEvidence.js', () => ({ recordActivityEvidence: evidence }));
vi.mock('../lib/activityLog.js', () => ({ auditLog }));
vi.mock('./mcpScreen.js', () => ({ screenMcpResult }));

import type { AgentTracer } from '../lib/agentTracer.js';
import { BrowserToolset } from './browserTools.js';

describe('BrowserToolset', () => {
  const events: string[] = [];
  const tracer = { addActivityEvent: vi.fn(), addToolCall: vi.fn() } as unknown as AgentTracer;
  const session = {
    call: vi.fn(),
    close: vi.fn(),
    readOutFile: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    findRepo.mockResolvedValue({ previewConfig: null });
    resolveSetting.mockImplementation(async (key: string) =>
      key === 'uiValidation.maxScreenshotBytes' || key === 'uiValidation.maxVideoBytes'
        ? 5_000_000
        : false
    );
    screenMcpResult.mockImplementation(async (text: string) => ({
      blocked: false,
      result: `[screened] ${text}`,
    }));
    startBrowser.mockResolvedValue(session);
    session.call.mockImplementation(async (command: { cmd: string }) => {
      if (command.cmd === 'screenshot') {
        return {
          file: '/workspace/browser/screenshot-1.png',
          height: 2,
          modelFile: '/workspace/browser/screenshot-1.model.jpg',
          ok: true,
          url: 'http://localhost:3000/',
          width: 2,
        };
      }
      if (command.cmd === 'snapshot') {
        return { snapshot: 'page text' };
      }
      return { ok: true };
    });
    session.readOutFile.mockImplementation(async (filePath: string) =>
      Buffer.from(filePath.endsWith('.model.jpg') ? 'jpeg' : 'png')
    );
    session.close.mockResolvedValue({});
    evidence.mockImplementation(async (input: { kind: string }) => {
      events.push(`evidence:${input.kind}`);
      return { artifactId: 'artifact-1', evidenceId: 'evidence-1', ok: true };
    });
  });

  function createToolset(
    readBaseFile: (path: string) => Promise<string | null> = async () => null
  ) {
    return new BrowserToolset({
      containerId: 'workspace-123',
      repoId: 'repo-1',
      tracer,
      workspace: { readBaseFile } as never,
    });
  }

  it('starts a repository-file preview through the workspace trusted reader', async () => {
    const readBaseFile = vi.fn(
      async () => 'start: npm start\nreadyUrl: http://localhost:3000/\nallowedHosts: [localhost]'
    );
    const toolset = createToolset(readBaseFile);
    await toolset.startApp();
    expect(readBaseFile).toHaveBeenCalledWith('.auto-swe/preview.yml');
    expect(startPreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowedHosts: ['localhost'], start: 'npm start' }),
      expect.anything()
    );
    await toolset.close();
  });

  it('screens page text and records an audit log and trace for each call', async () => {
    const toolset = createToolset();
    const result = await toolset.call('browser_snapshot', {});

    expect(result.text).toContain('[screened]');
    expect(screenMcpResult).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.stringContaining('[browser:audit] container=workspace-123 tool=browser_snapshot')
    );
    expect(tracer.addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'browser:browser_snapshot' })
    );
    expect(startBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ readBaseFile: expect.any(Function) }),
      expect.objectContaining({ allowedHosts: [], recordVideo: false, trace: true })
    );
  });

  it('persists screenshots without returning pixels when model images are disabled', async () => {
    const toolset = createToolset();
    const result = await toolset.call('browser_screenshot', {
      caption: 'After login',
      fullPage: false,
    });
    events.push('returned');

    expect(events).toEqual(['evidence:screenshot', 'returned']);
    expect(result.image).toBeUndefined();
    expect(result.text).toContain('evidence-1');
    expect(session.call).toHaveBeenCalledWith({ cmd: 'screenshot', fullPage: false });
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: 'After login',
        contentType: 'image/png',
        kind: 'screenshot',
        pageUrl: 'http://localhost:3000/',
        source: 'agent',
      }),
      tracer
    );
  });

  it('returns the optional JPEG screenshot to the model', async () => {
    resolveSetting.mockImplementation(async (key: string) =>
      key === 'uiValidation.agentScreenshotImages'
        ? true
        : key === 'uiValidation.maxScreenshotBytes'
          ? 1000
          : key === 'uiValidation.maxVideoBytes'
            ? 5_000_000
            : false
    );
    screenMcpResult.mockImplementation(async (text: string) => ({ blocked: false, result: text }));
    const toolset = createToolset();

    const result = await toolset.call('browser_screenshot', { caption: 'After login' });

    expect(session.call).toHaveBeenCalledWith({
      cmd: 'screenshot',
      fullPage: false,
      modelImage: true,
    });
    expect(session.readOutFile).toHaveBeenCalledWith(
      '/workspace/browser/screenshot-1.model.jpg',
      1000
    );
    expect(result.image).toEqual({ data: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
    expect(tracer.addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ outputJson: result.text, toolName: 'browser:browser_screenshot' })
    );
    expect(JSON.stringify(vi.mocked(tracer.addToolCall).mock.calls)).not.toContain(
      Buffer.from('jpeg').toString('base64')
    );
    expect(
      resolveSetting.mock.calls.filter(([key]) => key === 'uiValidation.agentScreenshotImages')
    ).toHaveLength(1);
  });

  it('withholds the image when page-text screening blocks the result but saves evidence', async () => {
    resolveSetting.mockImplementation(async (key: string) =>
      key === 'uiValidation.agentScreenshotImages'
        ? true
        : key === 'uiValidation.maxScreenshotBytes'
          ? 1000
          : key === 'uiValidation.maxVideoBytes'
            ? 5_000_000
            : false
    );
    let screens = 0;
    screenMcpResult.mockImplementation(async (text: string) => {
      screens += 1;
      return screens === 2
        ? { blocked: true, message: 'page text blocked' }
        : { blocked: false, result: text };
    });
    const toolset = createToolset();

    const result = await toolset.call('browser_screenshot', { caption: 'After login' });

    expect(result).toEqual({ text: 'page text blocked' });
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png', kind: 'screenshot' }),
      tracer
    );
  });

  it('withholds the image when the accessibility snapshot is blocked', async () => {
    resolveSetting.mockImplementation(async (key: string) =>
      key === 'uiValidation.agentScreenshotImages'
        ? true
        : key === 'uiValidation.maxScreenshotBytes'
          ? 1000
          : key === 'uiValidation.maxVideoBytes'
            ? 5_000_000
            : false
    );
    screenMcpResult.mockImplementationOnce(async () => ({
      blocked: true,
      message: 'accessibility snapshot blocked',
    }));
    const toolset = createToolset();

    const result = await toolset.call('browser_screenshot', { caption: 'After login' });

    expect(result.image).toBeUndefined();
    expect(result.text).toContain('accessibility snapshot blocked');
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png', kind: 'screenshot' }),
      tracer
    );
  });

  it('omits an oversized model JPEG without failing the screenshot tool', async () => {
    resolveSetting.mockImplementation(async (key: string) =>
      key === 'uiValidation.agentScreenshotImages'
        ? true
        : key === 'uiValidation.maxScreenshotBytes'
          ? 100
          : key === 'uiValidation.maxVideoBytes'
            ? 5_000_000
            : false
    );
    session.readOutFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.model.jpg')) {
        throw new Error('file exceeds the 100 byte limit');
      }
      return Buffer.from('png');
    });
    screenMcpResult.mockImplementation(async (text: string) => ({ blocked: false, result: text }));
    const toolset = createToolset();

    const result = await toolset.call('browser_screenshot', { caption: 'After login' });

    expect(result.image).toBeUndefined();
    expect(result.text).toContain('"imageOmitted":"file exceeds the 100 byte limit"');
  });

  it('traces and rethrows browser allowlist errors', async () => {
    const toolset = createToolset();
    session.call.mockRejectedValueOnce(new Error('Navigation blocked by host allowlist'));

    await expect(
      toolset.call('browser_navigate', { url: 'https://not-allowed.example/' })
    ).rejects.toThrow('Navigation blocked by host allowlist');
    expect(tracer.addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Navigation blocked by host allowlist',
        toolName: 'browser:browser_navigate',
      })
    );
  });

  it('saves session video and trace evidence during close', async () => {
    const video = { cleanup: vi.fn(async () => {}), path: '/tmp/recording.webm', sizeBytes: 5 };
    const trace = { cleanup: vi.fn(async () => {}), path: '/tmp/trace.zip', sizeBytes: 5 };
    session.close.mockResolvedValue({
      errors: [],
      trace,
      video,
    });
    const toolset = createToolset();
    await toolset.call('browser_snapshot', {});

    await toolset.close();

    expect(session.close).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { filePath: video.path, sizeBytes: video.sizeBytes },
        kind: 'video',
        source: 'agent',
      }),
      tracer
    );
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { filePath: trace.path, sizeBytes: trace.sizeBytes },
        kind: 'trace',
        source: 'agent',
      }),
      tracer
    );
    expect(video.cleanup).toHaveBeenCalledOnce();
    expect(trace.cleanup).toHaveBeenCalledOnce();
  });

  it('cleans both evidence files when saving one fails', async () => {
    const video = { cleanup: vi.fn(async () => {}), path: '/tmp/recording.webm', sizeBytes: 5 };
    const trace = { cleanup: vi.fn(async () => {}), path: '/tmp/trace.zip', sizeBytes: 5 };
    session.close.mockResolvedValue({ errors: [], trace, video });
    evidence.mockRejectedValueOnce(new Error('artifact store unavailable'));
    const toolset = createToolset();
    await toolset.call('browser_snapshot', {});

    await expect(toolset.close()).rejects.toThrow('artifact store unavailable');

    expect(video.cleanup).toHaveBeenCalledOnce();
    expect(trace.cleanup).toHaveBeenCalledOnce();
  });

  it('starts one browser for concurrent first calls, so cleanup can reach it', async () => {
    const toolset = createToolset();
    await Promise.all([toolset.call('browser_snapshot', {}), toolset.call('browser_snapshot', {})]);

    expect(startBrowser).toHaveBeenCalledTimes(1);
    await toolset.close();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('traces an artifact the worker could not read back at close', async () => {
    session.close.mockResolvedValue({
      errors: ['recording: file exceeds the read limit'],
    });
    const toolset = createToolset();
    await toolset.call('browser_snapshot', {});

    await toolset.close();

    expect(tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'ui.evidence_unavailable',
      outputJson: { error: 'recording: file exceeds the read limit' },
    });
  });

  it('closes a session that started after cleanup began', async () => {
    let resolveStart: (value: typeof session) => void = () => undefined;
    startBrowser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      })
    );
    const toolset = createToolset();
    const pending = toolset.call('browser_snapshot', {});
    const closing = toolset.close();
    resolveStart(session);
    await pending;
    await closing;

    expect(session.close).toHaveBeenCalledOnce();
  });
});
