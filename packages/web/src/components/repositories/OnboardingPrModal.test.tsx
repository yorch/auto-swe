// @vitest-environment jsdom
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const h = vi.hoisted(() => ({
  keys: ['jq', 'uv', 'ruff'],
  mutate: vi.fn(),
  status: null as unknown,
  statusError: false,
}));
vi.mock('@/hooks/useRepositoryOnboarding', () => ({
  useOnboardingPrStatus: () => ({
    data: h.status,
    error: new Error('Status unavailable'),
    isError: h.statusError,
  }),
  useOnboardingToolCatalog: () => ({ data: h.keys, isError: false, isLoading: false }),
  useOpenOnboardingPr: () => ({ isPending: false, mutateAsync: h.mutate }),
}));

import { OnboardingPrModal } from './OnboardingPrModal';

const repo = {
  detectedStack: { primary: 'python' },
  id: 'repo',
  organizationName: 'acme',
  repoName: 'api',
} as RepositorySummary;
beforeAll(stubDialogPrototype);
afterEach(cleanup);
beforeEach(() => {
  h.keys = ['jq', 'uv', 'ruff'];
  h.status = null;
  h.statusError = false;
  h.mutate.mockReset().mockResolvedValue({ workflowId: 'onboard-repo-hash' });
});
describe('onboarding PR dialog', () => {
  it('caps manual tool selection at MAX_ONBOARDING_TOOLS', () => {
    h.keys = Array.from({ length: 33 }, (_, i) => `tool-${i}`);
    render(<OnboardingPrModal onClose={() => {}} repo={repo} />);
    for (const key of h.keys.slice(0, 32)) {
      fireEvent.click(screen.getByRole('checkbox', { name: key }));
    }
    expect(screen.getByRole('checkbox', { name: 'tool-32' })).toHaveProperty('disabled', true);
  });
  it('preselects catalog tools from the stack and submits both files', async () => {
    render(<OnboardingPrModal onClose={() => {}} repo={repo} />);
    expect(screen.getByRole('checkbox', { name: 'uv' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'ruff' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'jq' })).toHaveProperty('checked', false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ruff' }));
    fireEvent.change(screen.getByLabelText('Sensitive paths'), { target: { value: 'config/**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open onboarding PR' }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith({
        files: [
          { kind: 'tools', tools: [{ key: 'uv' }] },
          { kind: 'prPolicy', sensitivePaths: ['config/**'] },
        ],
      })
    );
    await waitFor(() => expect(screen.getByText('Waiting for onboarding status…')).toBeTruthy());
  });
  it.each(['opened', 'updated', 'nothing_to_do', 'failed'] as const)(
    'shows %s status and the PR link when present',
    async (outcome) => {
      h.status =
        outcome === 'failed'
          ? { error: 'Onboarding failed.', status: 'failed' }
          : {
              result: {
                pullRequestUrl:
                  outcome === 'nothing_to_do' ? undefined : 'https://github.com/acme/api/pull/7',
                status: outcome,
              },
              status: 'completed',
            };
      render(<OnboardingPrModal onClose={() => {}} repo={repo} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open onboarding PR' }));
      await waitFor(() => expect(screen.queryByText('Catalog tools (2/32)')).toBeNull());
      if (outcome === 'failed') {
        expect(await screen.findByText('Onboarding failed.')).toBeTruthy();
      } else if (outcome === 'nothing_to_do') {
        expect(await screen.findByText(/Nothing to do/)).toBeTruthy();
      } else {
        expect(await screen.findByRole('link', { name: 'View pull request' })).toHaveProperty(
          'href',
          'https://github.com/acme/api/pull/7'
        );
      }
    }
  );
  it('supports policy-only onboarding with an empty catalog', async () => {
    h.keys = [];
    render(<OnboardingPrModal onClose={() => {}} repo={repo} />);
    expect(screen.getByRole('button', { name: 'Open onboarding PR' })).toHaveProperty(
      'disabled',
      true
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include .auto-swe/tools.yml' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open onboarding PR' }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith({
        files: [{ kind: 'prPolicy', sensitivePaths: ['**/auth/**', '**/migrations/**'] }],
      })
    );
  });
  it('keeps selections when submission fails', async () => {
    h.mutate.mockRejectedValue(new Error('GitHub unavailable'));
    render(<OnboardingPrModal onClose={() => {}} repo={repo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open onboarding PR' }));
    expect(await screen.findByText('GitHub unavailable')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'uv' })).toHaveProperty('checked', true);
  });
});
