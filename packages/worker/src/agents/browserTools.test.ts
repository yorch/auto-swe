import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    resolveSetting.mockResolvedValue(false);
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
    session.readOutFile.mockResolvedValue(Buffer.from('png'));
    session.close.mockResolvedValue({});
    evidence.mockImplementation(async (input: { kind: string }) => {
      events.push(`evidence:${input.kind}`);
      return { artifactId: 'artifact-1', evidenceId: 'evidence-1', ok: true };
    });
  });

  function createToolset() {
    return new BrowserToolset({
      containerId: 'workspace-123',
      repoId: 'repo-1',
      tracer,
      workspace: {} as never,
    });
  }

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
      {},
      expect.objectContaining({ allowedHosts: [], recordVideo: false, trace: true })
    );
  });

  it('persists screenshots before returning them to the caller', async () => {
    const toolset = createToolset();
    const result = await toolset.call('browser_screenshot', {
      caption: 'After login',
      fullPage: false,
    });
    events.push('returned');

    expect(events).toEqual(['evidence:screenshot', 'returned']);
    expect(result.image).toEqual(Buffer.from('png'));
    expect(result.text).toContain('evidence-1');
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
    session.close.mockResolvedValue({
      trace: Buffer.from('trace'),
      video: Buffer.from('video'),
    });
    const toolset = createToolset();
    await toolset.call('browser_snapshot', {});

    await toolset.close();

    expect(session.close).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({ body: Buffer.from('video'), kind: 'video', source: 'agent' }),
      tracer
    );
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({ body: Buffer.from('trace'), kind: 'trace', source: 'agent' }),
      tracer
    );
  });
});
