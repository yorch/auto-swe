// @vitest-environment jsdom

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schemaIssues } from '@/lib/specSchemaIssues';
import { TemplateEditor } from './TemplateEditor';

// React Flow measures its container; jsdom has no layout engine.
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m22 = 1;
    }
  );
  window.matchMedia =
    window.matchMedia ??
    ((q: string) =>
      ({
        addEventListener() {},
        matches: true,
        media: q,
        removeEventListener() {},
      }) as unknown as MediaQueryList);
});
afterEach(cleanup);

const GOOD: WorkflowSpec = {
  description: 'good',
  entry: 'end',
  name: 'good',
  nodes: { end: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

// A cond that routes to a node that does not exist, and no terminate node: errors.
const BAD: WorkflowSpec = {
  description: 'bad',
  entry: 'c',
  name: 'bad',
  nodes: { c: { expr: 'true', onFalse: 'nowhere', onTrue: 'nowhere', type: 'cond' } },
  schemaVersion: 1,
};

function renderEditor(spec: WorkflowSpec) {
  const props = {
    onChange: vi.fn(),
    onSelect: vi.fn(),
    selectedNodeId: null,
    spec,
    stepRegistry: [],
  };
  const view = render(<TemplateEditor {...props} />);
  return { ...view, props };
}

describe('Check workflow', () => {
  it('says nothing until asked, then reports a clean result and what the check does not cover', () => {
    renderEditor(GOOD);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(status.textContent).toMatch(/^No problems found\./);
    expect(status.textContent).toMatch(/does not run the workflow/);
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('counts errors and warnings, opens the issues panel and moves focus into it', () => {
    const { container } = renderEditor(BAD);
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(screen.getByRole('status').textContent).toMatch(/^\d+ errors?, \d+ warnings?\./);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(details.querySelector('summary'));
  });

  it('hides a stale result once the spec has changed', () => {
    const { rerender, props } = renderEditor(GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(screen.getByRole('status').textContent).toMatch(/No problems found/);
    act(() => {
      rerender(<TemplateEditor {...props} spec={{ ...GOOD }} />);
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('reports a freshly dropped humanApproval node (blank title) as an error, not a clean result', () => {
    const spec: WorkflowSpec = {
      description: 'x',
      entry: 'ask',
      name: 'x',
      nodes: {
        ask: {
          onApprove: 'end',
          onReject: 'end',
          onTimeout: 'end',
          timeout: '24h',
          title: '',
          type: 'humanApproval',
        },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: 1,
    };
    expect(schemaIssues(spec).some((i) => i.nodeId === 'ask' && i.field === 'title')).toBe(true);
    const { props } = renderEditor(spec);
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(screen.getByRole('status').textContent).toMatch(/^[1-9]\d* errors?,/);
    expect(screen.getByRole('status').textContent).not.toMatch(/No problems found/);
    // The issue is click-to-select.
    fireEvent.click(screen.getByRole('button', { name: /SCHEMA\s+ask\.title/ }));
    expect(props.onSelect).toHaveBeenCalledWith('ask');
  });

  it('reports an empty agentRef as an error', () => {
    const spec: WorkflowSpec = {
      description: 'x',
      entry: 'a',
      name: 'x',
      nodes: {
        a: { agentRef: '', next: 'end', type: 'agent' },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: 1,
    };
    expect(schemaIssues(spec).some((i) => i.nodeId === 'a' && i.field === 'agentRef')).toBe(true);
    renderEditor(spec);
    fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    expect(screen.getByRole('status').textContent).not.toMatch(/No problems found/);
  });

  it('a valid spec yields no schema issues', () => {
    expect(schemaIssues(GOOD)).toEqual([]);
  });

  it('re-announces on a repeated click by replacing the status text node', () => {
    renderEditor(GOOD);
    const button = screen.getByRole('button', { name: 'Check workflow' });
    fireEvent.click(button);
    const first = screen.getByRole('status').firstElementChild;
    fireEvent.click(button);
    expect(screen.getByRole('status').firstElementChild).not.toBe(first);
  });
});
