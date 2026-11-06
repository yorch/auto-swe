// @vitest-environment jsdom

import type { PullRequestCockpit, PullRequestCockpitFile } from '@auto-swe/shared/types/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syntaxForDiff } from '@/lib/diffSyntax';
import { clearViewport, mockViewport } from '@/test/matchMedia';
import { installMemoryStorage } from '@/test/memoryStorage';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { PullRequestReview } from './PullRequestReview';

// The real highlighter is exercised in its own tests; here the page only needs to know what it asks.
vi.mock('@/lib/diffSyntax', () => ({ syntaxForDiff: vi.fn(async () => null) }));
const syntaxFor = vi.mocked(syntaxForDiff);

const DIGEST = 'a'.repeat(64);
const PATCH = ['@@ -1,2 +1,3 @@', ' keep', '+added', ' tail'].join('\n');

const file = (over: Partial<PullRequestCockpitFile> = {}): PullRequestCockpitFile => ({
  additions: 1,
  deletions: 0,
  flagged: false,
  patch: PATCH,
  patchDigest: DIGEST,
  path: 'src/a.ts',
  previousPath: null,
  skim: null,
  status: 'modified',
  verify: null,
  why: null,
  ...over,
});

function cockpit(over: Partial<PullRequestCockpit> = {}): PullRequestCockpit {
  return {
    changedSinceViewed: [],
    drafts: [],
    evaluation: {
      claimsToVerify: [],
      createdAt: '2026-11-03T10:00:00.000Z',
      evidence: null,
      findings: [],
      headSha: 'abc1234def',
      id: 'eval-1',
      intent: null,
      mode: 'advisory',
      reasons: [],
      requiredApprovers: 1,
      riskClass: 'STANDARD',
      stale: false,
      statusState: 'pending',
    },
    files: {
      headSha: 'abc1234def',
      items: [file()],
      state: 'open',
      truncated: false,
      type: 'ok',
    },
    pull: {
      ciStatus: 'PASSED',
      closedAt: null,
      costUsd: null,
      headSha: 'abc1234def',
      id: 'pr-1',
      isDraft: false,
      latestRun: { id: 'run-1', status: 'SUCCESS' },
      mergedAt: null,
      openedAt: '2026-11-01T09:00:00.000Z',
      prNumber: 7,
      repository: { id: 'repo-1', name: 'api', org: 'acme' },
      status: 'OPEN',
      ticketId: 'JIRA-1',
      title: 'Add the thing',
      url: 'https://github.com/acme/api/pull/7',
      workRequestId: 'wr-1',
    },
    sinceLastVisit: null,
    viewed: [],
    write: {
      approvalMayNotCount: false,
      available: false,
      feedbackLoopEnabled: false,
      reason: 'no-token',
    },
    ...over,
  };
}

const withFiles = (items: PullRequestCockpitFile[], extra: Partial<PullRequestCockpit> = {}) =>
  cockpit({
    files: { headSha: 'abc1234def', items, state: 'open', truncated: false, type: 'ok' },
    ...extra,
  });

const finding = (over: Record<string, unknown> = {}) => ({
  anchored: true,
  category: 'logic',
  description: 'off by one in the loop',
  file: 'src/a.ts',
  line: 2,
  reviewer: 'DOMAIN_LOGIC',
  severity: 'WARNING' as const,
  suggestedFix: 'use <=',
  ...over,
});

const withFindings = (findings: ReturnType<typeof finding>[]) => {
  const base = cockpit();
  return cockpit({ evaluation: base.evaluation && { ...base.evaluation, findings } });
};

/**
 * A file's name is on two buttons, the rail's and the diff's header; only the header toggles, so
 * it is the one that says whether it is expanded.
 */
const headerOf = (name: string) => {
  const matching = screen
    .getAllByRole('button', { name: new RegExp(name) })
    .filter((button) => button.hasAttribute('aria-expanded'));
  if (matching.length !== 1) {
    throw new Error(`expected one diff header for ${name}, found ${matching.length}`);
  }
  return matching[0] as HTMLElement;
};

