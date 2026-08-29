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

  it('maps providers to their supported connection types', () => {
    expect(getWorkspaceProviderMetadata('git_repo').connectionTypes).toEqual(['git_repo']);
    expect(getWorkspaceProviderMetadata('document').connectionTypes).toEqual(['notion']);
    expect(getWorkspaceProviderMetadata('issue_tracker').connectionTypes).toEqual(['issue_tracker']);
    expect(getWorkspaceProviderMetadata('record').connectionTypes).toEqual(['zendesk', 'hubspot']);
    expect(getWorkspaceProviderMetadata('api_only').connectionTypes).toEqual([]);
  });
});
