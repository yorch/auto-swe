// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CampaignProposals } from './CampaignProposals';

afterEach(cleanup);

describe('CampaignProposals', () => {
  it('renders nothing when discovery found nothing it could not start', () => {
    const { container } = render(<CampaignProposals proposals={[]} />);
    expect(container.textContent).toBe('');
  });

  it('gives each repository with its reason, and does not name one the viewer cannot see', () => {
    render(
      <CampaignProposals
        proposals={[
          {
            connectionId: 'c1',
            createdAt: '2026-01-01T00:00:00Z',
            decidedAt: null,
            id: 'p1',
            reason: 'Push permission is required.',
            repoLabel: 'acme/billing',
          },
          {
            connectionId: 'c2',
            createdAt: '2026-01-01T00:00:00Z',
            decidedAt: '2026-01-02T00:00:00Z',
            id: 'p2',
            reason: 'The repository is not in the launcher’s organization.',
            repoLabel: null,
          },
        ]}
      />
    );
    expect(screen.getByText('acme/billing')).toBeTruthy();
    expect(screen.getByText('Push permission is required.')).toBeTruthy();
    expect(screen.getByText('A repository you cannot see')).toBeTruthy();
    expect(screen.getByText(/decided/)).toBeTruthy();
  });
});
