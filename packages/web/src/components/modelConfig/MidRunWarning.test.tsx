// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MidRunWarning } from './MidRunWarning';

afterEach(cleanup);

describe('MidRunWarning', () => {
  it('is a standing note, not a live region announced on every page load', () => {
    render(<MidRunWarning />);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('take effect on the next LLM call');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
