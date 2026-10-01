import { describe, expect, it, vi } from 'vitest';
import { execShellAsync, spawnCaptureAsync, spawnWithStdinAsync } from './execUtils.js';

describe('spawnCaptureAsync — onStdoutLine streaming', () => {
  it('emits one callback per newline-terminated line and flushes a trailing partial', async () => {
    const lines: string[] = [];
    // No trailing newline after "c" → exercises the partial-line flush on close.
    const res = await spawnCaptureAsync('sh', ['-c', 'printf "a\\nb\\nc"'], {
      onStdoutLine: (l) => lines.push(l),
    });
    expect(res.exitCode).toBe(0);
    expect(lines).toEqual(['a', 'b', 'c']);
    // stdout is still fully buffered regardless of streaming.
    expect(res.stdout).toBe('a\nb\nc');
  });

  it('does not let a throwing line handler reject the capture', async () => {
    const res = await spawnCaptureAsync('sh', ['-c', 'printf "x\\n"'], {
      onStdoutLine: () => {
        throw new Error('consumer blew up');
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('x\n');
  });
});

describe('spawnWithStdinAsync', () => {
  it('streams content far past the argv limit to the child', async () => {
    // 300 KiB in one shot — well over the ~128 KiB single-argument cap that
    // broke the old `echo <base64> | base64 -d` write path.
    const content = 'x'.repeat(300 * 1024);
    const res = await spawnWithStdinAsync('sh', ['-c', 'wc -c'], content);
    expect(res.exitCode).toBe(0);
    expect(Number.parseInt(res.stdout.trim(), 10)).toBe(content.length);
  });

  it('delivers the bytes verbatim', async () => {
    const content = "line1\n'quoted' $HOME `tick` \u00e9\n";
    const res = await spawnWithStdinAsync('sh', ['-c', 'cat'], content);
    expect(res.stdout).toBe(content);
  });

  it('reports a non-zero exit with stderr and survives an early-exiting child', async () => {
    const res = await spawnWithStdinAsync(
      'sh',
      ['-c', 'echo nope >&2; exit 3'],
      'y'.repeat(1 << 20)
    );
    expect(res.exitCode).toBe(3);
    expect(res.stderr.trim()).toBe('nope');
  });

  it('reports a spawn failure as exit 127', async () => {
    const res = await spawnWithStdinAsync('/definitely/not/a/binary', [], 'x');
    expect(res.exitCode).toBe(127);
    expect(res.signal).toBe('SPAWN_ERROR');
  });
});

describe('onTimeout', () => {
  it('runs after execShellAsync kills a command for overrunning, then rethrows', async () => {
    const onTimeout = vi.fn(async () => {});
    await expect(execShellAsync('sleep 5', { onTimeout, timeoutMs: 100 })).rejects.toMatchObject({
      killed: true,
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not run for an ordinary non-zero exit', async () => {
    const onTimeout = vi.fn(async () => {});
    await expect(execShellAsync('exit 3', { onTimeout })).rejects.toBeDefined();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('runs before spawnCaptureAsync resolves a timed-out result', async () => {
    const order: string[] = [];
    const result = await spawnCaptureAsync('sleep', ['5'], {
      onTimeout: async () => {
        order.push('onTimeout');
      },
      timeoutMs: 100,
    });
    order.push('resolved');
    expect(result.exitCode).toBe(124);
    expect(order).toEqual(['onTimeout', 'resolved']);
  });

  it('does not run when the command exits 124 on its own', async () => {
    const onTimeout = vi.fn();
    const result = await spawnCaptureAsync('sh', ['-c', 'exit 124'], { onTimeout });
    expect(result.exitCode).toBe(124);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('a throwing onTimeout does not replace the timeout result', async () => {
    const result = await spawnWithStdinAsync('sleep', ['5'], '', {
      onTimeout: () => {
        throw new Error('kill failed');
      },
      timeoutMs: 100,
    });
    expect(result.exitCode).toBe(124);
  });
});
