import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceBackend } from './index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('workspaceBackend', () => {
  it('is Docker unless the environment says kubernetes', () => {
    expect(workspaceBackend().kind).toBe('docker');
    vi.stubEnv('WORKSPACE_BACKEND', 'docker');
    expect(workspaceBackend().kind).toBe('docker');
    vi.stubEnv('WORKSPACE_BACKEND', 'k8s');
    expect(workspaceBackend().kind).toBe('docker');
  });

  it('is the Kubernetes driver for WORKSPACE_BACKEND=kubernetes', () => {
    vi.stubEnv('WORKSPACE_BACKEND', 'kubernetes');
    expect(workspaceBackend().kind).toBe('kubernetes');
  });
});
