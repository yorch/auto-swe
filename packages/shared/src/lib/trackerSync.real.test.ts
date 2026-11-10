import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedIssueTrackerConfig } from './integrations/registry.js';
import { syncTrackerOnEvent } from './trackerSync.js';

// A REAL provider (no mocked registry): providers swallow their own HTTP errors, so this proves
// the failure still reaches the result.
const config: ResolvedIssueTrackerConfig = {
  allowPrivateNetwork: false,
  apiToken: 'lin_api_test',
  baseUrl: null,
  email: null,
  provider: 'linear',
};
const event = { issueId: 'iss-1', type: 'ci_passed' } as const;

afterEach(() => vi.unstubAllGlobals());

describe('syncTrackerOnEvent with a real provider', () => {
  it('reports the failure class when the tracker answers 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({}), ok: false, status: 500 }))
    );
    await expect(syncTrackerOnEvent(event, config, { runInputId: null })).resolves.toBe(
      'server_error'
    );
  });

  it('reports no failure when the tracker answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ data: { commentCreate: { success: true } } }),
        ok: true,
      }))
    );
    await expect(syncTrackerOnEvent(event, config, { runInputId: null })).resolves.toBeNull();
  });
});
