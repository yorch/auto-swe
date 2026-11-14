import type { WorkspaceInfraConfig } from '@auto-swe/shared/lib/systemConfig';
import { describe, expect, it } from 'vitest';
import { agentWorkspaceSpec } from './spec.js';

const infra = {
  cpus: 2,
  dns: ['1.1.1.1'],
  harnessModelProxy: null,
  memory: '4g',
  pidsLimit: 512,
  registryProxy: null,
} as unknown as WorkspaceInfraConfig;

describe('agentWorkspaceSpec size', () => {
  it('takes the deployment caps when no size is given', () => {
    const spec = agentWorkspaceSpec('w', 'img', infra);
    expect(spec).toMatchObject({ cpus: 2, memory: '4g', pidsLimit: 512 });
  });

  it('applies a size over memory and cpus only', () => {
    const spec = agentWorkspaceSpec('w', 'img', infra, undefined, { cpus: 4, memory: '8g' });
    expect(spec).toMatchObject({ cpus: 4, memory: '8g', pidsLimit: 512 });
  });

  it('keeps the deployment value for a field the size leaves out', () => {
    const spec = agentWorkspaceSpec('w', 'img', infra, undefined, { memory: '8g' });
    expect(spec).toMatchObject({ cpus: 2, memory: '8g' });
  });
});
