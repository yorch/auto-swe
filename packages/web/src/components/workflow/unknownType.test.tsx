// @vitest-environment jsdom

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidateWorkflowResult } from '@/hooks/useValidateWorkflow';
import { handlePortsFor } from './dagNode';
import { isKnownNodeType, nodeTypeLabel, nodeTypeTone } from './nodeTypeTone';
import { specToFlow } from './specToFlow';
import { TemplateEditor } from './TemplateEditor';

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

const validate = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useValidateWorkflow', () => ({
  useValidateWorkflow: () => ({ mutateAsync: validate }),
}));
const CLEAN: ValidateWorkflowResult = { issues: [], ok: true };
beforeEach(() => {
  validate.mockReset();
  validate.mockResolvedValue(CLEAN);
});

const mk = (bad: Record<string, unknown>) =>
  ({
    entry: 'a',
    name: 'x',
    nodes: { a: bad, end: { status: 'SUCCESS', type: 'terminate' } },
    schemaVersion: 1,
  }) as unknown as WorkflowSpec;

const BOGUS = mk({ next: 'end', type: 'bogus' });
const NO_TYPE = mk({ next: 'end' });

function renderEditor(spec: WorkflowSpec, selectedNodeId: string | null = null) {
  const props = {
    onChange: vi.fn(),
    onSelect: vi.fn(),
    selectedNodeId,
    spec,
    stepRegistry: [],
  };
  return { ...render(<TemplateEditor {...props} />), props };
}

describe('the type tables', () => {
  it('recognises exactly the known types, and nothing inherited from Object', () => {
    expect(isKnownNodeType('step')).toBe(true);
    expect(isKnownNodeType('bogus')).toBe(false);
    expect(isKnownNodeType(undefined)).toBe(false);
    expect(isKnownNodeType('constructor')).toBe(false);
    expect(isKnownNodeType('toString')).toBe(false);
  });

  it('labels and tones an unknown type without throwing', () => {
    expect(nodeTypeLabel('step')).toBe('Step');
    expect(nodeTypeLabel('bogus')).toBe('Unknown type "bogus"');
    expect(nodeTypeLabel(undefined)).toBe('Unknown type');
    expect(nodeTypeTone('bogus').border).toBe('border-l-danger-400');
    expect(nodeTypeTone('step').border).toBe('border-l-accent-400');
  });
});

describe.each([
  ['an unknown type', BOGUS],
  ['a missing type', NO_TYPE],
])('a node with %s', (_name, spec) => {
  it('is a leaf with no ports, and specToFlow still lays the graph out', () => {
    const node = spec.nodes.a as WorkflowSpec['nodes'][string];
    expect(handlePortsFor(node)).toEqual([]);
    const { nodes } = specToFlow(spec);
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'end']);
    expect(nodes.find((n) => n.id === 'a')?.ariaLabel).toMatch(/^unknown type node a/);
  });

  it('renders the editor instead of throwing', () => {
    expect(() => renderEditor(spec)).not.toThrow();
  });

  it('marks the node on the canvas as unknown', () => {
    renderEditor(spec);
    const card = document.querySelector('[data-id="a"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('Unknown')).toBeTruthy();
    expect(card.textContent).toMatch(/Unknown type/);
  });

  it('lists the problem in the issues panel, on the node, and selects it when clicked', () => {
    const { props } = renderEditor(spec);
    const item = screen.getByRole('button', { name: /has (unknown type|no type)/ });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    expect(props.onSelect).toHaveBeenCalledWith('a');
  });

  it('shows an error inspector with no fields when the node is selected', () => {
    renderEditor(spec, 'a');
    const inspector = screen.getByRole('complementary', { name: 'Node inspector' });
    expect(within(inspector).getByRole('heading', { name: 'Unknown node type' })).toBeTruthy();
    expect(within(inspector).getByText(/does not know this type/)).toBeTruthy();
    // A static callout: not a live region, so selecting the node announces nothing.
    const callout = within(inspector)
      .getByText(/does not know this type/)
      .closest('[role]');
    expect(callout?.getAttribute('role')).toBe('note');
    expect(within(inspector).queryByRole('alert')).toBeNull();
    expect(within(inspector).queryByText('Configuration')).toBeNull();
    expect(within(inspector).queryByText('Details')).toBeNull();
    // It can still be deleted, and its raw JSON is there to read.
    expect(within(inspector).getByRole('button', { name: 'Delete node a' })).toBeTruthy();
    expect(within(inspector).getByText('Raw JSON')).toBeTruthy();
  });

  it('never reports "No problems found" from Check workflow, even when the server is clean', async () => {
    renderEditor(spec);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check workflow' }));
    });
    const status = screen.getByRole('status').textContent ?? '';
    expect(status).not.toMatch(/no problems/i);
    expect(status).toMatch(/[1-9]\d* errors?/);
  });
});

describe('a known spec', () => {
  it('still gets its ports, its help and its configuration', () => {
    const spec = {
      entry: 's',
      name: 'x',
      nodes: {
        end: { status: 'SUCCESS', type: 'terminate' },
        s: { next: 'end', step: 'build', type: 'step' },
      },
      schemaVersion: 1,
    } as unknown as WorkflowSpec;
    renderEditor(spec, 's');
    const inspector = screen.getByRole('complementary', { name: 'Node inspector' });
    expect(within(inspector).getByText('Configuration')).toBeTruthy();
    expect(within(inspector).getByText(/About Step nodes/)).toBeTruthy();
    expect(within(inspector).queryByText(/does not know this type/)).toBeNull();
  });
});
