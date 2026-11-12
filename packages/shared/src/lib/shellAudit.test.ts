import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ resolveSetting: vi.fn(async () => ['registry.npmjs.org']) }));
vi.mock('../config/index.js', () => h);

import type { PrismaClient } from '../generated/prisma/client.js';
import type { ShellNodeWithId } from '../workflow/containerCode.js';
import { recordShellAudit } from './shellAudit.js';

const nodes = [
  { id: 'node', node: { command: 'echo ok', image: 'alpine', network: 'egress' } },
] as ShellNodeWithId[];
beforeEach(() => vi.clearAllMocks());
function client() {
  return {
    team: { findUnique: vi.fn(async () => ({ orgId: 'org' })) },
    workflowShellAudit: { createMany: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
  } as unknown as Pick<PrismaClient, 'team' | 'workflowShellAudit'>;
}
it('captures current organization baseline union team in the existing template audit', async () => {
  const tx = client();
  await recordShellAudit(tx, 'version', 'team', 'author', nodes, [
    'registry.npmjs.org',
    'team.test',
  ]);
  expect(h.resolveSetting).toHaveBeenCalledWith('workspace.egressBaselineAllowlist', {
    orgId: 'org',
  });
  expect(tx.workflowShellAudit.createMany).toHaveBeenCalledWith({
    data: [
      expect.objectContaining({ egressAllowlistSnapshot: ['registry.npmjs.org', 'team.test'] }),
    ],
  });
});
it('skips empty node sets and resolves GLOBAL baseline for global templates', async () => {
  const tx = client();
  await recordShellAudit(tx, 'version', null, null, [], []);
  expect(h.resolveSetting).not.toHaveBeenCalled();
  await recordShellAudit(tx, 'version', null, null, nodes, []);
  expect(tx.team.findUnique).not.toHaveBeenCalled();
  expect(h.resolveSetting).toHaveBeenCalledWith('workspace.egressBaselineAllowlist', {
    orgId: undefined,
  });
});
it('does not write an incomplete snapshot when baseline resolution fails', async () => {
  const tx = client();
  h.resolveSetting.mockRejectedValueOnce(new Error('config unavailable'));
  await expect(recordShellAudit(tx, 'version', null, null, nodes, [])).rejects.toThrow(
    'config unavailable'
  );
  expect(tx.workflowShellAudit.createMany).not.toHaveBeenCalled();
});
