import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { captureWorkspaceCommand, workspaceLogTail } from './workspaceCommand.js';

describe('workspace command capture', () => {
  it('runs the command exactly, with the supplied timeout and bounded, redacted diagnostics', async () => {
    const execCapture = vi.fn().mockResolvedValue({
      exitCode: 1,
      signal: 'SIGTERM',
      stderr: 'known-value NPM_TOKEN=unknown-value',
      stdout: 'x'.repeat(10000),
    });
    const workspace = {
      execCapture,
      redact: (text: string) => text.replaceAll('known-value', '***'),
    } as unknown as Workspace;
    const result = await captureWorkspaceCommand(workspace, '  npm test  ', 1234);
    expect(execCapture).toHaveBeenCalledWith('  npm test  ', { timeoutMs: 1234 });
    expect(result.logTail.length).toBeLessThanOrEqual(4000);
    expect(result.logTail).not.toMatch(/known-value|unknown-value/);
    expect(result).toMatchObject({ exitCode: 1, signal: 'SIGTERM' });
    expect(result.logTail).toContain('Stopped by SIGTERM');
  });

  it('accepts empty logs and masks credentials without a workspace', () => {
    expect(workspaceLogTail(undefined, '')).toBe('');
    expect(workspaceLogTail(undefined, 'https://user:password@example.com')).toBe(
      'https://***@example.com'
    );
  });

  it('propagates execution errors', async () => {
    const error = new Error('unavailable');
    const workspace = { execCapture: vi.fn().mockRejectedValue(error) } as unknown as Workspace;
    await expect(captureWorkspaceCommand(workspace, 'npm test', 10)).rejects.toBe(error);
  });
});
