// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFilePatch } from '@/components/approvals/diffParse';
import type { LineSyntax } from '@/lib/diffSyntax';
import { syntaxForDiff } from '@/lib/diffSyntax';
import { useSyntax } from './useSyntax';

vi.mock('@/lib/diffSyntax', () => ({ syntaxForDiff: vi.fn() }));
const syntaxFor = vi.mocked(syntaxForDiff);

const linesOf = (text: string) => parseFilePatch(['@@ -1 +1 @@', `+${text}`].join('\n')).lines;
const token = (text: string) => ({ bold: false, dark: '#fff', italic: false, light: '#000', text });
const syntax = (text: string): LineSyntax => new Map([[1, [token(text)]]]);

beforeEach(() => {
  syntaxFor.mockReset();
});
afterEach(cleanup);

describe('useSyntax', () => {
  it('works out and loads nothing while the file is not open', () => {
    const lines = linesOf('a');
    const { result } = renderHook(() => useSyntax('a.ts', lines, false));
    expect(result.current).toBeNull();
    expect(syntaxFor).not.toHaveBeenCalled();
  });

  it('is null until the colours arrive, then gives them', async () => {
    const lines = linesOf('a');
    const colours = syntax('a');
    syntaxFor.mockResolvedValue(colours);
    const { result } = renderHook(() => useSyntax('a.ts', lines, true));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(colours));
    expect(syntaxFor).toHaveBeenCalledWith('a.ts', lines);
  });

  it('starts when the file is opened, not before', async () => {
    const lines = linesOf('a');
    syntaxFor.mockResolvedValue(syntax('a'));
    const { result, rerender } = renderHook(({ open }) => useSyntax('a.ts', lines, open), {
      initialProps: { open: false },
    });
    expect(syntaxFor).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(syntaxFor).toHaveBeenCalledTimes(1);
  });

  it('keeps the colours while the file is closed and opened again, without working them out twice', async () => {
    const lines = linesOf('a');
    const colours = syntax('a');
    syntaxFor.mockResolvedValue(colours);
    const { result, rerender } = renderHook(({ open }) => useSyntax('a.ts', lines, open), {
      initialProps: { open: true },
    });
    await waitFor(() => expect(result.current).toBe(colours));
    rerender({ open: false });
    expect(result.current).toBe(colours);
    rerender({ open: true });
    expect(result.current).toBe(colours);
    expect(syntaxFor).toHaveBeenCalledTimes(1);
  });

  it('works the colours out again for new lines, and never gives the old ones for them', async () => {
    const first = linesOf('first');
    const second = linesOf('second');
    const firstColours = syntax('first');
    const secondColours = syntax('second');
    syntaxFor.mockResolvedValueOnce(firstColours).mockResolvedValueOnce(secondColours);
    const { result, rerender } = renderHook(({ lines }) => useSyntax('a.ts', lines, true), {
      initialProps: { lines: first },
    });
    await waitFor(() => expect(result.current).toBe(firstColours));
    rerender({ lines: second });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(secondColours));
  });

  it('discards a result that arrives after the lines have changed', async () => {
    const first = linesOf('first');
    const second = linesOf('second');
    let release: (value: LineSyntax) => void = () => undefined;
    syntaxFor.mockImplementationOnce(
      () =>
        new Promise<LineSyntax>((resolve) => {
          release = resolve;
        })
    );
    const secondColours = syntax('second');
    syntaxFor.mockResolvedValueOnce(secondColours);
    const { result, rerender } = renderHook(({ lines }) => useSyntax('a.ts', lines, true), {
      initialProps: { lines: first },
    });
    rerender({ lines: second });
    await waitFor(() => expect(result.current).toBe(secondColours));
    await act(async () => {
      release(syntax('first'));
    });
    expect(result.current).toBe(secondColours);
  });

  it('is null for a file that cannot be coloured, and does not ask again', async () => {
    const lines = linesOf('a');
    syntaxFor.mockResolvedValue(null);
    const { result, rerender } = renderHook(() => useSyntax('a.png', lines, true));
    await waitFor(() => expect(syntaxFor).toHaveBeenCalledTimes(1));
    rerender();
    expect(result.current).toBeNull();
    expect(syntaxFor).toHaveBeenCalledTimes(1);
  });

  it('is null, and does not throw, when working the colours out fails', async () => {
    const lines = linesOf('a');
    syntaxFor.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useSyntax('a.ts', lines, true));
    await waitFor(() => expect(syntaxFor).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(result.current).toBeNull();
  });
});
