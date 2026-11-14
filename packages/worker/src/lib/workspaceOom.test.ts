import { describe, expect, it } from 'vitest';
import { describeWorkspaceOom } from './workspaceOom.js';

describe('describeWorkspaceOom', () => {
  it('names the limit and both knobs for exit 137', () => {
    const note = describeWorkspaceOom({ exitCode: 137 }, '4g');
    expect(note).toContain('exit 137');
    expect(note).toContain('most likely');
    expect(note).toContain('limit 4g');
    expect(note).toContain('workspace.memory');
    expect(note).toContain('WORKSPACE_MEMORY');
  });

  it('omits the limit when it is unknown instead of guessing one', () => {
    const note = describeWorkspaceOom({ exitCode: 137 });
    expect(note).not.toBeNull();
    expect(note).not.toContain('(limit');
  });

  it.each([0, 1, 2, 124, 127, 130, 139, 143, 255])('is silent for exit %i', (exitCode) => {
    expect(describeWorkspaceOom({ exitCode }, '4g')).toBeNull();
  });

  it('is silent when the local client reported a signal (timeout, spawn failure)', () => {
    expect(describeWorkspaceOom({ exitCode: 137, signal: 'SIGKILL' }, '4g')).toBeNull();
  });
});
