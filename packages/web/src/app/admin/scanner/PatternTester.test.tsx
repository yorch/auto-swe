// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

import {
  MAX_TEST_SAMPLE_LENGTH,
  MAX_TEST_SAMPLES,
  PatternTester,
  SAMPLE_HINT,
  sampleEntries,
} from './PatternTester';

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
const field = (n: number) => screen.getByLabelText(`Sample ${n}`) as HTMLTextAreaElement;
const type = (n: number, value: string) => fireEvent.change(field(n), { target: { value } });
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add sample' }));
const remove = (n: number) =>
  fireEvent.click(screen.getByRole('button', { name: `Remove sample ${n}` }));
const testButton = () => screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement;

describe('sampleEntries', () => {
  it('drops blank fields but keeps field numbers and the text untouched', () => {
    expect(sampleEntries([{ text: 'a\n b ' }, { text: '  \n' }, { text: 'c' }])).toEqual([
      { number: 1, text: 'a\n b ' },
      { number: 3, text: 'c' },
    ]);
  });
});

describe('limits', () => {
  it('pins the request bounds the gateway enforces', () => {
    expect(MAX_TEST_SAMPLES).toBe(10);
    expect(MAX_TEST_SAMPLE_LENGTH).toBe(20_000);
  });
});

describe('PatternTester', () => {
  it('is collapsed until opened, and exposes that state', () => {
    render(<PatternTester flags="" idPrefix="t" pattern="x" type="INJECTION" />);
    const toggle = screen.getByRole('button', { name: 'Try this pattern' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Sample 1')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(field(1)).toBeTruthy();
  });

  it('says it saves nothing and that samples go to the gateway', () => {
    open();
    expect(screen.getByText(/Nothing is saved/)).toBeTruthy();
    expect(screen.getByText(/sent to the gateway/)).toBeTruthy();
  });

  it('explains what the m and s flags do on a multi-line sample', () => {
    open();
    const note = screen.getByText(/A sample may span several lines/);
    expect(note.textContent).toMatch(/m.*flag.*match at each line/);
    expect(note.textContent).toMatch(/s.*the dot crosses a line break/);
  });

  describe('hints', () => {
    it.each(Object.entries(SAMPLE_HINT))('shows the %s hint', (t, hint) => {
      open({ type: t as keyof typeof SAMPLE_HINT });
      expect(
        screen.getByText(new RegExp(hint.slice(0, 40).replace(/[.()+]/g, '\\$&')))
      ).toBeTruthy();
    });

    it('no hint still claims each line is its own sample', () => {
      for (const hint of Object.values(SAMPLE_HINT)) {
        expect(hint).not.toMatch(/each line (here )?(stands|is tested)/i);
      }
    });

    it('says a CODE_SECURITY diff is scanned one added line at a time', () => {
      expect(SAMPLE_HINT.CODE_SECURITY).toMatch(/each added line of a diff on its own/);
    });

    it('describes the shell scanner windows and collapsed spelling', () => {
      expect(SAMPLE_HINT.SHELL_COMMAND).toMatch(/whitespace-collapsed, continuation-joined/);
    });
  });

  describe('adding and removing samples', () => {
    it('starts with one sample and Remove disabled', () => {
      open();
      expect(field(1)).toBeTruthy();
      expect(screen.queryByLabelText('Sample 2')).toBeNull();
      expect(
        (screen.getByRole('button', { name: 'Remove sample 1' }) as HTMLButtonElement).disabled
      ).toBe(true);
    });

    it('adds a labelled sample, enables Remove and focuses the new field', () => {
      open();
      add();
      expect(field(2)).toBeTruthy();
      expect(document.activeElement).toBe(field(2));
      expect(
        (screen.getByRole('button', { name: 'Remove sample 1' }) as HTMLButtonElement).disabled
      ).toBe(false);
    });

    it('stops at the server maximum with a disabled button and a message', () => {
      open();
      for (let i = 1; i < MAX_TEST_SAMPLES; i++) {
        add();
      }
      expect(screen.getByLabelText(`Sample ${MAX_TEST_SAMPLES}`)).toBeTruthy();
      const addButton = screen.getByRole('button', { name: 'Add sample' }) as HTMLButtonElement;
      expect(addButton.disabled).toBe(true);
      expect(screen.getByText(/10 samples is the most/)).toBeTruthy();
      expect(addButton.getAttribute('aria-describedby')).toBe(
        screen.getByText(/10 samples is the most/).id
      );
      fireEvent.click(addButton);
      expect(screen.queryByLabelText(`Sample ${MAX_TEST_SAMPLES + 1}`)).toBeNull();
    });

    it('does not show the maximum message below the limit, and re-enables Add after a removal', () => {
      open();
      expect(screen.queryByText(/is the most/)).toBeNull();
      for (let i = 1; i < MAX_TEST_SAMPLES; i++) {
        add();
      }
      remove(3);
      expect(
        (screen.getByRole('button', { name: 'Add sample' }) as HTMLButtonElement).disabled
      ).toBe(false);
      expect(screen.queryByText(/is the most/)).toBeNull();
    });

    it('removing a middle sample focuses the field that takes its place', () => {
      open();
      add();
      add();
      type(1, 'one');
      type(2, 'two');
      type(3, 'three');
      remove(2);
      expect(field(2).value).toBe('three');
      expect(document.activeElement).toBe(field(2));
      expect(screen.queryByLabelText('Sample 3')).toBeNull();
    });

    it('removing the last sample focuses the previous one', () => {
      open();
      add();
      type(1, 'one');
      type(2, 'two');
      remove(2);
      expect(field(1).value).toBe('one');
      expect(document.activeElement).toBe(field(1));
    });

    it('removing the first of two focuses the remaining field, never the body', () => {
      open();
      add();
      type(2, 'two');
      remove(1);
      expect(field(1).value).toBe('two');
      expect(document.activeElement).toBe(field(1));
      expect(document.activeElement).not.toBe(document.body);
    });

    it('keeps each sample text with its own field through add and remove', () => {
      open();
      add();
      add();
      type(1, 'a');
      type(2, 'b');
      type(3, 'c');
      remove(1);
      expect([field(1).value, field(2).value]).toEqual(['b', 'c']);
    });
  });

  describe('limits', () => {
    it('shows a per-sample character count', () => {
      open();
      type(1, 'abc');
      expect(screen.getByText('3 of 20,000 characters.')).toBeTruthy();
    });

    it('flags an over-long sample on its field, warns, and blocks the call', () => {
      open();
      add();
      type(1, 'ok');
      type(2, 'x'.repeat(MAX_TEST_SAMPLE_LENGTH + 5));
      expect(screen.getByText('5 characters over the 20,000 character limit.')).toBeTruthy();
      expect(field(2).getAttribute('aria-invalid')).toBe('true');
      expect(field(1).getAttribute('aria-invalid')).toBeNull();
      expect(screen.getByText('Each sample can be at most 20,000 characters.')).toBeTruthy();
      expect(testButton().disabled).toBe(true);
    });

    it('accepts a sample of exactly the maximum length', () => {
      open();
      type(1, 'x'.repeat(MAX_TEST_SAMPLE_LENGTH));
      expect(screen.queryByText(/characters over/)).toBeNull();
      expect(testButton().disabled).toBe(false);
    });
  });

  describe('running', () => {
    it('keeps Test disabled with no samples, whitespace only, or no pattern', () => {
      open();
      expect(testButton().disabled).toBe(true);
      type(1, '   \n\n');
      expect(testButton().disabled).toBe(true);
      cleanup();
      open({ pattern: '' });
      type(1, 'rm -rf /');
      expect(testButton().disabled).toBe(true);
      expect(screen.getByText('Enter a pattern to test it.')).toBeTruthy();
    });

    it('sends a multi-line sample intact as one entry, with the pattern and flags', () => {
      open({ flags: 'ms', pattern: '^b.c$' });
      const payload = 'a\nb\nc\n  indented \n';
      type(1, payload);
      fireEvent.click(testButton());
      expect(state.mutate).toHaveBeenCalledTimes(1);
      expect(state.mutate).toHaveBeenCalledWith({
        flags: 'ms',
        pattern: '^b.c$',
        samples: [payload],
      });
    });

    it('sends samples in field order and skips blank ones', () => {
      open();
      add();
      add();
      type(1, 'rm -rf /');
      type(3, 'ls\nrm -rf x');
      fireEvent.click(testButton());
      expect(state.mutate).toHaveBeenCalledWith({
        flags: 'i',
        pattern: 'rm\\s+-rf',
        samples: ['rm -rf /', 'ls\nrm -rf x'],
      });
    });
  });

  describe('results', () => {
    const result = (index: number, status: string, extra: Record<string, unknown> = {}) => ({
      index,
      match: null,
      matched: status === 'matched',
      status,
      ...extra,
    });

    it('shows every status with its sample number and preview', () => {
      state.mutation = {
        data: {
          budgetMs: 250,
          results: [
            result(0, 'matched', { match: { excerpt: 'rm -rf', length: 6, truncated: false } }),
            result(1, 'no_match'),
            result(2, 'timed_out'),
            result(3, 'error'),
            result(4, 'not_run'),
          ],
        },
      };
      open();
      for (let i = 1; i < 5; i++) {
        add();
      }
      ['rm -rf /', 'ls', 'slow', 'fault', 'skipped'].forEach((t, i) => {
        type(i + 1, t);
      });
      fireEvent.click(testButton());
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
      expect(
        within(screen.getAllByRole('listitem')[4] as HTMLElement).getByText('Sample 5')
      ).toBeTruthy();
      expect(screen.getByText('skipped', { selector: 'code' })).toBeTruthy();
    });

    it('maps results to the right sample after a blank field is skipped', () => {
      state.mutation = {
        data: {
          budgetMs: 250,
          results: [result(0, 'no_match'), result(1, 'timed_out')],
        },
      };
      open();
      add();
      add();
      type(1, 'first');
      type(3, 'third');
      fireEvent.click(testButton());
      const items = screen.getAllByRole('listitem');
      expect(within(items[0] as HTMLElement).getByText('Sample 1')).toBeTruthy();
      expect(within(items[0] as HTMLElement).getByText('first')).toBeTruthy();
      expect(within(items[1] as HTMLElement).getByText('Sample 3')).toBeTruthy();
      expect(within(items[1] as HTMLElement).getByText('third')).toBeTruthy();
    });

    it('drops results when a field is removed, since the remaining samples are renumbered', () => {
      state.mutation = {
        data: { budgetMs: 250, results: [result(0, 'no_match'), result(1, 'timed_out')] },
      };
      open();
      add();
      type(1, 'alpha');
      type(2, 'beta');
      fireEvent.click(testButton());
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      state.reset.mockClear();
      remove(1);
      expect(state.reset).toHaveBeenCalled();
      expect(screen.queryAllByRole('listitem')).toHaveLength(0);
      expect(screen.queryByText('Sample 2', { selector: 'span' })).toBeNull();
      expect(screen.queryByText(/Time limit per sample/)).toBeNull();
    });

    it('drops results when a field is added, and shows new ones after the next run', () => {
      state.mutation = { data: { budgetMs: 250, results: [result(0, 'no_match')] } };
      open();
      type(1, 'alpha');
      fireEvent.click(testButton());
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
      add();
      expect(screen.queryAllByRole('listitem')).toHaveLength(0);
      fireEvent.click(testButton());
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    it('previews the first line of a multi-line sample and says how many more follow', () => {
      state.mutation = { data: { budgetMs: 250, results: [result(0, 'no_match')] } };
      open();
      type(1, 'line one\nline two\nline three');
      fireEvent.click(testButton());
      expect(screen.getByText('line one (+2 more lines)')).toBeTruthy();
    });

    it('does not count a leading blank line as one of the more lines', () => {
      state.mutation = { data: { budgetMs: 250, results: [result(0, 'no_match')] } };
      open();
      type(1, '\nline one\nline two');
      fireEvent.click(testButton());
      expect(screen.getByText('line one (+1 more line)')).toBeTruthy();
    });

    it('announces a summary in a polite live region that exists before results', () => {
      const { container } = open();
      const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
      expect(live).toBeTruthy();
      expect(live.textContent).toBe('');
      cleanup();
      state.mutation = {
        data: {
          budgetMs: 250,
          results: [
            result(0, 'matched', { match: { excerpt: 'x', length: 1, truncated: false } }),
            result(1, 'no_match'),
            result(2, 'timed_out'),
          ],
        },
      };
      const second = open();
      type(1, 'x');
      fireEvent.click(testButton());
      expect(
        (second.container.querySelector('[aria-live="polite"]') as HTMLElement).textContent
      ).toBe(
        '3 samples tested: 1 matched, 1 no match, 1 not evaluated (timed out, failed or skipped).'
      );
    });

    it('flags a shortened excerpt and an empty match', () => {
      state.mutation = {
        data: {
          budgetMs: 250,
          results: [
            result(0, 'matched', { match: { excerpt: 'aaa', length: 5000, truncated: true } }),
            result(1, 'matched', { match: { excerpt: '', length: 0, truncated: false } }),
          ],
        },
      };
      open();
      add();
      type(1, 'a');
      type(2, 'b');
      fireEvent.click(testButton());
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
      type(1, 'x');
      expect((screen.getByRole('button', { name: 'Testing…' }) as HTMLButtonElement).disabled).toBe(
        true
      );
    });
  });

  it('clears earlier results when the pattern changes', () => {
    const { rerender } = open();
    state.reset.mockClear();
    rerender(<PatternTester flags="i" idPrefix="t" pattern="other" type="SHELL_COMMAND" />);
    expect(state.reset).toHaveBeenCalled();
  });
});