const show = (data: PullRequestCockpit) => render(withQuery(<PullRequestReview data={data} />));
const fetchSpy = () =>
  setupFetchMock({
    'POST /api/v1/pull-requests/pr-1/visit': () => ({ data: { recorded: true } }),
    'PUT /api/v1/pull-requests/pr-1/viewed': () => ({ data: { updated: 1 } }),
  });

beforeEach(() => {
  fetchSpy();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the header', () => {
  it('names the pull request, its repository, risk and head, and links to the host', () => {
    show(cockpit());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('#7 Add the thing');
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.getByText('Standard risk')).toBeTruthy();
    expect(screen.getByText('abc1234')).toBeTruthy();
    const host = screen.getByRole('link', { name: /Open on the host/ });
    expect(host.getAttribute('href')).toBe('https://github.com/acme/api/pull/7');
    expect(host.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Run' }).getAttribute('href')).toBe('/runs/run-1');
  });

  it('shows a title as text, with hidden characters made visible, and links no unsafe address', () => {
    const data = cockpit();
    data.pull.title = '<img src=x onerror=alert(1)>‮';
    data.pull.url = 'javascript:alert(1)';
    const { container } = show(data);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('⟨U+202E⟩');
    expect(screen.queryByRole('link', { name: /Open on the host/ })).toBeNull();
  });

  it.each([
    ['HIGH', 'High risk'],
    ['LOW', 'Low risk'],
  ] as const)('says %s in words', (riskClass, words) => {
    const base = cockpit();
    show(cockpit({ evaluation: base.evaluation && { ...base.evaluation, riskClass } }));
    expect(screen.getByText(words)).toBeTruthy();
  });
});

describe('what it says is wrong or missing', () => {
  it('warns that the review covers an earlier commit', () => {
    const base = cockpit();
    show(
      cockpit({
        evaluation: base.evaluation && { ...base.evaluation, headSha: '1111111aaa', stale: true },
      })
    );
    expect(screen.getByText('The review covers an earlier commit')).toBeTruthy();
    expect(document.body.textContent).toContain('1111111');
  });

  it('explains why the files are missing and still shows the brief', () => {
    show(cockpit({ files: { reason: 'rate-limited', type: 'unavailable' } }));
    expect(screen.getByText('The changed files are not available')).toBeTruthy();
    expect(document.body.textContent).toContain('limiting requests');
    expect(screen.queryByRole('navigation', { name: 'Changed files' })).toBeNull();
  });

  it('says when the host lists more files than are shown', () => {
    show(
      cockpit({
        files: {
          headSha: 'abc1234def',
          items: [file()],
          state: 'open',
          truncated: true,
          type: 'ok',
        },
      })
    );
    expect(document.body.textContent).toContain('more files than are shown');
  });

  it('says when the pull request is no longer open on the host', () => {
    show(
      cockpit({
        files: {
          headSha: 'abc1234def',
          items: [file()],
          state: 'closed',
          truncated: false,
          type: 'ok',
        },
      })
    );
    expect(document.body.textContent).toContain('is closed on the host');
  });

  it('says there is no brief for a pull request that was never evaluated', () => {
    show(cockpit({ evaluation: null }));
    expect(document.body.textContent).toContain('has not been evaluated');
  });

  it('says so when the host lists no files at all', () => {
    show(withFiles([]));
    expect(document.body.textContent).toContain('lists no changed files');
  });
});

