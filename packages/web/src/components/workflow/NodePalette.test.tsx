// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeHelp } from '@/lib/nodeHelp';
import { NodePalette } from './NodePalette';

afterEach(cleanup);

const helpPanel = () => screen.getByTestId('palette-help');

describe('NodePalette help', () => {
  it('shows a worked example for cond and signal, and explains what a node is', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    expect(screen.getByText('e.g. nodes.review.output.approved == true')).toBeTruthy();
    expect(screen.getByText('e.g. name humanMergeSignal, timeout 7d')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What is a node?' })).toBeTruthy();
  });
});

describe('NodePalette per-type help', () => {
  it('adds no per-item help buttons: the only tab stops are the items, group toggles, one tip and the filter', () => {
    const { container } = render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    const items = container.querySelectorAll('[aria-roledescription="draggable palette item"]');
    // 15 node types; registered steps (none here) would add more items.
    expect(items.length).toBe(15);
    for (const item of items) {
      expect(item.querySelector('button, a, input, select')).toBeNull();
    }
    expect(screen.queryAllByRole('button', { name: /^About .* nodes$/ })).toHaveLength(0);
    // Every focusable control in the palette: 15 items + 4 group toggles + the header tip + filter.
    const stops = container.querySelectorAll('button, input, [tabindex="0"]');
    expect(stops.length).toBe(15 + 4 + 1 + 1);
  });

  it('describes each item with its own help text, readable by assistive tech on focus', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    const signal = screen.getByRole('button', { name: 'Add Signal node' });
    const ids = (signal.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids).toHaveLength(1);
    const text = document.getElementById(ids[0] as string)?.textContent ?? '';
    expect(text).toContain(nodeHelp('signal').what);
    expect(text).toContain('Waits for a named signal');
    // A different item points at a different description.
    const cond = screen.getByRole('button', { name: 'Add Condition node' });
    expect(cond.getAttribute('aria-describedby')).not.toBe(signal.getAttribute('aria-describedby'));
  });

  it('shows the help for the focused item in one shared panel, and clears it on blur', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    expect(helpPanel().textContent).toMatch(/Focus or hover a node/);
    const signal = screen.getByRole('button', { name: 'Add Signal node' });
    fireEvent.focus(signal);
    expect(within(helpPanel()).getByText('Signal')).toBeTruthy();
    expect(helpPanel().textContent).toContain('Waits for a named signal');
    fireEvent.focus(screen.getByRole('button', { name: 'Add Condition node' }));
    expect(helpPanel().textContent).not.toContain('Waits for a named signal');
    fireEvent.blur(screen.getByRole('button', { name: 'Add Condition node' }));
    expect(helpPanel().textContent).toMatch(/Focus or hover a node/);
  });

  it('shows help on hover too, and hover wins over focus until the pointer leaves', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    const signal = screen.getByRole('button', { name: 'Add Signal node' });
    const cond = screen.getByRole('button', { name: 'Add Condition node' });
    fireEvent.focus(signal);
    fireEvent.mouseEnter(cond);
    expect(helpPanel().textContent).toContain(nodeHelp('cond').what);
    fireEvent.mouseLeave(cond);
    expect(helpPanel().textContent).toContain('Waits for a named signal');
  });

  it('still adds a node on Enter and Space', () => {
    const onAdd = vi.fn();
    render(<NodePalette onAdd={onAdd} steps={[]} />);
    const signal = screen.getByRole('button', { name: 'Add Signal node' });
    fireEvent.keyDown(signal, { key: 'Enter' });
    fireEvent.keyDown(signal, { key: ' ' });
    fireEvent.keyDown(signal, { key: 'a' });
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd).toHaveBeenCalledWith({ kind: 'primitive', nodeType: 'signal' });
  });

  it('shows a registered step description in the panel instead of a native title', () => {
    const { container } = render(
      <NodePalette
        onAdd={vi.fn()}
        steps={[
          {
            category: 'git',
            description: 'Opens a draft pull request',
            label: 'PR',
            name: 'openPr',
          },
        ]}
      />
    );
    const step = screen.getByRole('button', { name: 'Add openPr node' });
    expect(step.getAttribute('title')).toBeNull();
    fireEvent.focus(step);
    expect(helpPanel().textContent).toContain('Opens a draft pull request');
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('states the real authoring rule for shell and container steps, without a native title', () => {
    const { container } = render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    expect(
      screen.getAllByText(
        /needs a platform admin, or a team admin who is also at least a platform lead/i
      )
    ).toHaveLength(2);
    expect(screen.queryByText(/team leads and admins/i)).toBeNull();
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
    // The note is also each elevated item's description.
    const shell = screen.getByRole('button', { name: 'Add Shell node' });
    const ids = (shell.getAttribute('aria-describedby') ?? '').split(' ');
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toMatch(/needs a platform admin/i);
  });

  it('shows the elevated note visibly in the panel when a shell item is focused, and not for others', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Add Shell node' }));
    expect(helpPanel().textContent).toMatch(/needs a platform admin/i);
    fireEvent.focus(screen.getByRole('button', { name: 'Add Condition node' }));
    expect(helpPanel().textContent).not.toMatch(/needs a platform admin/i);
  });
});

