// @vitest-environment jsdom

import {
  CAMPAIGN_STATE_VALUES,
  CAMPAIGN_TARGET_STATE_VALUES,
} from '@auto-swe/shared/lib/campaignState';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CampaignStateBadge, TargetStateBadge } from './CampaignStateBadge';
import { CAMPAIGN_STATE_LABELS, TARGET_STATE_LABELS } from './campaignDisplay';

afterEach(cleanup);

describe('state badges', () => {
  it('name every campaign state in words', () => {
    for (const state of CAMPAIGN_STATE_VALUES) {
      render(<CampaignStateBadge state={state} />);
      expect(screen.getByText(CAMPAIGN_STATE_LABELS[state])).toBeTruthy();
      cleanup();
    }
  });

  it('name every target state in words, a retired one as its replacement', () => {
    for (const state of CAMPAIGN_TARGET_STATE_VALUES) {
      const { container } = render(<TargetStateBadge state={state} />);
      const text = container.textContent ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/_/);
      cleanup();
    }
    render(<TargetStateBadge state="FAILED" />);
    expect(screen.getByText(TARGET_STATE_LABELS.NEEDS_ATTENTION)).toBeTruthy();
  });

  it('hides the colour dot from assistive technology', () => {
    const { container } = render(<TargetStateBadge state="RUNNING" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});