describe('the files', () => {
  const four = [
    file({ path: 'a.ts' }),
    file({ path: 'b.ts' }),
    file({ path: 'c.ts' }),
    file({ path: 'd.ts' }),
  ];
  it('opens the first few and leaves the rest closed', () => {
    show(withFiles(four));
    expect(headerOf('a\\.ts').getAttribute('aria-expanded')).toBe('true');
    expect(headerOf('c\\.ts').getAttribute('aria-expanded')).toBe('true');
    expect(headerOf('d\\.ts').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens and closes a file from its header', () => {
    show(withFiles(four));
    fireEvent.click(headerOf('d\\.ts'));
    expect(headerOf('d\\.ts').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(headerOf('d\\.ts'));
    expect(headerOf('d\\.ts').getAttribute('aria-expanded')).toBe('false');
  });

  it('says why a flagged file is to be verified', () => {
    show(withFiles([file({ flagged: true, verify: 'Check the guard.', why: 'Touches auth.' })]));
    expect(document.body.textContent).toContain('To verify: Touches auth. Check the guard.');
  });

  it('shows a file with no patch as one to open on the host, and never as viewable', () => {
    show(withFiles([file({ patch: null, patchDigest: null, path: 'logo.png' })]));
    expect(document.body.textContent).toContain('No patch to show');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows a renamed file with the name it had', () => {
    show(withFiles([file({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed' })]));
    expect(headerOf('new\\.ts').textContent).toContain('old.ts');
  });

  describe('the rail', () => {
    it('lists the files in the order given, with the size of the change', () => {
      show(withFiles(four));
      const rail = within(screen.getByRole('navigation', { name: 'Changed files' }));
      expect(rail.getAllByRole('listitem').map((li) => li.textContent?.replace(/\W/g, ''))).toEqual(
        ['ats', 'bts', 'cts', 'dts']
      );
      expect(rail.getByText(/4 files/)).toBeTruthy();
    });

    it('counts progress over the files that can be viewed', () => {
      show(
        withFiles(
          [file({ path: 'a.ts' }), file({ patch: null, patchDigest: null, path: 'logo.png' })],
          { viewed: ['a.ts'] }
        )
      );
      expect(screen.getByText('1 of 1 viewed')).toBeTruthy();
    });

    it('narrows to the files to verify, and says when none match', () => {
      show(withFiles([file({ flagged: true, path: 'a.ts' }), file({ path: 'b.ts' })]));
      fireEvent.click(screen.getByRole('button', { name: 'To verify' }));
      const rail = within(screen.getByRole('navigation', { name: 'Changed files' }));
      expect(rail.queryByText('b.ts')).toBeNull();
      expect(rail.getByText('a.ts')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /b\.ts/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Skim' }));
      expect(screen.getByText('No files match this filter.')).toBeTruthy();
    });

    it('opens a file chosen in the rail and marks it as the current one', () => {
      show(withFiles(four));
      const rail = within(screen.getByRole('navigation', { name: 'Changed files' }));
      fireEvent.click(rail.getByRole('button', { name: /d\.ts/ }));
      expect(headerOf('d\\.ts').getAttribute('aria-expanded')).toBe('true');
      expect(rail.getByRole('button', { name: /d\.ts/ }).getAttribute('aria-current')).toBe('true');
    });
  });
});

describe('the findings', () => {
  it('draws a finding under its line as plain text', () => {
    const { container } = show(
      withFindings([finding({ description: '<b>bold</b> off by one', line: 2 })])
    );
    expect(screen.getByText(/off by one/)).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(document.body.textContent).toContain('Suggested: use <=');
    expect(screen.getByText('1 finding')).toBeTruthy();
  });

  it('lists a finding with no line apart, naming the file and line', () => {
    show(withFindings([finding({ anchored: false, description: 'a stray problem', line: 40 })]));
    expect(screen.getByText('1 finding not tied to a line')).toBeTruthy();
    expect(document.body.textContent).toContain('src/a.ts:40');
  });

  it('shows hidden characters in a finding', () => {
    show(withFindings([finding({ anchored: false, description: 'evil‮text' })]));
    expect(document.body.textContent).toContain('evil⟨U+202E⟩text');
  });

  it('shows a critical finding as critical', () => {
    show(withFindings([finding({ severity: 'CRITICAL' })]));
    expect(screen.getByText('Critical')).toBeTruthy();
  });
});

describe('viewing files', () => {
  it('marks a file viewed with the digest it was shown, and collapses it', async () => {
    const spy = fetchSpy();
    show(withFiles([file({ path: 'a.ts' })]));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/pull-requests/pr-1/viewed', 'PUT')).toEqual({
        files: [{ patchDigest: DIGEST, path: 'a.ts' }],
        viewed: true,
      })
    );
    expect(headerOf('a\\.ts').getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a viewed file as ticked, and clears the mark when unticked', async () => {
    const spy = fetchSpy();
    show(withFiles([file({ path: 'a.ts' })], { viewed: ['a.ts'] }));
    const box = screen.getByRole('checkbox', { name: 'Viewed' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/pull-requests/pr-1/viewed', 'PUT')).toMatchObject({
        viewed: false,
      })
    );
  });

  it('reads the keyboard: j picks the first file, k and j move, v marks it viewed', async () => {
    const spy = fetchSpy();
    show(withFiles([file({ path: 'a.ts' }), file({ path: 'b.ts' })]));
    const rail = within(screen.getByRole('navigation', { name: 'Changed files' }));
    const current = () =>
      rail
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-current') === 'true')
        .map((b) => b.textContent);
    fireEvent.keyDown(document, { key: 'j' });
    expect(current()).toHaveLength(1);
    expect(current()[0]).toContain('a.ts');
    fireEvent.keyDown(document, { key: 'j' });
    expect(current()[0]).toContain('b.ts');
    fireEvent.keyDown(document, { key: 'k' });
    expect(current()[0]).toContain('a.ts');
    fireEvent.keyDown(document, { key: 'v' });
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/pull-requests/pr-1/viewed', 'PUT')).toMatchObject({
        files: [{ path: 'a.ts' }],
        viewed: true,
      })
    );
  });

  it('ignores the keys with a modifier held, and while typing in a field', () => {
    show(withFiles([file({ path: 'a.ts' })]));
    const rail = within(screen.getByRole('navigation', { name: 'Changed files' }));
    const selected = () =>
      rail.getAllByRole('button').some((b) => b.getAttribute('aria-current') === 'true');
    fireEvent.keyDown(document, { ctrlKey: true, key: 'j' });
    fireEvent.keyDown(document, { key: 'j', metaKey: true });
    expect(selected()).toBe(false);
    const field = document.createElement('input');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: 'j' });
    expect(selected()).toBe(false);
    field.remove();
  });

  it('does nothing on v until a file is chosen', () => {
    const spy = fetchSpy();
    show(withFiles([file({ path: 'a.ts' })]));
    fireEvent.keyDown(document, { key: 'v' });
    expect(
      spy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    ).toBe(false);
  });
});

