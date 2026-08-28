import { describe, expect, it } from 'vitest';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
  listWorkspaceProviderTypes,
  WORKSPACE_PROVIDER_TYPES,
  WorkspaceProviderTypeSchema,
} from './workspaceProviders.js';

describe('workspaceProviders', () => {
  it('lists the expected provider types', () => {
    expect(WORKSPACE_PROVIDER_TYPES).toEqual([
      'git_repo',
      'document',
      'issue_tracker',
      'record',
      'api_only',
    ]);
  });

  it('validates known provider types', () => {
    for (const type of WORKSPACE_PROVIDER_TYPES) {
      expect(WorkspaceProviderTypeSchema.safeParse(type).success).toBe(true);
      expect(isWorkspaceProviderType(type)).toBe(true);
    }
  });

  it('rejects unknown provider types', () => {
    expect(WorkspaceProviderTypeSchema.safeParse('vm').success).toBe(false);
    expect(isWorkspaceProviderType('vm')).toBe(false);
  });

  it('returns metadata for every provider', () => {
    const providers = listWorkspaceProviderTypes();
    expect(providers).toHaveLength(WORKSPACE_PROVIDER_TYPES.length);
    for (const meta of providers) {
      expect(meta.key).toBeTruthy();
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(getWorkspaceProviderMetadata(meta.key)).toBe(meta);
    }
  });

  it('maps git_repo to the git_repo connection type', () => {
    expect(getWorkspaceProviderMetadata('git_repo').connectionType).toBe('git_repo');
  });

  it('maps document provider to the notion connection type', () => {
    expect(getWorkspaceProviderMetadata('document').connectionType).toBe('notion');
  });
});
