import { describe, expect, it } from 'vitest';
import { getSettingDefinition } from '../config/registry.js';
import {
  AgentRunPayloadSchema,
  agentRunTicketId,
  clampToCeiling,
  isLaunchableAgentKey,
  isReservedTemplateOrigin,
  NON_LAUNCHABLE_AGENT_KEYS,
} from './agentRun.js';

describe('AgentRunPayloadSchema', () => {
  it('defaults delivery to none', () => {
    expect(AgentRunPayloadSchema.parse({ agentRef: 'contentWriter' }).deliver).toBe('none');
  });

  it('accepts a pinned ref and caps', () => {
    const p = AgentRunPayloadSchema.parse({
      agentRef: 'reviewer@3',
      deliver: 'draft_pr',
      maxSteps: 10,
      maxWallClockSeconds: 120,
    });
    expect(p.agentRef).toBe('reviewer@3');
  });

  it.each([
    [{ agentRef: '' }],
    [{ agentRef: 'a b' }],
    [{ agentRef: 'a@0' }],
    [{ agentRef: 'a', deliver: 'push' }],
    [{ agentRef: 'a', maxSteps: 0 }],
    [{ agentRef: 'a', maxSteps: 501 }],
    [{ agentRef: 'a', maxWallClockSeconds: 59 }],
  ])('rejects %j', (bad) => {
    expect(AgentRunPayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe('AgentRunPayloadSchema orchestration fields', () => {
  const id = '0b1c2d3e-4f5a-4b6c-8d7e-9f8091a2b3c4';

  it('accepts an orchestration id and path scopes', () => {
    const p = AgentRunPayloadSchema.parse({
      agentRef: 'implementer',
      orchestrationId: id,
      pathScopes: ['src/a/**'],
    });
    expect(p.orchestrationId).toBe(id);
    expect(p.pathScopes).toEqual(['src/a/**']);
  });

  it('leaves both unset for a direct run', () => {
    const p = AgentRunPayloadSchema.parse({ agentRef: 'implementer' });
    expect(p.orchestrationId).toBeUndefined();
    expect(p.pathScopes).toBeUndefined();
  });

  it.each([
    [{ orchestrationId: 'nope' }],
    [{ pathScopes: Array.from({ length: 21 }, (_, i) => `d${i}/**`) }],
    [{ pathScopes: ['x'.repeat(201)] }],
    [{ pathScopes: 'src/**' }],
    [{ pathScopes: [] }],
    [{ pathScopes: ['../etc/**'] }],
    [{ pathScopes: ['/abs/x'] }],
    [{ pathScopes: ['src/ok/**', 'a/**/b'] }],
    [{ pathScopes: ['src/a b.ts'] }],
    [{ pathScopes: ['src/a\u{E0041}.ts'] }],
    [{ pathScopes: [''] }],
    [{ pathScopes: [42] }],
  ])('rejects %j', (bad) => {
    expect(AgentRunPayloadSchema.safeParse({ agentRef: 'a', ...bad }).success).toBe(false);
  });

  it('requires scopes for an orchestration child that delivers, whatever the delivery', () => {
    const base = { agentRef: 'a', orchestrationId: id };
    for (const deliver of ['branch', 'draft_pr'] as const) {
      expect(AgentRunPayloadSchema.safeParse({ ...base, deliver }).success).toBe(false);
      expect(
        AgentRunPayloadSchema.safeParse({ ...base, deliver, pathScopes: ['src/a/**'] }).success
      ).toBe(true);
    }
    // the default delivery is 'none', so a bare reader child is fine
    expect(AgentRunPayloadSchema.safeParse(base).success).toBe(true);
    expect(AgentRunPayloadSchema.safeParse({ ...base, deliver: 'none' }).success).toBe(true);
  });

  it('leaves a direct run (no orchestration) unrestricted when it delivers', () => {
    expect(AgentRunPayloadSchema.safeParse({ agentRef: 'a', deliver: 'draft_pr' }).success).toBe(
      true
    );
  });
});

describe('launchable agents', () => {
  it('denies the gate, judge and memory agents', () => {
    for (const key of ['securityReview', 'evalJudge', 'workflowAuthor', 'commitToMemory']) {
      expect(isLaunchableAgentKey(key)).toBe(false);
    }
    expect(NON_LAUNCHABLE_AGENT_KEYS.size).toBeGreaterThanOrEqual(8);
  });

  it('allows an ordinary agent', () => {
    expect(isLaunchableAgentKey('contentWriter')).toBe(true);
  });

  it('denies the orchestrator', () => {
    expect(isLaunchableAgentKey('orchestrator')).toBe(false);
  });
});

describe('clampToCeiling', () => {
  it('only lowers', () => {
    expect(clampToCeiling(undefined, 50)).toBe(50);
    expect(clampToCeiling(10, 50)).toBe(10);
    expect(clampToCeiling(500, 50)).toBe(50);
  });
});

describe('misc', () => {
  it('reserves system: origins', () => {
    expect(isReservedTemplateOrigin('system:agent-run')).toBe(true);
    expect(isReservedTemplateOrigin('swe-starter')).toBe(false);
    expect(isReservedTemplateOrigin(null)).toBe(false);
  });

  it('builds a ticket id the branch grammar accepts', () => {
    expect(agentRunTicketId('0a1b2c3d-1111-2222-3333-444455556666')).toBe(
      'agent-0a1b2c3d111122223333444455556666'
    );
  });
});

describe('agent run settings', () => {
  it.each([
    'workspace.agentRunMaxSteps',
    'workspace.agentRunMaxWallClockSeconds',
    'workspace.agentRunMaxConcurrentGlobal',
    'workspace.agentRunMaxConcurrentPerTeam',
    'workspace.agentRunAllowWorkflowChanges',
  ] as const)('%s is ADMIN-only and not run-pinned', (key) => {
    const def = getSettingDefinition(key);
    expect(def.requiredRole).toBe('ADMIN');
    expect(def.runPinned).toBe(false);
  });

  it('never offers the template or channel scope (a template cannot override a ceiling)', () => {
    for (const key of [
      'workspace.agentRunMaxSteps',
      'workspace.agentRunMaxWallClockSeconds',
      'workspace.agentRunMaxConcurrentPerTeam',
      'workspace.agentRunAllowWorkflowChanges',
    ] as const) {
      const scopes: readonly string[] = getSettingDefinition(key).overridableAt;
      expect(scopes).not.toContain('WORKFLOW_TEMPLATE');
      expect(scopes).not.toContain('CHANNEL');
    }
  });

  it('keeps the platform concurrency cap platform-wide, and 0 is a valid value', () => {
    const def = getSettingDefinition('workspace.agentRunMaxConcurrentGlobal');
    expect(def.overridableAt).toEqual([]);
    expect(def.schema.safeParse(0).success).toBe(true);
    expect(def.schema.safeParse(-1).success).toBe(false);
  });

  it('defaults keep workflow-file changes off', () => {
    expect(getSettingDefinition('workspace.agentRunAllowWorkflowChanges').defaultValue).toBe(false);
  });
});