describe('syntax colouring', () => {
  beforeEach(() => {
    syntaxFor.mockReset();
    syntaxFor.mockResolvedValue(null);
  });

  const four = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => file({ path }));
  const askedFor = () => syntaxFor.mock.calls.map(([path]) => path).sort();

  it('is worked out for the files that are open, and not for the ones that are closed', async () => {
    show(withFiles(four));
    await waitFor(() => expect(askedFor()).toEqual(['a.ts', 'b.ts', 'c.ts']));
    expect(askedFor()).not.toContain('d.ts');
  });

  it('is worked out for a file when it is opened', async () => {
    show(withFiles(four));
    await waitFor(() => expect(syntaxFor).toHaveBeenCalledTimes(3));
    fireEvent.click(
      screen
        .getAllByRole('button', { name: /d\.ts/ })
        .find((b) => b.hasAttribute('aria-expanded')) as HTMLElement
    );
    await waitFor(() => expect(askedFor()).toContain('d.ts'));
  });

  it('is not worked out again for a file that was closed and opened', async () => {
    show(withFiles([file({ path: 'a.ts' })]));
    await waitFor(() => expect(syntaxFor).toHaveBeenCalledTimes(1));
    const header = () =>
      screen
        .getAllByRole('button', { name: /a\.ts/ })
        .find((b) => b.hasAttribute('aria-expanded')) as HTMLElement;
    fireEvent.click(header());
    fireEvent.click(header());
    await waitFor(() => expect(header().getAttribute('aria-expanded')).toBe('true'));
    expect(syntaxFor).toHaveBeenCalledTimes(1);
  });

  it('is drawn when it arrives, with the text unchanged', async () => {
    // 0 is the hunk header, 1 ' keep', 2 '+added', 3 ' tail'.
    syntaxFor.mockResolvedValue(
      new Map([
        [2, [{ bold: false, dark: '#112233', italic: false, light: '#445566', text: 'added' }]],
      ])
    );
    show(withFiles([file({ path: 'a.ts' })]));
    await waitFor(() => expect(document.querySelectorAll('.syn')).toHaveLength(1));
    const el = document.querySelector('.syn') as HTMLElement;
    expect(el.textContent).toBe('added');
    expect(el.style.getPropertyValue('--syn-light')).toBe('#445566');
    expect(el.style.getPropertyValue('--syn-dark')).toBe('#112233');
    expect(document.body.textContent).toContain('+added');
  });

  it('leaves a file that cannot be coloured as plain text', async () => {
    show(withFiles([file({ path: 'photo.bin' })]));
    await waitFor(() => expect(syntaxFor).toHaveBeenCalled());
    expect(document.querySelectorAll('.syn')).toHaveLength(0);
    expect(document.body.textContent).toContain('+added');
  });
});

