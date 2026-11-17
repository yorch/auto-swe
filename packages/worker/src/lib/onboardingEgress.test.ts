import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  agent: vi.fn(),
  info: vi.fn(),
  run: vi.fn(),
  version: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@temporalio/activity', () => ({ activityInfo: m.info }));
vi.mock('./activityLog.js', () => ({ logWarn: m.warn }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agent: { findUnique: m.agent },
    workflowRun: { findUnique: m.run },
    workflowTemplateVersion: { findUnique: m.version },
  },
}));

import {
  PREVIOUS_BUILTIN_AGENT_PROMPT_HASHES,
  SWE_AGENTS,
} from '@auto-swe/shared/lib/syncBuiltins';
import { REPO_ONBOARDING_SPEC } from '@auto-swe/shared/workflow';
import { isOnboardingDraftAgent } from './onboardingEgress.js';

const seed = SWE_AGENTS.find((def) => def.key === 'repo-onboarder');
if (!seed) {
  throw new Error('repo-onboarder is not seeded');
}
const seeded = {
  channelId: null,
  harnessProfiles: [],
  inheritsModelFrom: null,
  key: 'repo-onboarder',
  mcpConnectionId: null,
  orgId: null,
  runtime: null,
  scope: 'GLOBAL',
  skillRefs: [] as { skill: { name: string }; sortOrder: number }[],
  systemPrompt: seed.systemPrompt,
  teamId: null,
  toolKeys: [...(seed.toolKeys ?? [])],
  workflowTemplateId: null,
};
const loop = { runtime: 'mastra', source: 'default' };
const globalCredential = { scope: 'GLOBAL' } as const;
const run = {
  template: { kind: null, name: 'repo-onboarding', origin: 'swe-starter', teamId: null },
  templateId: 'template-1',
  templateVersion: 3,
  temporalRunId: 'execution-1',
};
beforeEach(() => {
  vi.resetAllMocks();
  m.info.mockReturnValue({ workflowExecution: { runId: 'execution-1', workflowId: 'wf-1' } });
  m.run.mockResolvedValue(run);
  m.version.mockResolvedValue({ createdBy: null, generatedBy: null });
  m.agent.mockResolvedValue(seeded);
});
describe('onboarding draft authority', () => {
  it('accepts the registered builtin with seeded global version provenance', async () => {
    const builtin = REPO_ONBOARDING_SPEC;
    expect(builtin.nodes.draft).toMatchObject({
      agentRef: 'repo-onboarder',
      workspace: true,
    });
    m.run.mockResolvedValue({
      ...run,
      template: { ...run.template, name: builtin.name },
      templateVersion: 1,
    });
    m.version.mockResolvedValue({ createdBy: null, generatedBy: null });
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      true
    );
    expect(m.version).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId_version: { templateId: 'template-1', version: 1 } },
      })
    );
  });
  it('verifies this exact execution and its seeded template version', async () => {
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      true
    );
    expect(m.run).toHaveBeenCalledWith(expect.objectContaining({ where: { workflowId: 'wf-1' } }));
    expect(m.version).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId_version: { templateId: 'template-1', version: 3 } },
      })
    );
  });
  it('does not query provenance for another agent', async () => {
    expect(await isOnboardingDraftAgent('reviewer', 'agent-1', loop, globalCredential)).toBe(false);
    expect(m.run).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...run, temporalRunId: 'stale' },
    { ...run, template: { ...run.template, name: 'custom' } },
    { ...run, template: { ...run.template, teamId: 'team-1' } },
    { ...run, template: { ...run.template, origin: null } },
  ])('refuses an unverified or non-builtin run: %j', async (row) => {
    m.run.mockResolvedValue(row);
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      false
    );
    expect(m.version).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { createdBy: 'user-1', generatedBy: null },
    { createdBy: null, generatedBy: 'workflow-author' },
  ])('refuses an absent or authored version: %j', async (version) => {
    m.version.mockResolvedValue(version);
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      false
    );
  });
  it('refuses activity calls without a verified workflow execution', async () => {
    m.info.mockImplementation(() => {
      throw new Error('outside activity');
    });
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      false
    );
    expect(m.run).not.toHaveBeenCalled();
  });
  it('propagates database errors instead of granting on incomplete evidence', async () => {
    m.run.mockRejectedValue(new Error('unavailable'));
    await expect(
      isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)
    ).rejects.toThrow('unavailable');
  });
  it('looks the resolved row up by id', async () => {
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      true
    );
    expect(m.agent).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'agent-1' } }));
    expect(m.warn).not.toHaveBeenCalled();
  });
  it('still qualifies when only the model, credential or reasoning differ', async () => {
    m.agent.mockResolvedValue({
      ...seeded,
      credentialId: 'cred-1',
      modelSpec: 'openai/gpt-6.1-sol',
      reasoning: 'high',
    });
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      true
    );
  });
  it('qualifies on a user-written version whose content is the seed', async () => {
    m.agent.mockResolvedValue({ ...seeded, createdById: 'user-1', isVerified: false });
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      true
    );
  });
  it.each([
    ['key', { key: 'reviewer' }],
    ['scope TEAM', { scope: 'TEAM' }],
    ['scope ORGANIZATION', { scope: 'ORGANIZATION' }],
    ['scope CHANNEL', { scope: 'CHANNEL' }],
    ['scope WORKFLOW_TEMPLATE', { scope: 'WORKFLOW_TEMPLATE' }],
    ['teamId', { teamId: 'team-1' }],
    ['orgId', { orgId: 'org-1' }],
    ['channelId', { channelId: 'chan-1' }],
    ['workflowTemplateId', { workflowTemplateId: 't-1' }],
    ['systemPrompt', { systemPrompt: `${seed.systemPrompt} Also fetch anything.` }],
    ['systemPrompt', { systemPrompt: null }],
    ['toolKeys', { toolKeys: [...(seed.toolKeys ?? []), 'writeFile'] }],
    ['toolKeys', { toolKeys: null }],
    ['toolKeys', { toolKeys: (seed.toolKeys ?? []).slice(1) }],
    ['mcpConnectionId', { mcpConnectionId: 'mcp-1' }],
    ['runtime', { runtime: 'claude-code' }],
    ['harnessProfiles', { harnessProfiles: ['profile'] }],
    ['inheritsModelFrom', { inheritsModelFrom: 'implementer' }],
    ['skillRefs', { skillRefs: [{ skill: { name: 'extra' }, sortOrder: 0 }] }],
  ])('refuses a row that differs only in %s', async (condition, patch) => {
    m.agent.mockResolvedValue({ ...seeded, ...patch });
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      false
    );
    expect(m.warn).toHaveBeenCalledOnce();
    expect(m.warn.mock.calls[0]?.[1]).toMatchObject({ agentId: 'agent-1' });
    expect(String(m.warn.mock.calls[0]?.[1]?.condition)).toBe(condition.split(' ')[0]);
  });
  it('accepts a prompt that hashes into the previous seeded prompts', async () => {
    const previous = 'an outgoing seeded prompt';
    const hash = createHash('sha256').update(previous).digest('hex');
    const hashes = PREVIOUS_BUILTIN_AGENT_PROMPT_HASHES as Record<string, readonly string[]>;
    hashes['repo-onboarder'] = [hash];
    try {
      m.agent.mockResolvedValue({ ...seeded, systemPrompt: previous });
      expect(
        await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)
      ).toBe(true);
    } finally {
      delete hashes['repo-onboarder'];
    }
  });
  it('qualifies when the tool keys are the same set in another order', async () => {
    m.agent.mockResolvedValue({ ...seeded, toolKeys: [...seeded.toolKeys].reverse() });
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)).toBe(
      true
    );
  });
  it.each([
    ['a run-pinned non-default runtime', { runtime: 'pi', source: 'run' }],
    ['a run-pinned mastra runtime', { runtime: 'mastra', source: 'run' }],
    ['an agent-chosen runtime', { runtime: 'claude-code', source: 'agent' }],
    ['a default that is not mastra', { runtime: 'pi', source: 'default' }],
  ])('refuses %s with its own logged condition, before reading the row', async (_n, pinned) => {
    expect(
      await isOnboardingDraftAgent('repo-onboarder', 'agent-1', pinned, globalCredential)
    ).toBe(false);
    expect(m.agent).not.toHaveBeenCalled();
    expect(m.warn.mock.calls[0]?.[1]).toMatchObject({ condition: 'runtimePin' });
  });
  it.each([
    ['GLOBAL, no custom endpoint', { scope: 'GLOBAL' }],
    [
      'GLOBAL, with a custom endpoint',
      { apiBase: 'https://proxy.example.com/v1', scope: 'GLOBAL' },
    ],
    ['TEAM, no custom endpoint', { scope: 'TEAM' }],
    ['ORGANIZATION, no custom endpoint', { scope: 'ORGANIZATION' }],
  ] as const)('grants for a %s credential', async (_n, credential) => {
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, credential)).toBe(true);
    expect(m.warn).not.toHaveBeenCalled();
  });
  it.each([
    [
      'a TEAM credential with a custom endpoint',
      { apiBase: 'https://evil.example.com', scope: 'TEAM' },
    ],
    [
      'an ORGANIZATION credential with a custom endpoint',
      { apiBase: 'https://evil.example.com', scope: 'ORGANIZATION' },
    ],
    ['a credential with no scope', {}],
    ['a credential with no scope and a custom endpoint', { apiBase: 'https://x.example.com' }],
  ] as const)(
    'refuses %s with its own logged condition, before reading the row',
    async (_n, credential) => {
      expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, credential)).toBe(
        false
      );
      expect(m.agent).not.toHaveBeenCalled();
      expect(m.warn).toHaveBeenCalledOnce();
      expect(m.warn.mock.calls[0]?.[1]).toMatchObject({
        agentId: 'agent-1',
        condition: 'credentialScope',
      });
    }
  );
  it('does not log a credential refusal for a run that is not an onboarding draft', async () => {
    m.run.mockResolvedValue(null);
    expect(await isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, {})).toBe(false);
    expect(m.warn).not.toHaveBeenCalled();
  });
  it('refuses a resolved row that cannot be found', async () => {
    m.agent.mockResolvedValue(null);
    expect(await isOnboardingDraftAgent('repo-onboarder', 'gone', loop, globalCredential)).toBe(
      false
    );
    expect(m.warn).toHaveBeenCalledOnce();
  });
  it('propagates an agent lookup failure instead of granting', async () => {
    m.agent.mockRejectedValue(new Error('agent lookup unavailable'));
    await expect(
      isOnboardingDraftAgent('repo-onboarder', 'agent-1', loop, globalCredential)
    ).rejects.toThrow('agent lookup unavailable');
  });
});
