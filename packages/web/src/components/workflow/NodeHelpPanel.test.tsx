// @vitest-environment jsdom

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeHelp } from '@/lib/nodeHelp';
import { NodeHelpPanel } from './NodeHelpPanel';
import { NodeInspector } from './NodeInspector';

afterEach(cleanup);

describe('NodeHelpPanel', () => {
  it('is collapsed by default, with a plain-text summary and nothing interactive in it', () => {
    const { container } = render(<NodeHelpPanel type="cond" />);
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary') as HTMLElement;
    expect(summary.textContent).toContain('About Condition nodes');
    expect(summary.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull();
  });

  it('shows what / when / watch out, the example and a docs link in its body', () => {
    const { container } = render(<NodeHelpPanel type="signal" />);
    const help = nodeHelp('signal');
    const text = container.textContent ?? '';
    expect(text).toContain(help.what);
    expect(text).toContain(help.when);
    expect(text).toContain(help.gotcha);
    expect(container.querySelector('pre')?.textContent).toContain('"type": "signal"');
    const link = screen.getByText(/Read more about signal nodes/i).closest('a');
    expect(link?.getAttribute('href')).toBe('/docs/architecture#node-types');
    expect(link?.closest('summary')).toBeNull();
  });

  it('re-collapses and re-labels when another node type is selected', () => {
    const { container, rerender } = render(<NodeHelpPanel type="cond" />);
    (container.querySelector('details') as HTMLDetailsElement).open = true;
    rerender(<NodeHelpPanel type="shell" />);
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('About Shell nodes');
  });

  it('appears first in the inspector for the selected node, and not when nothing is selected', () => {
    const node: SpecNode = { next: 'a', step: 'runTests', type: 'step' };
    const props = {
      allNodeIds: ['x', 'a'],
      isEntry: false,
      onChangeNode: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn(),
      stepMeta: undefined,
      stepRegistry: [],
    };
    const { rerender } = render(<NodeInspector {...props} node={node} nodeId="x" />);
    expect(screen.getByText('About Step nodes')).toBeTruthy();
    rerender(<NodeInspector {...props} node={null} nodeId={null} />);
    expect(screen.queryByText(/About .* nodes/)).toBeNull();
  });
});
