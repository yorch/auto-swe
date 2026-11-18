// @vitest-environment jsdom

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { HumanStepCard } from './HumanStepCard';

const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock('@/hooks/useApprovals', () => ({
  useRespondToApproval: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync,
    reset: vi.fn(),
  }),
}));

const DRAFT = [
  '## Repository onboarding draft',
  '',
  '### .auto-swe/setup.yml',
  '',
  '```yaml',
  'steps:',
  '  - name: Install',
  '    run: yarn install',
  '```',
  '',
  '### .auto-swe/gates.yml',
  '',
  '```yaml',
  'runTests: yarn test',
  '```',
].join('\n');

const BLOCKED_REPORT = [
  '## Repository onboarding trial',
  '',
  'Trial blocked; operator action is required.',
  '',
  '- **failed** — setup: Verify required local tooling (exit 1)',
  '    /bin/sh: docker: not found',
  '',
  '- **egress_denied**: Allow registry.example.test in the egress policy',
].join('\n');

const PASSED_REPORT =
  '## Repository onboarding trial\n\nTrial passed.\n\n- **passed** — setup: Install';

function onboardingStep(context: unknown, overrides: Partial<HumanStepSummary> = {}) {
  return {
    context,
    description: 'Review the proposed configuration.',
    id: 'ob1',
    kind: 'APPROVAL',
    nodeId: 'review',
    requestedAt: '2026-11-11T10:00:00.000Z',
    run: { id: 'r1', status: 'RUNNING', workflowId: 'w1', workRequestId: 'wr1' },
    runId: 'r1',
    status: 'PENDING',
    timeoutAt: new Date(Date.now() + 167.99 * 3_600_000).toISOString(),
    title: 'Review repository onboarding',
    ...overrides,
  } as HumanStepSummary;
}

const blocked = {
  draftMarkdown: DRAFT,
  status: 'Draft not verified: the trial is blocked and needs operator action.',
  trialMarkdown: BLOCKED_REPORT,
  trialOutcome: 'blocked',
};
const passed = {
  draftMarkdown: DRAFT,
  status: 'Draft verified: the trial passed. Review the draft before approving.',
  trialMarkdown: PASSED_REPORT,
  trialOutcome: 'passed',
};

function open(step: HumanStepSummary) {
  render(<HumanStepCard step={step} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review and decide' }));
}

/** Whether a button wears the solid accent fill of the primary variant. */
function isPrimary(button: HTMLElement): boolean {
  return button.className.includes('bg-accent-500');
}

beforeEach(() => {
  stubDialogPrototype();
  mutateAsync.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('onboarding approval context', () => {
  it('renders the YAML as separate code blocks, not an escaped JSON string', () => {
    open(onboardingStep(blocked));
    const view = screen.getByTestId('onboarding-review');
    expect(view.querySelectorAll('pre')).toHaveLength(2);
    expect(within(view).getByRole('heading', { name: '.auto-swe/setup.yml' })).toBeTruthy();
    expect(within(view).getByRole('heading', { name: '.auto-swe/gates.yml' })).toBeTruthy();
    expect(view.textContent).toContain('run: yarn install');
    expect(view.textContent).not.toContain('\\n');
    expect(view.textContent).not.toContain('draftMarkdown');
  });

  it('puts the trial summary above the draft and adds no scroll area of its own', () => {
    open(onboardingStep(blocked));
    const view = screen.getByTestId('onboarding-review');
    const summary = within(view).getByText('Trial blocked');
    const draft = within(view).getByRole('heading', { name: '.auto-swe/setup.yml' });
    expect(summary.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(view).getAllByText(/Verify required local tooling/).length).toBeGreaterThan(0);
    expect(within(view).getAllByText('egress_denied').length).toBeGreaterThan(0);
    for (const el of view.querySelectorAll('[class]')) {
      expect(el.getAttribute('class')).not.toMatch(/max-h-|overflow-y-/);
    }
  });

  it('does not inject raw HTML from the draft', () => {
    open(
      onboardingStep({
        ...passed,
        draftMarkdown: '## Draft\n\n<img src=x onerror="alert(1)"><script>alert(1)</script>',
      })
    );
    const view = screen.getByTestId('onboarding-review');
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('script')).toBeNull();
  });

  it('falls back to the generic view for other contexts and unparsable ones', () => {
    open(onboardingStep('plain text context, not an onboarding payload'));
    expect(screen.queryByTestId('onboarding-review')).toBeNull();
    expect(screen.getByText('plain text context, not an onboarding payload')).toBeTruthy();
  });
});

describe('onboarding approval decision', () => {
  it('de-emphasizes Approve and asks for explicit confirmation when the trial did not pass', () => {
    open(onboardingStep(blocked));
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(isPrimary(approve)).toBe(false);
    fireEvent.click(approve);
    expect(screen.getByText('The trial did not pass')).toBeTruthy();
    expect(screen.getByText(/The trial was blocked/)).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve anyway' }));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ action: 'approve', id: 'ob1' });
  });

  it('keeps Approve primary, with no warning, when the trial passed', () => {
    open(onboardingStep(passed));
    expect(isPrimary(screen.getByRole('button', { name: 'Approve' }))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.queryByText('The trial did not pass')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve anyway' })).toBeNull();
  });

  it('shows the note field and sends the note with the decision', () => {
    open(onboardingStep(passed));
    fireEvent.change(screen.getByLabelText('Note for the requester'), {
      target: { value: 'Looks right to me' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    // The note carries into the dialog's own field.
    expect((screen.getByLabelText('Comment (optional)') as HTMLTextAreaElement).value).toBe(
      'Looks right to me'
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      action: 'approve',
      comment: 'Looks right to me',
    });
  });
});

describe('approval card metadata', () => {
  it('words the expiry as a duration and gives the absolute request time on the timestamp', () => {
    render(<HumanStepCard step={onboardingStep(passed)} />);
    expect(screen.getByText('expires in 7 days')).toBeTruthy();
    expect(screen.queryByText(/167/)).toBeNull();
    const requested = screen.getByText(/^Requested/).closest('time');
    expect(requested?.getAttribute('dateTime')).toBe('2026-11-11T10:00:00.000Z');
    expect(requested?.getAttribute('title')).toMatch(/^Requested .*2026/);
  });

  it('underlines the request links at rest', () => {
    render(<HumanStepCard step={onboardingStep(passed)} />);
    for (const name of ['View request', 'Full diagnostics']) {
      expect(screen.getByRole('link', { name }).className).toMatch(/(^| )underline( |$)/);
    }
  });
});
