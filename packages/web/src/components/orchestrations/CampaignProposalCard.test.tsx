// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detail, message } from '@/test/orchestrationFixtures';

const modal = vi.hoisted(() => ({
  props: [] as Array<{ initialValues?: Record<string, unknown>; open: boolean }>,
}));
vi.mock('@/components/campaigns/CampaignStartModal', () => ({
  CampaignStartModal: (p: { initialValues?: Record<string, unknown>; open: boolean }) => {
    modal.props.push(p);
    return p.open ? <div data-testid="start-modal" /> : null;
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { CampaignProposalRow, proposalInitialValues } from './CampaignProposalCard';

const R1 = '00000000-0000-4000-8000-0000000000b2';
const payload = {
  brief: '<img src=x onerror=alert(1)> Raise lodash.',
  droppedRepoCount: 2,
  name: '<b>Raise</b> lodash',
  ownerTeamId: '00000000-0000-4000-8000-0000000000a1',
  plan: 'UNIFORM' as const,
  recipe: { params: { packageName: 'lodash', targetVersion: '4.17.21' }, ref: 'npm-dependency@2' },
  repoIds: [R1],
};
const proposal = (over: Record<string, unknown> = {}) =>
  message({
    body: 'Proposed campaign: x',
    kind: 'CAMPAIGN_PROPOSAL',
    payload,
    role: 'ORCHESTRATOR',
    ...over,
  });

afterEach(() => {
  cleanup();
  modal.props.length = 0;
});

describe('CampaignProposalRow', () => {
  it('renders model text as plain text, never as markup', () => {
    const { container } = render(<CampaignProposalRow detail={detail()} message={proposal()} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<b>Raise</b> lodash')).toBeTruthy();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> Raise lodash.');
  });

  it('says nothing has started and counts dropped repositories without naming them', () => {
    const { container } = render(<CampaignProposalRow detail={detail()} message={proposal()} />);
    expect(container.textContent).toContain('Nothing starts until a person reviews it');
    expect(container.textContent).toContain('1 repository named.');
    expect(container.textContent).toContain('2 more could not be included');
  });

  it('offers Review and start to the launcher, which opens the Start form pre-filled', () => {
    render(<CampaignProposalRow detail={detail({ canControl: true })} message={proposal()} />);
    expect(screen.queryByTestId('start-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review and start' }));
    expect(screen.getByTestId('start-modal')).toBeTruthy();
    const last = modal.props.at(-1);
    expect(last?.open).toBe(true);
    expect(last?.initialValues).toEqual({
      description: payload.brief,
      name: payload.name,
      ownerTeamId: payload.ownerTeamId,
      packageName: 'lodash',
      plan: 'UNIFORM',
      recipeRef: 'npm-dependency@2',
      repoIds: [R1],
      targetVersion: '4.17.21',
    });
  });

  it('offers no action to a viewer who is not the launcher', () => {
    render(<CampaignProposalRow detail={detail({ canControl: false })} message={proposal()} />);
    expect(screen.queryByRole('button', { name: 'Review and start' })).toBeNull();
  });

  it('shows only the fixed body when the payload is withheld or unreadable', () => {
    const { container } = render(
      <CampaignProposalRow
        detail={detail()}
        message={proposal({ body: 'Withheld: you cannot access', payload: { withheld: true } })}
      />
    );
    expect(container.textContent).toContain('Withheld: you cannot access');
    expect(screen.queryByRole('button', { name: 'Review and start' })).toBeNull();
  });
});

describe('proposalInitialValues', () => {
  it('omits what the proposal did not set', () => {
    expect(
      proposalInitialValues({
        brief: 'b',
        droppedRepoCount: 0,
        name: 'n',
        plan: 'PLANNED',
        repoIds: [],
      })
    ).toEqual({ description: 'b', name: 'n', plan: 'PLANNED', repoIds: [] });
  });
});
