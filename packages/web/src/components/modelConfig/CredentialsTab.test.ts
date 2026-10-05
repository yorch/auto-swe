import { describe, expect, it } from 'vitest';
import type { ProviderCredentialRow } from '@/hooks/useModelConfig';
import { isLastPlatformCredential } from './CredentialsTab';

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
