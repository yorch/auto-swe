// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('NodePalette per-type help', () => {
  it('gives every node type its own "About" button, beside the item rather than inside it', () => {
    const { container } = render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    const items = container.querySelectorAll('[aria-roledescription="draggable palette item"]');
    // 15 node types; registered steps (none here) would add more items.
    expect(items.length).toBe(15);
    for (const item of items) {
      expect(item.querySelector('button, a, input, select')).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'About Condition nodes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About Shell nodes' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^About .* nodes$/ })).toHaveLength(15);
  });

  it('opens the explanation for the type, and still adds a node on Enter', () => {
    const onAdd = vi.fn();
    render(<NodePalette onAdd={onAdd} steps={[]} />);
    fireEvent.focus(screen.getByRole('button', { name: 'About Signal nodes' }));
    expect(screen.getByRole('dialog').textContent).toContain('Waits for a named signal');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add Signal node' }), { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith({ kind: 'primitive', nodeType: 'signal' });
  });

  it('states the real authoring rule for shell and container steps', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    expect(
      screen.getAllByText(
        /needs a platform admin, or a team admin who is also at least a platform lead/i
      )
    ).toHaveLength(2);
    expect(screen.queryByText(/team leads and admins/i)).toBeNull();
  });
});
