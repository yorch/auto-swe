import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn(), spawnCaptureAsync: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('../../lib/execUtils.js', () => ({ spawnCaptureAsync: h.spawnCaptureAsync }));

import { execInContainer } from './containerExec.js';

/** A stand-in for the `docker exec` client: output is written by the test, `close` ends it. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  child.kill.mockImplementation(() => {
    setImmediate(() => child.emit('close', null, 'SIGKILL'));
  });
  h.spawn.mockReturnValue(child);
  return child;
}

const base = {
  abort: new AbortController().signal,
  containerId: 'workspace-xyz',
  heartbeat: () => undefined,
  tag: '00ff00000001',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.spawnCaptureAsync.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
});

describe('execInContainer', () => {
  it('runs the script under sh in the checkout, tagged, with its arguments unquoted', async () => {
    const child = fakeChild();
    const done = execInContainer({
      ...base,
      exec: { args: ["it's; rm -rf /"], script: 'cat -- "$1"', timeoutMs: 1000 },
    });
    child.stdout.write('hello');
    setImmediate(() => child.emit('close', 0, null));
    const result = await done;

    expect(h.spawn.mock.calls[0]?.[1]).toEqual([
      'exec',
      '-w',
      '/workspace/target-repo',
      '-e',
      'AUTO_SWE_EXEC_ID=00ff00000001',
      'workspace-xyz',
      'sh',
      '-c',
      'cat -- "$1"',
      'sh',
      "it's; rm -rf /",
    ]);
    expect(result).toMatchObject({ droppedBytes: 0, exitCode: 0, timedOut: false });
    expect(result.stdout.toString()).toBe('hello');
  });

  it('streams stdin when it is given one', async () => {
    const child = fakeChild();
    let written = '';
    child.stdin.on('data', (d: Buffer) => {
      written += d.toString();
    });
    const done = execInContainer({
      ...base,
      exec: { args: ['/x'], script: 'cat > "$1"', stdin: 'content', timeoutMs: 1000 },
    });
    setImmediate(() => child.emit('close', 0, null));
    await done;
    expect(h.spawn.mock.calls[0]?.[1]?.[1]).toBe('-i');
    expect(written).toBe('content');
  });

  it('keeps output up to the cap and counts the rest', async () => {
    const child = fakeChild();
    const done = execInContainer({
      ...base,
      exec: { script: 'yes', timeoutMs: 1000 },
      maxOutputBytes: 4,
    });
    child.stdout.write('abcdef');
    child.stderr.write('gh');
    setImmediate(() => child.emit('close', 0, null));
    const result = await done;
    expect(result.stdout.toString()).toBe('abcd');
    expect(result.droppedBytes).toBe(4);
  });

  it('kills the client and the tagged process tree on a timeout', async () => {
    fakeChild();
    const result = await execInContainer({ ...base, exec: { script: 'sleep 99', timeoutMs: 5 } });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    const [, args] = h.spawnCaptureAsync.mock.calls[0] as [string, string[]];
    expect(args.slice(0, 4)).toEqual(['exec', 'workspace-xyz', 'sh', '-c']);
    expect(args[4]).toContain('AUTO_SWE_EXEC_ID=00ff00000001');
  });

  it('kills it when the turn is aborted, already or later', async () => {
    for (const early of [true, false]) {
      h.spawnCaptureAsync.mockClear();
      const child = fakeChild();
      const abort = new AbortController();
      if (early) {
        abort.abort();
      }
      const done = execInContainer({
        ...base,
        abort: abort.signal,
        exec: { script: 'sleep 99', timeoutMs: 60_000 },
      });
      if (!early) {
        abort.abort();
      }
      const result = await done;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(result.exitCode).toBeNull();
      expect(h.spawnCaptureAsync).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects when docker cannot be started', async () => {
    const child = fakeChild();
    const done = execInContainer({ ...base, exec: { script: 'true', timeoutMs: 1000 } });
    child.emit('error', new Error('spawn docker ENOENT'));
    await expect(done).rejects.toThrow('ENOENT');
  });
});
