// @vitest-environment jsdom

import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowOutline } from './WorkflowOutline';

afterEach(cleanup);

const SPEC = parseWorkflowSpec({
  entry: 'start',
  name: 't',
  nodes: {
    approve: {
      group: 'gate',
      onApprove: 'end',
      onReject: 'end',
      onTimeout: 'end',
      timeout: '1h',
      title: 'Approve the change',
      type: 'humanApproval',
    },
    build: {
      group: 'build',
      next: 'lint',
      step: 'executeImplementation',
      title: 'Build it',
      type: 'step',
    },
    end: { status: 'SUCCESS', type: 'terminate' },
    lint: { group: 'build', next: 'approve', step: 'runLint', type: 'step' },
    start: { next: 'build', step: 'validateContext', type: 'step' },
  },
  schemaVersion: 1,
});

const rows = () => screen.getAllByRole('button').filter((b) => b.hasAttribute('data-outline-id'));
const rowFor = (id: string) =>
  rows().find((r) => r.getAttribute('data-outline-id') === id) as HTMLElement;

describe('WorkflowOutline', () => {
  it('lists the steps in flow order, titled where they have a title', () => {
    render(<WorkflowOutline spec={SPEC} />);
    expect(rows().map((r) => r.getAttribute('data-outline-id'))).toEqual([
      'start',
      'build',
      'lint',
      'approve',
      'end',
    ]);
    expect(rowFor('build').textContent).toContain('Build it');
    // The id stays visible next to a title that replaces it.
    expect(rowFor('build').textContent).toContain('build');
    expect(rowFor('approve').textContent).toContain('Approve the change');
    // Untitled: by id.
    expect(rowFor('lint').textContent).toContain('lint');
  });

  it('gathers grouped steps under a heading with a count', () => {
    render(<WorkflowOutline spec={SPEC} />);
    const heading = screen.getByRole('button', { expanded: true, name: /build/i });
    expect(heading.textContent).toContain('2');
  });

  it('selects a row on click, like clicking a node on the canvas', () => {
    const onSelect = vi.fn();
    render(<WorkflowOutline onSelect={onSelect} spec={SPEC} />);
    fireEvent.click(rowFor('lint'));
    expect(onSelect).toHaveBeenCalledWith('lint');
  });

  it('marks the selected row and keeps it as the one tab stop', () => {
    render(<WorkflowOutline selectedNodeId="lint" spec={SPEC} />);
    expect(rowFor('lint').getAttribute('aria-current')).toBe('true');
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([rowFor('lint')]);
  });

  it('falls back to the first row as the tab stop when nothing is selected', () => {
    render(<WorkflowOutline spec={SPEC} />);
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([rowFor('start')]);
  });

  it('walks with the arrow keys, selecting as it goes, and jumps with Home and End', () => {
    const onSelect = vi.fn();
    render(<WorkflowOutline onSelect={onSelect} selectedNodeId="start" spec={SPEC} />);
    rowFor('start').focus();

    fireEvent.keyDown(rowFor('start'), { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('build');
    expect(document.activeElement).toBe(rowFor('build'));

    fireEvent.keyDown(rowFor('build'), { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('end');
    expect(document.activeElement).toBe(rowFor('end'));

    fireEvent.keyDown(rowFor('end'), { key: 'ArrowUp' });
    expect(onSelect).toHaveBeenLastCalledWith('approve');

    fireEvent.keyDown(rowFor('approve'), { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('start');
  });

  it('does not walk off either end', () => {
    const onSelect = vi.fn();
    render(<WorkflowOutline onSelect={onSelect} spec={SPEC} />);
    rowFor('start').focus();
    fireEvent.keyDown(rowFor('start'), { key: 'ArrowUp' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the run status beside each step, with the attempt on a retry', () => {
    render(
      <WorkflowOutline
        spec={SPEC}
        statuses={{
          byNodeId: {
            build: { attempt: 1, status: 'PASSED' },
            lint: { attempt: 3, status: 'FAILED' },
          },
        }}
      />
    );
    expect(within(rowFor('build')).getByText('passed')).toBeTruthy();
    expect(rowFor('lint').textContent).toContain('failed');
    expect(rowFor('lint').textContent).toContain('×3');
    expect(rowFor('start').textContent).not.toMatch(/passed|failed/);
  });

  it('shows diff marks', () => {
    render(<WorkflowOutline diffMarkers={{ end: 'added', lint: 'changed' }} spec={SPEC} />);
    expect(rowFor('lint').textContent).toContain('changed');
    expect(rowFor('end').textContent).toContain('added');
  });

  it('folds a group from its heading', () => {
    render(<WorkflowOutline spec={SPEC} />);
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /build/i }));
    expect(rows().map((r) => r.getAttribute('data-outline-id'))).toEqual([
      'start',
      'approve',
      'end',
    ]);
    // A folded group's rows are skipped by the arrow keys too.
    rowFor('start').focus();
    fireEvent.keyDown(rowFor('start'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowFor('approve'));
  });

  it.each([
    ['the selected step', { selectedNodeId: 'lint' }],
    ['a failed step', { statuses: { byNodeId: { lint: { attempt: 1, status: 'FAILED' } } } }],
    ['a running step', { statuses: { byNodeId: { lint: { attempt: 1, status: 'RUNNING' } } } }],
    ['a pending step', { statuses: { byNodeId: { lint: { attempt: 1, status: 'PENDING' } } } }],
    ['a diff-marked step', { diffMarkers: { lint: 'changed' as const } }],
  ])('holds a group open when it contains %s', (_what, props) => {
    render(<WorkflowOutline spec={SPEC} {...props} />);
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /build/i }));
    expect(rowFor('lint')).toBeTruthy();
  });

  it('shows how many of a group ran when there is a run overlay', () => {
    render(
      <WorkflowOutline
        spec={SPEC}
        statuses={{ byNodeId: { build: { attempt: 1, status: 'PASSED' } } }}
      />
    );
    expect(screen.getByRole('button', { expanded: true, name: /build/i }).textContent).toContain(
      '1/2'
    );
  });

  it('says so when there is nothing to list', () => {
    render(<WorkflowOutline spec={{ ...SPEC, nodes: {} }} />);
    expect(screen.getByText(/no steps/i)).toBeTruthy();
  });
});