describe('NodePalette help state', () => {
  const STEPS = [
    { category: 'vcs', description: 'Opens a draft pull request', label: 'PR', name: 'openPr' },
    { category: 'vcs', description: 'Pushes the branch', label: 'Push', name: 'pushBranch' },
  ];
  const filter = () => screen.getByRole('searchbox', { name: /filter the step registry/i });

  it('lets the most recent interaction win, and falls back when it ends', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    const signal = screen.getByRole('button', { name: 'Add Signal node' });
    const cond = screen.getByRole('button', { name: 'Add Condition node' });
    fireEvent.mouseEnter(cond);
    fireEvent.focus(signal);
    expect(helpPanel().textContent).toContain('Waits for a named signal');
    fireEvent.blur(signal);
    expect(helpPanel().textContent).toContain(nodeHelp('cond').what);
    fireEvent.mouseLeave(cond);
    expect(helpPanel().textContent).toMatch(/Focus or hover a node/);
  });

  it('drops the help of a hovered step that the filter removes', () => {
    render(<NodePalette onAdd={vi.fn()} steps={STEPS} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Add openPr node' }));
    expect(helpPanel().textContent).toContain('Opens a draft pull request');
    fireEvent.change(filter(), { target: { value: 'pushBranch' } });
    expect(screen.queryByRole('button', { name: 'Add openPr node' })).toBeNull();
    expect(helpPanel().textContent).toMatch(/Focus or hover a node/);
  });

  it('keeps the help of a still-listed item when the filter changes', () => {
    render(<NodePalette onAdd={vi.fn()} steps={STEPS} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Add pushBranch node' }));
    fireEvent.change(filter(), { target: { value: 'push' } });
    expect(helpPanel().textContent).toContain('Pushes the branch');
  });

  it('drops the help of an item whose group is collapsed', () => {
    render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Add Shell node' }));
    expect(helpPanel().textContent).toMatch(/needs a platform admin/i);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(helpPanel().textContent).toMatch(/Focus or hover a node/);
  });

  it('describes an item through hidden text, so it is read once, and keeps the lock note', () => {
    const { container } = render(<NodePalette onAdd={vi.fn()} steps={[]} />);
    const start = nodeHelp('signal').what.slice(0, 20);
    // aria-describedby still resolves the hidden node...
    expect(
      screen.getByRole('button', { description: new RegExp(start), name: 'Add Signal node' })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { description: /needs a platform admin/i, name: 'Add Shell node' })
    ).toBeTruthy();
    // ...which carries the hidden attribute rather than sr-only, so it is not also read in place.
    const signal = screen.getByRole('button', { name: 'Add Signal node' });
    for (const id of (signal.getAttribute('aria-describedby') ?? '').split(' ')) {
      expect((document.getElementById(id) as HTMLElement).hidden).toBe(true);
    }
    expect(container.querySelectorAll('.sr-only')).toHaveLength(0);
  });
});
