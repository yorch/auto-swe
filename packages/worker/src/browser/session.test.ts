import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { BrowserSession } from './session.js';

function makeWorkspace(callResult?: (outputDir: string) => string) {
  let outputDir = '';
  const exec = vi.fn(async (command: string) => {
    if (command.includes('nohup node')) {
      outputDir = command.match(/--out '([^']+)'/)?.[1] ?? '';
    }
    if (command.includes(' call --socket ')) {
      return callResult?.(outputDir) ?? '{"ok":true}\n';
    }
    return '';
  });
  const readFile = vi.fn(async (filePath: string) => Buffer.from(filePath));
  const workspace = {
    exec,
    execStdin: vi.fn(async () => ''),
    readFile,
  } as unknown as Workspace;
  return { exec, readFile, workspace };
}

describe('BrowserSession', () => {
  it('ships the embedded driver and starts it with the requested options', async () => {
    const { exec, workspace } = makeWorkspace();
    const session = await BrowserSession.start(workspace, {
      allowedHosts: ['example.test', '*.assets.test'],
      recordVideo: true,
      trace: true,
      viewport: { height: 700, width: 1100 },
    });

    expect(session).toBeInstanceOf(BrowserSession);
    expect(workspace.execStdin).toHaveBeenCalledWith(
      expect.stringContaining('cat >'),
      expect.stringContaining('context.tracing.start')
    );
    const launch = exec.mock.calls.find(([command]) => command.includes('nohup node'))?.[0] ?? '';
    expect(launch).toContain('"allowedHosts":["example.test","*.assets.test"]');
    expect(launch).toContain('"recordVideo":true');
    expect(launch).toContain('"trace":true');
    expect(launch).toContain('"viewport":{"height":700,"width":1100}');
    expect(launch).toContain('--socket');
  });

  it('returns driver command errors as results and quotes command JSON', async () => {
    const { exec, workspace } = makeWorkspace(() => '{"error":"selector timed out","ok":false}\n');
    const session = await BrowserSession.start(workspace, {
      allowedHosts: [],
      recordVideo: false,
      trace: false,
    });

    await expect(
      session.call({ cmd: 'click', selector: "button'; touch /tmp/pwned; '" })
    ).resolves.toEqual({
      error: 'selector timed out',
      ok: false,
    });
    const callCommand =
      exec.mock.calls.find(([command]) => command.includes(' call --socket '))?.[0] ?? '';
    expect(callCommand).toContain("button'\\''; touch /tmp/pwned; '\\''");
    expect(workspace.exec).toHaveBeenCalledWith(expect.stringContaining(' call --socket '), {
      timeoutMs: 35_000,
    });
  });

  it('reads only paths inside the session output directory', async () => {
    const { exec, readFile, workspace } = makeWorkspace();
    const session = await BrowserSession.start(workspace, {
      allowedHosts: [],
      recordVideo: false,
      trace: false,
    });
    const launch = exec.mock.calls.find(([command]) => command.includes('nohup node'))?.[0] ?? '';
    const outputDir = launch.match(/--out '([^']+)'/)?.[1] ?? '';

    await expect(session.readOutFile(`${outputDir}/shot.png`, 100)).resolves.toEqual(
      Buffer.from(`${outputDir}/shot.png`)
    );
    expect(readFile).toHaveBeenCalledWith(`${outputDir}/shot.png`, 100);
    await expect(session.readOutFile('/tmp/.asw/browser/outside', 100)).rejects.toThrow(
      'must be inside the session output directory'
    );
  });

  it('returns recorded video and trace buffers on close', async () => {
    const { workspace } = makeWorkspace((outputDir) =>
      JSON.stringify({
        ok: true,
        trace: `${outputDir}/trace.zip`,
        video: `${outputDir}/recording.webm`,
      })
    );
    const session = await BrowserSession.start(workspace, {
      allowedHosts: [],
      recordVideo: true,
      trace: true,
    });
    const files = await session.close();

    expect(files.video?.toString()).toMatch(/recording\.webm$/);
    expect(files.trace?.toString()).toMatch(/trace\.zip$/);
  });

  it('reports a clear error when the workspace has no browser', async () => {
    const { exec, workspace } = makeWorkspace();
    exec.mockRejectedValueOnce(new Error('node: not found'));

    await expect(
      BrowserSession.start(workspace, { allowedHosts: [], recordVideo: false, trace: false })
    ).rejects.toThrow(
      'this workspace image has no browser; use defaults/Dockerfile.node-browser for UI validation'
    );
    expect(workspace.execStdin).not.toHaveBeenCalled();
  });
});
