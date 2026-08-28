import { describe, expect, it } from 'vitest';
import {
  CONNECTION_TYPES,
  ConnectionTypeSchema,
  getConnectionTypeMetadata,
  getWorkspaceTargetTypes,
  isConnectionType,
  isWorkspaceTargetType,
  listConnectionTypes,
} from './connectionTypes.js';

describe('connectionTypes', () => {
  it('exports the expected connection types', () => {
    expect(CONNECTION_TYPES).toEqual([
      'git_repo',
      'issue_tracker',
      'notion',
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
    expect(targets).toContain('zendesk');
    expect(targets).toContain('hubspot');
    expect(targets).not.toContain('slack_workspace');
    expect(targets).not.toContain('http_api');
    expect(targets).not.toContain('mcp');

    expect(isWorkspaceTargetType('git_repo')).toBe(true);
    expect(isWorkspaceTargetType('mcp')).toBe(false);
  });
});