describe('moved code and edited words', () => {
  const BLOCK = ['function total(items) {', '  const sum = items.reduce(add, 0);', '  return sum;'];
  const patchOf = (sign: '+' | '-', lines: string[]) =>
    [`@@ -1,${lines.length} +1,${lines.length} @@`, ...lines.map((l) => `${sign}${l}`)].join('\n');

  it('flags a block removed from one file and added to another, on both', () => {
    show(
      withFiles([
        file({ patch: patchOf('-', BLOCK), path: 'a.ts' }),
        file({ patch: patchOf('+', BLOCK), path: 'b.ts' }),
      ])
    );
    expect(document.querySelectorAll('.border-info-400')).toHaveLength(6);
    expect(document.body.textContent?.match(/Moved: /g)).toHaveLength(6);
  });

  it('flags nothing when the same lines are only added', () => {
    show(withFiles([file({ patch: patchOf('+', BLOCK), path: 'b.ts' })]));
    expect(document.querySelectorAll('.border-info-400')).toHaveLength(0);
  });

  it('marks the words that changed in an edited line', () => {
    show(
      withFiles([
        file({
          patch: [
            '@@ -1,1 +1,1 @@',
            '-const total = price * count;',
            '+const total = price * quantity;',
          ].join('\n'),
        }),
      ])
    );
    expect([...document.querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
      'count',
      'quantity',
    ]);
  });
});

describe('the diff layout', () => {
  const splitGrids = () => document.querySelectorAll('.grid.grid-cols-2').length;
  const layoutButton = (name: string) =>
    within(screen.getByRole('group', { name: 'Diff layout' })).getByRole('button', { name });

  beforeEach(() => {
    installMemoryStorage();
  });
  afterEach(() => {
    clearViewport();
  });

  it('starts unified, and offers split', () => {
    mockViewport(1280);
    show(withFiles([file()]));
    expect(splitGrids()).toBe(0);
    expect(layoutButton('Unified').getAttribute('aria-pressed')).toBe('true');
    expect(layoutButton('Split').getAttribute('aria-pressed')).toBe('false');
  });

  it('draws old beside new once split is chosen, and remembers the choice', () => {
    mockViewport(1280);
    const { unmount } = show(withFiles([file()]));
    fireEvent.click(layoutButton('Split'));
    expect(splitGrids()).toBeGreaterThan(0);
    expect(layoutButton('Split').getAttribute('aria-pressed')).toBe('true');
    unmount();
    show(withFiles([file()]));
    expect(splitGrids()).toBeGreaterThan(0);
  });

  it('goes back to one column when unified is chosen again', () => {
    mockViewport(1280);
    show(withFiles([file()]));
    fireEvent.click(layoutButton('Split'));
    fireEvent.click(layoutButton('Unified'));
    expect(splitGrids()).toBe(0);
  });

  it('keeps one column, and offers no choice, on a narrow screen, whatever was chosen', () => {
    mockViewport(1280);
    const { unmount } = show(withFiles([file()]));
    fireEvent.click(layoutButton('Split'));
    unmount();
    mockViewport(480);
    show(withFiles([file()]));
    expect(splitGrids()).toBe(0);
    expect(screen.queryByRole('group', { name: 'Diff layout' })).toBeNull();
  });

  it('offers no choice when there are no files to lay out', () => {
    mockViewport(1280);
    show(withFiles([]));
    expect(screen.queryByRole('group', { name: 'Diff layout' })).toBeNull();
  });

  it('still draws a finding on an added line once the layout is split', () => {
    mockViewport(1280);
    const data = withFindings([finding({ line: 2 })]);
    show(data);
    fireEvent.click(layoutButton('Split'));
    expect(screen.getByText(/off by one in the loop/)).toBeTruthy();
  });
});

