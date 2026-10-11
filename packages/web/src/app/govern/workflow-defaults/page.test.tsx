// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/workflow/WorkflowDefaultsForm', () => ({
  WorkflowDefaultsForm: () => null,
}));
vi.mock('@/components/workflow/ConsolidationForm', () => ({ ConsolidationForm: () => null }));
vi.mock('@/components/workflow/RevalidationForm', () => ({ RevalidationForm: () => null }));
vi.mock('@/components/workflow/CanaryForm', () => ({ CanaryForm: () => null }));

const { default: Page } = await import('./page');

describe('workflow defaults page warning', () => {
  it('warns that admin edits are platform-wide and reach runs already in progress', () => {
    render(<Page />);
    const callout = screen
      .getByText('Only admins edit these, and the changes are platform-wide')
      .closest('[role="status"]');
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toMatch(/apply to every team and workflow template/);
    expect(callout?.textContent).toMatch(/with no per-team override/);
    expect(callout?.textContent).toMatch(/budget ceiling within about 30 seconds/);
    expect(callout?.textContent).toMatch(/CI wait settings from the run's CI step onward/);
  });
});
