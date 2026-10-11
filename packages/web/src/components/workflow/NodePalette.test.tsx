// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodePalette } from './NodePalette';

afterEach(cleanup);

describe('NodePalette help', () => {
  it('shows a worked example for cond and signal, and explains what a node is', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    expect(screen.getByText('e.g. nodes.review.output.approved == true')).toBeTruthy();
    expect(screen.getByText('e.g. name humanMergeSignal, timeout 7d')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What is a node?' })).toBeTruthy();
  });
});
