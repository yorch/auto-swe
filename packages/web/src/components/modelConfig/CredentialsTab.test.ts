import { describe, expect, it } from 'vitest';
import type { ProviderCredentialRow } from '@/hooks/useModelConfig';
import { credentialSaveBody, isLastPlatformCredential, usedByLabel } from './CredentialsTab';

const cred = (over: Partial<ProviderCredentialRow>): ProviderCredentialRow =>
  ({ id: 'a', provider: 'anthropic', scope: 'GLOBAL', ...over }) as ProviderCredentialRow;

describe('isLastPlatformCredential', () => {
  it('is last when only a scoped credential remains alongside it', () => {
    const global = cred({ id: 'g' });
    expect(isLastPlatformCredential(global, [global, cred({ id: 't', scope: 'TEAM' })])).toBe(true);
  });

  it('is not last when another GLOBAL credential for the provider exists', () => {
    const global = cred({ id: 'g' });
    expect(isLastPlatformCredential(global, [global, cred({ id: 'g2' })])).toBe(false);
  });

  it('is never last for a scoped credential, which falls back to the platform one', () => {
    const team = cred({ id: 't', scope: 'TEAM' });
    expect(isLastPlatformCredential(team, [team])).toBe(false);
  });

  it('ignores other providers', () => {
    const global = cred({ id: 'g' });
    expect(isLastPlatformCredential(global, [global, cred({ id: 'o', provider: 'openai' })])).toBe(
      true
    );
  });
});

describe('usedByLabel', () => {
  it('counts embeddings apart from agents', () => {
    expect(usedByLabel(['embeddings'])).toBe('Used by embeddings');
    expect(usedByLabel(['implementer', 'embeddings'])).toBe(
      'Used by 1 agent and embeddings: Implementer'
    );
  });

  it('lists agents alone and truncates long lists', () => {
    expect(usedByLabel(['implementer', 'reviewer'])).toBe(
      'Used by 2 agents: Implementer, Reviewer'
    );
    expect(usedByLabel(['a', 'b', 'c', 'd', 'e', 'f'])).toContain('and 2 more');
  });
});

describe('credentialSaveBody', () => {
  const form = {
    allowPrivateNetwork: false,
    apiBase: '',
    apiKey: 'sk-1',
    provider: 'vllm',
    scope: 'GLOBAL' as const,
    teamId: '',
  };

  it('sends the private-network opt-in on create only when ticked', () => {
    expect(credentialSaveBody(null, form)).not.toHaveProperty('allowPrivateNetwork');
    expect(
      credentialSaveBody(null, {
        ...form,
        allowPrivateNetwork: true,
        apiBase: 'http://10.0.0.5:8000/v1',
      })
    ).toEqual({
      allowPrivateNetwork: true,
      apiBase: 'http://10.0.0.5:8000/v1',
      apiKey: 'sk-1',
      provider: 'vllm',
      scope: 'GLOBAL',
    });
  });

  it('sends the opt-in on edit only when it changed, alongside nothing else that did not', () => {
    const existing = cred({ allowPrivateNetwork: true, apiBase: 'http://10.0.0.5:8000/v1' });
    const unchanged = { ...form, allowPrivateNetwork: true, apiBase: 'http://10.0.0.5:8000/v1' };
    expect(credentialSaveBody(existing, { ...unchanged, apiKey: '' })).toEqual({});
    expect(
      credentialSaveBody(existing, { ...unchanged, allowPrivateNetwork: false, apiKey: '' })
    ).toEqual({ allowPrivateNetwork: false });
  });
});
