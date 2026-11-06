import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_PREVIEW_LAUNCHER, previewStopScript } from './appPreview.js';

const enabled = process.env.APP_PREVIEW_DOCKER_TEST === '1';
const image = process.env.ASW_BROWSER_IMAGE ?? 'auto-swe/node-browser:phase-a';
let container: string | undefined;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function containerExec(args: string[]): string {
  return docker(['exec', container ?? '', ...args]);
}

function containerExecDetached(args: string[]): string {
  return docker(['exec', '-d', container ?? '', ...args]);
}

function alive(pid: string): boolean {
  try {
    containerExec(['sh', '-c', 'kill -0 "$1"', 'sh', pid]);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!enabled)('app preview Docker cleanup', () => {
  afterEach(() => {
    if (container) {
      try {
        docker(['rm', '-f', container]);
      } catch {
        // The container may already have exited.
      }
      container = undefined;
    }
  });

  it('stops scrubbed orphan daemons but preserves live exec processes, old daemons and init', async () => {
    container = `asw-preview-stop-${process.pid}`;
    docker([
      'run',
      '-d',
      '--rm',
      '--init',
      '--name',
      container,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      image,
      'sh',
      '-c',
      'echo $$ >/tmp/keeper.pid; exec sleep infinity',
    ]);

    containerExec(['sh', '-c', 'setsid sh -c "sleep 300" >/dev/null 2>&1 & echo $! >/tmp/old.pid']);
    containerExec([
      'node',
      '-e',
      APP_PREVIEW_LAUNCHER,
      '--',
      `env -i PATH="$PATH" setsid sh -c 'echo $$ >/tmp/preview.pid; exec sleep 300' >/dev/null 2>&1 & sleep 300`,
      '/tmp/preview.pgid',
      '/tmp/preview.log',
      '/tmp/preview.pgid.mark',
      '/tmp/preview.pgid.since',
    ]);
    containerExecDetached(['sh', '-c', 'sleep 300 & echo $! >/tmp/live.pid; wait']);
    const pid = (file: string) => containerExec(['cat', file]).trim();
    const previewPid = pid('/tmp/preview.pid');
    const livePid = pid('/tmp/live.pid');
    const keeperPid = pid('/tmp/keeper.pid');
    const oldPid = pid('/tmp/old.pid');

    containerExec([
      'node',
      '-e',
      previewStopScript('/tmp/preview.pgid', '/tmp/preview.pgid.mark', '/tmp/preview.pgid.since'),
    ]);
    const deadline = Date.now() + 5000;
    while (alive(previewPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(alive(previewPid)).toBe(false);
    expect(alive(livePid)).toBe(true);
    expect(alive(keeperPid)).toBe(true);
    expect(alive(oldPid)).toBe(true);
  }, 30_000);
});
