// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutation: {} as Record<string, unknown>,
  reset: vi.fn(),
}));
vi.mock('@/hooks/useTestScannerPattern', () => ({
  useTestScannerPattern: () => ({
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate: state.mutate,
    reset: state.reset,
    ...state.mutation,
  }),
}));

import { MAX_TEST_SAMPLES, PatternTester, parseSamples, SAMPLE_HINT } from './PatternTester';

beforeEach(() => {
  state.mutation = {};
  state.mutate.mockReset();
  state.reset.mockReset();
});
afterEach(cleanup);

function open(props: Partial<React.ComponentProps<typeof PatternTester>> = {}) {
  const view = render(
    <PatternTester flags="i" idPrefix="t" pattern="rm\s+-rf" type="SHELL_COMMAND" {...props} />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try this pattern' }));
  return view;
}
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('Sample text'), { target: { value } });

describe('parseSamples', () => {
  it('keeps one sample per non-blank line', () => {
    expect(parseSamples('a\n\n  \nb c\n')).toEqual(['a', 'b c']);
  });
});

describe('PatternTester', () => {
  it('is collapsed until opened, and exposes that state', () => {
    render(<PatternTester flags="" idPrefix="t" pattern="x" type="INJECTION" />);
    const toggle = screen.getByRole('button', { name: 'Try this pattern' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Sample text')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Sample text')).toBeTruthy();
  });

  it('says it saves nothing and that samples go to the gateway', () => {
    open();
    expect(screen.getByText(/Nothing is saved/)).toBeTruthy();
    expect(screen.getByText(/sent to the gateway/)).toBeTruthy();
  });

  it.each(Object.entries(SAMPLE_HINT))(
    'words the %s hint for what that scanner reads',
    (t, hint) => {
      open({ type: t as keyof typeof SAMPLE_HINT });
      expect(screen.getByText(new RegExp(hint.replace('.', '\\.')))).toBeTruthy();
    }
  );

  it('keeps Test disabled with no samples or no pattern', () => {
    open();
    const test = screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    type('   \n\n');
    expect(test.disabled).toBe(true);
    cleanup();
    open({ pattern: '' });
    type('rm -rf /');
    expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Enter a pattern to test it.')).toBeTruthy();
  });

  it('sends the pattern, flags and non-blank lines', () => {
    open();
    type('rm -rf /\n\nls');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(state.mutate).toHaveBeenCalledWith({
      flags: 'i',
      pattern: 'rm\\s+-rf',
      samples: ['rm -rf /', 'ls'],
    });
  });

  it('refuses more samples than the gateway accepts, without calling it', () => {
    open();
    type(Array.from({ length: MAX_TEST_SAMPLES + 1 }, (_, i) => `s${i}`).join('\n'));
    expect(screen.getByText(/At most 10 samples/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an over-long sample', () => {
    open();
    type('x'.repeat(20_001));
    expect(screen.getByText(/at most 20,000 characters/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows matches with the excerpt, misses, and a timeout', () => {
    state.mutation = {
      data: {
        budgetMs: 250,
        results: [
          {
            index: 0,
            match: { excerpt: 'rm -rf', length: 6, truncated: false },
            matched: true,
            status: 'matched',
          },
          { index: 1, match: null, matched: false, status: 'no_match' },
          { index: 2, match: null, matched: false, status: 'timed_out' },
          { index: 3, match: null, matched: false, status: 'error' },
          { index: 4, match: null, matched: false, status: 'not_run' },
        ],
      },
    };
    open();
    type('rm -rf /\nls\nslow\nfault\nskipped');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByText('Matched')).toBeTruthy();
    expect(screen.getByText('rm -rf', { selector: 'mark' })).toBeTruthy();
    expect(screen.getByText('No match')).toBeTruthy();
    expect(screen.getByText('Timed out')).toBeTruthy();
    expect(screen.getByText(/ran past the time limit/)).toBeTruthy();
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText(/check failed before it could finish/)).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();
    expect(screen.getByText('Skipped: time limit for this test was reached.')).toBeTruthy();
    expect(screen.getByText(/Time limit per sample: 250 ms/)).toBeTruthy();
  });

  it('flags a shortened excerpt and an empty match', () => {
    state.mutation = {
      data: {
        budgetMs: 250,
        results: [
          {
            index: 0,
            match: { excerpt: 'aaa', length: 5000, truncated: true },
            matched: true,
            status: 'matched',
          },
          {
            index: 1,
            match: { excerpt: '', length: 0, truncated: false },
            matched: true,
            status: 'matched',
          },
        ],
      },
    };
    open();
    type('a\nb');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByText(/5000 characters, excerpt shortened/)).toBeTruthy();
    expect(screen.getByText('Matched an empty string.')).toBeTruthy();
  });

  it('shows the gateway error and a busy state', () => {
    state.mutation = { error: new Error('pattern is not valid'), isError: true };
    open();
    expect(screen.getByText('pattern is not valid')).toBeTruthy();
    cleanup();
    state.mutation = { isPending: true };
    open();
    type('x');
    expect((screen.getByRole('button', { name: 'Testing…' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('clears earlier results when the pattern changes', () => {
    const { rerender } = open();
    state.reset.mockClear();
    rerender(<PatternTester flags="i" idPrefix="t" pattern="other" type="SHELL_COMMAND" />);
    expect(state.reset).toHaveBeenCalled();
  });
});
