import { describe, expect, it } from 'vitest';
import { spawnCaptureAsync } from './execUtils.js';

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
