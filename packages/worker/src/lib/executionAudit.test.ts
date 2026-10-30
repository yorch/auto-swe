import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTracer } from './agentTracer.js';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { agentTrace: { createMany: vi.fn().mockResolvedValue({ count: 1 }) } },
}));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  putArtifact: vi.fn().mockResolvedValue({ id: 'artifact' }),
}));
vi.mock('./activityContext.js', () => ({
  currentWorkflowRunId: async () => 'run',
  persistActivityTrace: async (tracer: AgentTracer) =>
    tracer.persist({ runId: 'run', workflowId: 'workflow' }, 'node', 'execution'),
}));

import { prisma } from '@auto-swe/shared/db';
import { putArtifact } from '@auto-swe/shared/lib/artifactStore';
import { executionAudit } from './executionAudit.js';

const base = {
  command: 'echo --password secret',
  durationMs: 24,
  egressAllowlist: ['example.com'],
  exitCode: 0,
  image: 'alpine',
  name: 'container' as const,
  network: 'egress',
  stderr: '',
  stdout: '',
};
beforeEach(() => vi.clearAllMocks());

describe('executionAudit', () => {
  it('stores full redacted output and an attributed activity event', async () => {
    const stdout = `${JSON.stringify({ ok: 'x'.repeat(12000), password: 'hidden' })}\nNPM_TOKEN=secret`;
    await executionAudit({
      ...base,
      stderr: JSON.stringify(
        { note: 'Bearer abcdefghijkl', password: 'multiline-secret' },
        null,
        2
      ),
      stdout,
    });
    const artifact = vi.mocked(putArtifact).mock.calls[0]?.[0];
    expect(artifact).toMatchObject({ kind: 'container.step', runId: 'run' });
    expect(artifact?.body).toContain('x'.repeat(12000));
    expect(artifact?.body).not.toMatch(/hidden|secret|abcdefghijkl/);
    expect(prisma.agentTrace.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            durationMs: 24,
            inputJson: {
              command: 'echo --password ***',
              egressAllowlist: ['example.com'],
              image: 'alpine',
              network: 'egress',
            },
            outputJson: { artifactId: 'artifact', exitCode: 0 },
            toolName: 'container.exec',
            type: 'activity_event',
          }),
        ],
      })
    );
  });

  it('captures empty output', async () => {
    await executionAudit(base);
    expect(JSON.parse(String(vi.mocked(putArtifact).mock.calls[0]?.[0].body))).toEqual({
      stderr: '',
      stdout: '',
    });
  });

  it('reuses the shell artifact without writing another', async () => {
    await executionAudit({ ...base, artifactId: 'shell-artifact', name: 'shell' });
    expect(putArtifact).not.toHaveBeenCalled();
    expect(prisma.agentTrace.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            outputJson: { artifactId: 'shell-artifact', exitCode: 0 },
            toolName: 'shell.exec',
          }),
        ],
      })
    );
  });

  it('still records failures when artifact storage fails and never throws on DB failure', async () => {
    vi.mocked(putArtifact).mockRejectedValueOnce(new Error('storage offline'));
    await executionAudit({ ...base, error: 'failed --password secret', exitCode: 1 });
    expect(prisma.agentTrace.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ error: 'failed --password ***', outputJson: { exitCode: 1 } }),
        ],
      })
    );
    vi.mocked(prisma.agentTrace.createMany).mockRejectedValueOnce(new Error('database offline'));
    await expect(executionAudit(base)).resolves.toBeUndefined();
  });
});
