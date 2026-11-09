// @vitest-environment jsdom

import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewBrief } from './ReviewBrief';

type Evaluation = NonNullable<PullRequestCockpit['evaluation']>;

const pull: PullRequestCockpit['pull'] = {
  ciStatus: 'PASSED',
  closedAt: null,
  costUsd: null,
  headSha: 'abc1234',
  id: 'pr-1',
  isDraft: false,
  latestRun: null,
  mergedAt: null,
  openedAt: '2026-11-01T09:00:00.000Z',
  ownerTeam: null,
  prNumber: 7,
  repository: { id: 'repo-1', name: 'api', org: 'acme' },
  status: 'OPEN',
  ticketId: null,
  title: 'Add the thing',
  url: null,
  workRequestId: null,
};

const evaluation = (over: Partial<Evaluation> = {}): Evaluation => ({
  claimsToVerify: [],
  createdAt: '2026-11-03T10:00:00.000Z',
  evidence: null,
  findings: [],
  headSha: 'abc1234',
  id: 'eval-1',
  intent: null,
  mode: 'advisory',
  reasons: [],
  requiredApprovers: 1,
  riskClass: 'STANDARD',
  stale: false,
  statusState: 'pending',
  ...over,
});

const evidence = (over: Partial<NonNullable<Evaluation['evidence']>> = {}) => ({
  ci: 'passed' as const,
  runUrl: null,
  tests: { failing: 1, passing: 11, total: 12 },
  ui: null,
  ...over,
});

const show = (e: Evaluation | null, p = pull) => render(<ReviewBrief evaluation={e} pull={p} />);

afterEach(cleanup);

describe('ReviewBrief', () => {
  it('says there is no brief for a pull request that was never evaluated', () => {
    show(null);
    expect(document.body.textContent).toContain('has not been evaluated');
  });

  it('draws nothing for an evaluation that stored nothing to show', () => {
    const { container } = show(
      evaluation({ reasons: [{ code: 'x', message: 'fyi', paths: [], severity: 'info' }] })
    );
    expect(container.textContent).toBe('');
  });

  describe('what was asked', () => {
    it('lists the criteria and the open questions', () => {
      show(
        evaluation({
          intent: {
            criteria: ['GET /orders returns the caller’s orders'],
            handled: [],
            openQuestions: ['which scheme?'],
          },
        })
      );
      expect(screen.getByText('What was asked')).toBeTruthy();
      expect(screen.getByText('GET /orders returns the caller’s orders')).toBeTruthy();
      expect(screen.getByText('Open questions')).toBeTruthy();
      expect(screen.getByText('which scheme?')).toBeTruthy();
    });

    it('words how the run settled a question as its own account, not a fact', () => {
      show(
        evaluation({
          intent: {
            criteria: [],
            handled: [
              { note: 'used a bearer token', question: 'which scheme?', resolution: 'implemented' },
              { note: '', question: 'what page size?', resolution: 'left-unchanged' },
            ],
            openQuestions: ['which scheme?', 'what page size?'],
          },
        })
      );
      const text = document.body.textContent ?? '';
      expect(text).toContain('The run says it implemented this: used a bearer token');
      expect(text).toContain('The run says it left this unchanged');
      expect(text).toContain('That is its own account, not checked.');
    });

    it('shows ticket text as text, with hidden characters made visible', () => {
      const { container } = show(
        evaluation({
          intent: {
            criteria: ['<script>alert(1)</script> ship‮ it'],
            handled: [],
            openQuestions: [],
          },
        })
      );
      expect(container.querySelector('script')).toBeNull();
      expect(container.textContent).toContain('<script>alert(1)</script> ship⟨U+202E⟩ it');
    });

    it('draws nothing for an intent with neither', () => {
      const { container } = show(
        evaluation({ intent: { criteria: [], handled: [], openQuestions: [] } })
      );
      expect(container.textContent).toBe('');
    });
  });

  describe('what the run verified', () => {
    it('states the tests, CI and the limit of what they show', () => {
      show(evaluation({ evidence: evidence({ ci: 'pending' }) }));
      const text = document.body.textContent ?? '';
      expect(text).toContain('Tests: 11 passing, 1 failing at this head.');
      expect(text).toContain('CI when this was evaluated: still running.');
      expect(text).toContain('Not checked here: whether the tests cover what was asked.');
    });

    it.each([
      [null, 'Tests: no result recorded for this head.'],
      [{ failing: 0, passing: 0, total: 0 }, 'Tests: none ran at this head.'],
    ])('says it plainly when the tests are %j', (tests, sentence) => {
      show(evaluation({ evidence: evidence({ tests }) }));
      expect(document.body.textContent).toContain(sentence);
    });

    it.each([
      ['failed', 'failed'],
      ['none', 'no checks ran'],
      ['passed', 'passed'],
      [null, 'could not be read'],
    ] as const)('says CI %s in words', (ci, words) => {
      show(evaluation({ evidence: evidence({ ci }) }));
      expect(document.body.textContent).toContain(`CI when this was evaluated: ${words}.`);
    });

    it('counts the browser checks the run captured', () => {
      show(evaluation({ evidence: evidence({ ui: { screenshots: 2, traces: 0, videos: 1 } }) }));
      expect(document.body.textContent).toContain(
        'Browser checks the run captured: 2 screenshots, 1 video.'
      );
    });

    it('links the run inside the dashboard when the caller can see it', () => {
      show(evaluation({ evidence: evidence() }), {
        ...pull,
        latestRun: { id: 'run-1', status: 'SUCCESS' },
      });
      expect(screen.getByRole('link', { name: 'The run' }).getAttribute('href')).toBe(
        '/runs/run-1'
      );
    });

    it('links a safe stored run address when there is no run to link, and an unsafe one never', () => {
      const { unmount } = show(
        evaluation({ evidence: evidence({ runUrl: 'https://app.example.com/runs/9' }) })
      );
      const link = screen.getByRole('link', { name: 'The run' });
      expect(link.getAttribute('href')).toBe('https://app.example.com/runs/9');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      unmount();
      show(evaluation({ evidence: evidence({ runUrl: 'javascript:alert(1)' }) }));
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  it('lists why the risk class is what it is, leaving out the notes that only inform', () => {
    show(
      evaluation({
        reasons: [
          { code: 'a', message: 'Touches an auth path', paths: [], severity: 'raise' },
          { code: 'b', message: 'Only a note', paths: [], severity: 'info' },
        ],
      })
    );
    expect(screen.getByText('Why this risk class')).toBeTruthy();
    expect(screen.getByText('Touches an auth path')).toBeTruthy();
    expect(screen.queryByText('Only a note')).toBeNull();
  });

  it('lists what to verify', () => {
    show(evaluation({ claimsToVerify: ['A scanner found a secret'] }));
    expect(screen.getByText('To verify')).toBeTruthy();
    expect(screen.getByText('A scanner found a secret')).toBeTruthy();
  });
});