describe('since the reviewer last looked', () => {
  const earlier = {
    commits: [{ sha: 'c1c1c1c1c1', subject: 'fix the retry' }],
    fromHeadSha: 'a'.repeat(40),
    lastVisitedAt: new Date(Date.now() - 3_600_000).toISOString(),
    rewritten: false,
    totalCommits: 1,
  };
  const visitsOf = (spy: ReturnType<typeof vi.fn>) =>
    spy.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/api/v1/pull-requests/pr-1/visit') &&
        (init as RequestInit | undefined)?.method === 'POST'
    );
  const headsPosted = (spy: ReturnType<typeof vi.fn>) =>
    visitsOf(spy).map(([, init]) => {
      const sent = JSON.parse(String((init as RequestInit).body)) as { headSha: string };
      return sent.headSha;
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  /** One client for the whole test, so a redraw with new data is a refresh of the same page. */
  function mount(data: PullRequestCockpit) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (next: PullRequestCockpit) => (
      <QueryClientProvider client={qc}>
        <PullRequestReview data={next} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(data));
    return (next: PullRequestCockpit) => rerender(ui(next));
  }

  it('records the head the page shows, after it has drawn', async () => {
    const spy = fetchSpy();
    show(cockpit());
    await waitFor(() => expect(visitsOf(spy)).toHaveLength(1));
    expect(bodyOf(spy, '/api/v1/pull-requests/pr-1/visit')).toEqual({ headSha: 'abc1234def' });
  });

  it('records it once however often the page draws again', async () => {
    const spy = fetchSpy();
    const redraw = mount(cockpit());
    await waitFor(() => expect(visitsOf(spy)).toHaveLength(1));
    redraw(cockpit());
    redraw(cockpit());
    await settle();
    expect(visitsOf(spy)).toHaveLength(1);
  });

  it('records the new head when the pull request moves while the page is open', async () => {
    const spy = fetchSpy();
    const redraw = mount(cockpit());
    await waitFor(() => expect(visitsOf(spy)).toHaveLength(1));
    redraw(
      withFiles([file()], {
        files: {
          headSha: 'def5678abc',
          items: [file()],
          state: 'open',
          truncated: false,
          type: 'ok',
        },
      })
    );
    await waitFor(() => expect(visitsOf(spy)).toHaveLength(2));
    expect(headsPosted(spy)).toEqual(['abc1234def', 'def5678abc']);
  });

  it('records nothing while the host cannot say what the head is', async () => {
    const spy = fetchSpy();
    show(cockpit({ files: { reason: 'failed', type: 'unavailable' } }));
    await settle();
    expect(visitsOf(spy)).toHaveLength(0);
  });

  it('shows nothing about an earlier visit on a first look', () => {
    show(cockpit());
    expect(screen.queryByText('Since you last looked')).toBeNull();
  });

  it('says what came in since the last visit', () => {
    show(cockpit({ sinceLastVisit: earlier }));
    expect(screen.getByText('Since you last looked')).toBeTruthy();
    expect(screen.getByText(/fix the retry/)).toBeTruthy();
    expect(screen.getByText('aaaaaaa')).toBeTruthy();
  });

  it('keeps saying it when a refresh, made after the visit was recorded, comes back without it', async () => {
    const redraw = mount(cockpit({ sinceLastVisit: earlier }));
    expect(screen.getByText('Since you last looked')).toBeTruthy();
    redraw(cockpit({ sinceLastVisit: null }));
    await settle();
    expect(screen.getByText('Since you last looked')).toBeTruthy();
  });

  it('replaces it when the head moves again', () => {
    const redraw = mount(cockpit({ sinceLastVisit: earlier }));
    redraw(
      cockpit({
        sinceLastVisit: {
          ...earlier,
          commits: [{ sha: 'e3e3e3e3e3', subject: 'a later commit' }],
          fromHeadSha: 'b'.repeat(40),
        },
      })
    );
    expect(screen.getByText(/a later commit/)).toBeTruthy();
    expect(screen.queryByText(/fix the retry/)).toBeNull();
  });

  it('shows no summary while the host cannot say what the head is', () => {
    show(cockpit({ files: { reason: 'failed', type: 'unavailable' }, sinceLastVisit: earlier }));
    expect(screen.queryByText('Since you last looked')).toBeNull();
  });

  it('marks a file whose patch changed since it was viewed, in the list and on the file', () => {
    show(cockpit({ changedSinceViewed: ['src/a.ts'] }));
    // The rail's marker for screen readers, and the badge on the file's header.
    expect(screen.getAllByText('Changed since you viewed it')).toHaveLength(2);
  });

  it('marks nothing when no viewed file has changed', () => {
    show(cockpit());
    expect(screen.queryByText('Changed since you viewed it')).toBeNull();
  });

  it('stops marking a file once it is marked viewed again', () => {
    const redraw = mount(cockpit({ changedSinceViewed: ['src/a.ts'] }));
    expect(screen.getAllByText('Changed since you viewed it')).toHaveLength(2);
    redraw(cockpit({ changedSinceViewed: ['src/a.ts'], viewed: ['src/a.ts'] }));
    expect(screen.queryByText('Changed since you viewed it')).toBeNull();
  });
});

