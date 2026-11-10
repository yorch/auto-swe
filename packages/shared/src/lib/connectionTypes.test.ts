import { describe, expect, it } from 'vitest';
import {
  CONNECTION_TYPES,
  ConnectionTypeSchema,
  GENERIC_STEP_CONNECTION_TYPES,
  genericStepRefusal,
  getConnectionTypeMetadata,
  getWorkspaceTargetTypes,
  isConnectionType,
  isWorkspaceTargetType,
  listConnectionTypes,
  UNIMPLEMENTED_CONNECTION_TYPES,
} from './connectionTypes.js';

describe('connectionTypes', () => {
  it('exports the expected connection types', () => {
    expect(CONNECTION_TYPES).toEqual([
      'git_repo',
      'issue_tracker',
      'notion',
      'confluence',
      'zendesk',
      'hubspot',
      'slack_workspace',
      'http_api',
      'mcp',
    ]);
  });

  it('validates known types', () => {
    for (const type of CONNECTION_TYPES) {
      expect(ConnectionTypeSchema.safeParse(type).success).toBe(true);
      expect(isConnectionType(type)).toBe(true);
    }
  });

  it('rejects unknown types', () => {
    expect(ConnectionTypeSchema.safeParse('unknown').success).toBe(false);
    expect(isConnectionType('unknown')).toBe(false);
    expect(isConnectionType(123)).toBe(false);
  });

  it('returns metadata for every type', () => {
    const types = listConnectionTypes();
    expect(types).toHaveLength(CONNECTION_TYPES.length);
    for (const meta of types) {
      expect(meta.key).toBeTruthy();
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(getConnectionTypeMetadata(meta.key)).toBe(meta);
    }
  });

  it('classifies workspace targets', () => {
    const targets = getWorkspaceTargetTypes();
    expect(targets).toContain('git_repo');
    expect(targets).toContain('issue_tracker');
    expect(targets).toContain('notion');
    expect(targets).toContain('confluence');
    expect(targets).toContain('zendesk');
    expect(targets).toContain('hubspot');
    expect(targets).not.toContain('slack_workspace');
    expect(targets).not.toContain('http_api');
    expect(targets).not.toContain('mcp');

    expect(isWorkspaceTargetType('git_repo')).toBe(true);
    expect(isWorkspaceTargetType('mcp')).toBe(false);
  });
});

describe('generic step support', () => {
  it('refuses the connector-less types on every generic step', () => {
    for (const step of ['readSource', 'writeOutcome', 'runTool'] as const) {
      for (const type of ['http_api', 'hubspot', 'mcp', 'git_repo']) {
        expect(genericStepRefusal(step, type)).toContain(`${step} has no implementation`);
      }
    }
  });

  it('accepts what has an implementation', () => {
    expect(genericStepRefusal('readSource', 'notion')).toBeNull();
    expect(genericStepRefusal('writeOutcome', 'slack_workspace')).toBeNull();
    expect(genericStepRefusal('runTool', 'zendesk')).toBeNull();
    // Slack has no read, and Notion has no named tools.
    expect(genericStepRefusal('readSource', 'slack_workspace')).not.toBeNull();
    expect(genericStepRefusal('runTool', 'notion')).not.toBeNull();
  });

  it('keeps unimplemented types out of every step list', () => {
    for (const types of Object.values(GENERIC_STEP_CONNECTION_TYPES)) {
      for (const type of UNIMPLEMENTED_CONNECTION_TYPES) {
        expect(types).not.toContain(type);
      }
    }
  });

  it('points an mcp connection at the mcp node', () => {
    expect(genericStepRefusal('runTool', 'mcp')).toContain('`mcp` node');
  });
});