describe('commenting on a line from the page', () => {
  const canWrite = {
    approvalMayNotCount: false,
    available: true,
    feedbackLoopEnabled: true,
    reason: null,
  };
  const draft = (over: Record<string, unknown> = {}) => ({
    body: 'use <=',
    createdAt: '2026-11-04T10:00:00.000Z',
    headSha: 'abc1234def',
    id: 'd-1',
    line: 2,
    outdated: false,
    path: 'src/a.ts',
    ...over,
  });
  const commentButtons = () => screen.queryAllByRole('button', { name: /^Comment on line/ });
  const draftsUrl = '/api/v1/pull-requests/pr-1/drafts';

  function gateway(extra: Record<string, (body?: unknown) => unknown> = {}) {
    return setupFetchMock({
      'POST /api/v1/pull-requests/pr-1/visit': () => ({ data: { recorded: true } }),
      [`POST ${draftsUrl}`]: () => ({ data: draft({ outdated: undefined }) }),
      ...extra,
    });
  }

  it('offers no comment on a line without a token of the reviewer’s own', () => {
    gateway();
    show(cockpit());
    expect(commentButtons()).toHaveLength(0);
  });

  it('offers a comment on each added and unchanged line when the reviewer can write', () => {
    gateway();
    show(cockpit({ write: canWrite }));
    expect(commentButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Comment on line 1',
      'Comment on line 2',
      'Comment on line 3',
    ]);
  });

  it('offers none once the pull request is no longer open', () => {
    gateway();
    show(
      cockpit({
        files: {
          headSha: 'abc1234def',
          items: [file()],
          state: 'closed',
          truncated: false,
          type: 'ok',
        },
        write: canWrite,
      })
    );
    expect(commentButtons()).toHaveLength(0);
  });

  it('opens a box under the line, and closes it again on cancel without sending anything', () => {
    const spy = gateway();
    show(cockpit({ write: canWrite }));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    expect(screen.getByRole('textbox', { name: 'Comment on line 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Comment on line 2' })).toBeNull();
    expect(
      spy.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/drafts') && (init as RequestInit | undefined)?.method === 'POST'
      )
    ).toBe(false);
  });

  it('keeps what was written as a draft on this file and line, at the head the page showed', async () => {
    const spy = gateway();
    show(cockpit({ write: canWrite }));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on line 2' }), {
      target: { value: 'use <=' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(bodyOf(spy, draftsUrl)).toEqual({
        body: 'use <=',
        headSha: 'abc1234def',
        line: 2,
        patchDigest: DIGEST,
        path: 'src/a.ts',
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Comment on line 2' })).toBeNull()
    );
  });

  it('cannot save an empty comment', () => {
    gateway();
    show(cockpit({ write: canWrite }));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on line 2' }), {
      target: { value: '   ' },
    });
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('shows the gateway’s reason and keeps the box open when the comment is refused', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/pull-requests/pr-1/visit': () => ({ data: { recorded: true } }),
    });
    spy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('/drafts')
        ? new Response(
            JSON.stringify({
              error: { code: 'REVIEW_TEXT_REFUSED', message: 'Write something first.' },
            }),
            { headers: { 'content-type': 'application/json' }, status: 400 }
          )
        : new Response(JSON.stringify({ data: { recorded: true } }), {
            headers: { 'content-type': 'application/json' },
          })
    );
    show(cockpit({ write: canWrite }));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on line 2' }), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Write something first.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Comment on line 2' })).toBeTruthy();
  });

  it('draws a saved draft under its line, as text', () => {
    gateway();
    show(cockpit({ drafts: [draft({ body: '<img src=x onerror=alert(1)>' })], write: canWrite }));
    expect(screen.getByText('Draft comment')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });

  it('draws the draft beside a finding on the same line', () => {
    gateway();
    const withNote = withFindings([finding({ line: 2 })]);
    show({ ...withNote, drafts: [draft()], write: canWrite });
    expect(screen.getByText(/off by one in the loop/)).toBeTruthy();
    expect(screen.getByText('Draft comment')).toBeTruthy();
  });

  it('does not draw a draft on a file that is not in the change', () => {
    gateway();
    show(cockpit({ drafts: [draft({ path: 'src/gone.ts' })], write: canWrite }));
    expect(screen.queryByText('Draft comment')).toBeNull();
  });

  it('draws an outdated draft in the review panel and not under a line', () => {
    gateway();
    show(cockpit({ drafts: [draft({ outdated: true })], write: canWrite }));
    expect(screen.getAllByText('Draft comment')).toHaveLength(1);
    expect(screen.getByText('Some drafts no longer fit the diff')).toBeTruthy();
    expect(screen.getByText('src/a.ts:2')).toBeTruthy();
  });

  it('changes a draft in place', async () => {
    const spy = gateway({
      [`PATCH ${draftsUrl}/d-1`]: () => ({ data: draft({ body: 'better', outdated: undefined }) }),
    });
    show(cockpit({ drafts: [draft()], write: canWrite }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Draft comment on line 2' });
    expect((box as HTMLTextAreaElement).value).toBe('use <=');
    fireEvent.change(box, { target: { value: 'better' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(bodyOf(spy, `${draftsUrl}/d-1`, 'PATCH')).toEqual({ body: 'better' })
    );
  });

  it('discards a draft', async () => {
    const spy = gateway({ [`DELETE ${draftsUrl}/d-1`]: () => ({ data: { deleted: true } }) });
    show(cockpit({ drafts: [draft()], write: canWrite }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/drafts/d-1') &&
            (init as RequestInit | undefined)?.method === 'DELETE'
        )
      ).toBe(true)
    );
  });

  it('keeps the other drafts and files as they were while one is being written', () => {
    gateway();
    show({
      ...withFiles([file(), file({ path: 'src/b.ts' })]),
      drafts: [draft()],
      write: canWrite,
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Comment on line 2' })[1] as HTMLElement);
    expect(screen.getAllByText('Draft comment')).toHaveLength(1);
    expect(screen.getAllByRole('textbox', { name: 'Comment on line 2' })).toHaveLength(1);
  });
});
