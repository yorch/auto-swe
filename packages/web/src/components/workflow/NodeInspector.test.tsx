// @vitest-environment jsdom

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeInspector } from './NodeInspector';

/**
 * The outgoing-edge dropdowns are addressed by spec field name, and a decision
 * option's field name is `options[i].next` — an indexed path into an array, not
 * a top-level key. The inspector used to assign it as one, which wrote a literal
 * `"options[0].next"` property onto the node and left the real routing alone:
 * the dropdown read back correctly and the save silently did nothing.
 *
 * These render the real component and pin what `onChangeNode` receives.
 */

const DECISION: SpecNode = {
  onTimeout: 'b',
  options: [
    { label: 'Ship it', next: 'a', value: 'ship' },
    { label: 'Hold', next: 'b', value: 'hold' },
  ],
  timeout: '1h',
  title: 'Pick one',
  type: 'humanDecision',
};

const STEP: SpecNode = { next: 'a', step: 'doThing', type: 'step' };

const INPUT_NODE: SpecNode = {
  fields: [{ key: 'sev', label: 'Severity', type: 'text' }],
  onSubmit: 'a',
  onTimeout: 'b',
  timeout: '1h',
  title: 'Report',
  type: 'humanInput',
};

/** Open a dropdown by its label and return the options it offers. */
function openSelect(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
  return screen.getAllByRole('option');
}

function pick(label: string, option: string) {
  openSelect(label);
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function renderInspector(node: SpecNode, nodeId: string, onChangeNode = vi.fn()) {
  render(
    // The mcp section lists connections through react-query.
    <QueryClientProvider client={new QueryClient()}>
      <NodeInspector
        allNodeIds={[nodeId, 'a', 'b']}
        isEntry={false}
        node={node}
        nodeId={nodeId}
        onChangeNode={onChangeNode}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        stepMeta={null}
        stepRegistry={[]}
      />
    </QueryClientProvider>
  );
  return onChangeNode;
}

describe('NodeInspector outgoing edges', () => {
  it('retargets a decision option in place, not as a top-level key', () => {
    const onChangeNode = renderInspector(DECISION, 'decide');

    pick('Ship it', 'b');

    expect(onChangeNode).toHaveBeenCalledTimes(1);
    const next = onChangeNode.mock.calls[0]?.[0] as SpecNode;
    expect(Object.keys(next)).not.toContain('options[0].next');
    expect(next.type === 'humanDecision' && next.options).toEqual([
      { label: 'Ship it', next: 'b', value: 'ship' },
      { label: 'Hold', next: 'b', value: 'hold' },
    ]);
  });

  it('shows an option edge as the port it belongs to, not the whole node', () => {
    renderInspector(DECISION, 'decide');

    expect(screen.getByRole('button', { name: /Ship it/i }).textContent).toContain('a');
    expect(screen.getByRole('button', { name: /Hold/i }).textContent).toContain('b');
  });

  it('offers no "none" for a schema-required edge', () => {
    // Every `humanDecision` edge is required, so clearing one is not a choice
    // the spec can represent — the dropdown must not offer it.
    for (const label of ['Ship it', 'Hold', 'On timeout']) {
      // A fresh render per dropdown, so only one list is ever open.
      cleanup();
      renderInspector(DECISION, 'decide');
      const options = openSelect(label).map((o) => o.textContent?.replace('✓', ''));
      expect(options).toEqual(['decide', 'a', 'b'].filter((id) => id !== 'decide'));
    }
  });

  it('still offers "none" for an optional edge, and clears it', () => {
    const onChangeNode = renderInspector(STEP, 'work');
    expect(openSelect('Next').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'Not connected',
      'a',
      'b',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Not connected' }));

    expect(onChangeNode).toHaveBeenCalledWith({ step: 'doThing', type: 'step' });
  });
});

/**
 * The four human nodes and `eval` had no configuration section, so the only way
 * to change them was JSON mode. In particular a `humanDecision` option and a
 * `humanInput` field could be retargeted but never added or removed, which made
 * them unusable from the canvas.
 *
 * These render the real component and pin what `onChangeNode` receives — the
 * shape matters as much as the presence, because the spec parser refuses a
 * binding that is not one of `{ from }` / `{ literal }` / `{ expr }`.
 */

function renderNode(type: SpecNode['type'], node: SpecNode) {
  const onChangeNode = renderInspector(node, type);
  const changed = () => {
    const call = onChangeNode.mock.calls.at(-1)?.[0] as SpecNode | undefined;
    if (!call) {
      throw new Error('onChangeNode was not called');
    }
    return call;
  };
  return { changed, onChangeNode };
}

describe('NodeInspector human node forms', () => {
  it('adds a decision option with a unique value and a place to go', () => {
    const { changed } = renderNode('humanDecision', DECISION);
    fireEvent.click(screen.getByRole('button', { name: /add option/i }));
    const options = (changed() as Extract<SpecNode, { type: 'humanDecision' }>).options;
    expect(options).toHaveLength(3);
    // A new option needs a `next` the schema accepts and a value that is not
    // already taken, or the parallel edge dropdowns have nothing to retarget.
    expect(options[2]).toMatchObject({ next: 'a' });
    expect(new Set(options.map((o) => o.value)).size).toBe(3);
  });

  it('removes a decision option, and refuses to go below the two the schema needs', () => {
    const THREE: SpecNode = {
      ...DECISION,
      options: [
        { label: 'Ship it', next: 'a', value: 'ship' },
        { label: 'Hold', next: 'b', value: 'hold' },
        { label: 'Ask', next: 'b', value: 'ask' },
      ],
    };
    const { changed } = renderNode('humanDecision', THREE);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option 1' }));
    const options = (changed() as Extract<SpecNode, { type: 'humanDecision' }>).options;
    expect(options.map((o) => o.value)).toEqual(['hold', 'ask']);

    // Two is the floor (`options: z.array(...).min(2)`), so the control is off
    // rather than offering a removal the save would refuse.
    cleanup();
    renderNode('humanDecision', DECISION);
    const remove = screen.getByRole('button', { name: 'Remove option 1' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });

  it('edits an option label and value in place', () => {
    const { changed } = renderNode('humanDecision', DECISION);
    fireEvent.change(screen.getByLabelText('Option 1 label'), { target: { value: 'Ship now' } });
    expect((changed() as Extract<SpecNode, { type: 'humanDecision' }>).options[0]?.label).toBe(
      'Ship now'
    );
  });

  it('adds an input field with a key that is not already taken', () => {
    const { changed } = renderNode('humanInput', INPUT_NODE);
    fireEvent.click(screen.getByRole('button', { name: /add field/i }));
    const added = (changed() as Extract<SpecNode, { type: 'humanInput' }>).fields;
    expect(added).toHaveLength(2);
    expect(added[1]?.key).not.toBe('sev');
    expect(added[1]?.type).toBe('text');
  });

  it('edits a field type, and offers choices only once it is a select', () => {
    const { changed } = renderNode('humanInput', INPUT_NODE);
    // The trigger's accessible name includes its value, so match on the label
    // part — the same reason this file's `pick` helper takes a pattern.
    pick('Field 1 type', 'Select');
    const retyped = (changed() as Extract<SpecNode, { type: 'humanInput' }>).fields[0];
    expect(retyped?.type).toBe('select');

    cleanup();
    renderNode('humanInput', {
      ...INPUT_NODE,
      fields: [{ key: 'sev', label: 'Severity', options: ['low', 'high'], type: 'select' }],
    });
    fireEvent.change(screen.getByLabelText('Field 1 options'), { target: { value: 'low, high' } });
    expect((screen.getByLabelText('Field 1 options') as HTMLInputElement).value).toBe('low, high');
  });

  it('shows a field\u2019s choices only when the field is a select', () => {
    renderNode('humanInput', INPUT_NODE);
    expect(screen.queryByLabelText('Field 1 options')).toBeNull();
  });

  it('renders a form for every node type in the union', () => {
    // The drift guard: a 16th type must not arrive with a blank rail.
    const MINIMAL: Array<[SpecNode['type'], SpecNode]> = [
      ['step', { step: 'runLint', type: 'step' }],
      ['agent', { agentRef: 'implementer', type: 'agent' }],
      ['mcp', { connectionRef: 'c1', tool: 't', type: 'mcp' }],
      [
        'eval',
        {
          scorers: [{ expr: 'true', kind: 'assert' }],
          target: { from: 'context.x' },
          type: 'eval',
        },
      ],
      ['set', { type: 'set', values: { 'context.x': { literal: 1 } } }],
      ['cond', { expr: 'true', onFalse: 'a', onTrue: 'a', type: 'cond' }],
      ['signal', { name: 's', onReceive: 'a', onTimeout: 'a', timeout: '1h', type: 'signal' }],
      ['terminate', { status: 'SUCCESS', type: 'terminate' }],
      [
        'fanOut',
        {
          itemKey: 'subtask',
          join: 'a',
          onBranchFail: 'block',
          over: { literal: [] },
          subgraph: 'a',
          type: 'fanOut',
        },
      ],
      ['shell', { command: 'true', image: 'alpine:latest', type: 'shell' }],
      ['containerStep', { image: 'alpine:latest', type: 'containerStep' }],
      [
        'humanApproval',
        {
          onApprove: 'a',
          onReject: 'a',
          onTimeout: 'a',
          timeout: '1h',
          title: 'T',
          type: 'humanApproval',
        },
      ],
      ['humanDecision', DECISION],
      [
        'humanInput',
        {
          fields: [{ key: 'k', label: 'K', type: 'text' }],
          onSubmit: 'a',
          onTimeout: 'b',
          timeout: '1h',
          title: 'T',
          type: 'humanInput',
        },
      ],
      [
        'humanReview',
        {
          contentFrom: 'context.x',
          onSubmit: 'a',
          onTimeout: 'b',
          timeout: '1h',
          title: 'T',
          type: 'humanReview',
        },
      ],
    ];
    expect(MINIMAL.map(([t]) => t)).toHaveLength(15);
    for (const [type, node] of MINIMAL) {
      const { unmount } = render(
        // The mcp section lists connections through react-query.
        <QueryClientProvider client={new QueryClient()}>
          <NodeInspector
            allNodeIds={['a', 'b']}
            isEntry={false}
            node={node}
            nodeId={type}
            onChangeNode={vi.fn()}
            onDelete={vi.fn()}
            onRename={vi.fn()}
            stepMeta={null}
            stepRegistry={[]}
          />
        </QueryClientProvider>
      );
      // A section beyond Details and the edges: the eval form's Target is the
      // clearest positive marker; the others are checked by their own tests.
      if (type === 'eval') {
        expect(screen.getByText('Target')).toBeTruthy();
      }
      unmount();
      cleanup();
    }
  });

  it('names the human node fields the worker reads', () => {
    renderNode('humanApproval', {
      onApprove: 'a',
      onReject: 'a',
      onTimeout: 'a',
      timeout: '1h',
      title: 'Approve the plan',
      type: 'humanApproval',
    });
    expect(screen.getByText('Distinct approvers')).toBeTruthy();
    expect(screen.getByText('Context to show')).toBeTruthy();
    expect(screen.getByLabelText('Timeout')).toBeTruthy();
  });
});

describe('NodeInspector binding shapes', () => {
  const STEP_WITH_INPUT: SpecNode = {
    inputs: { summary: { from: 'nodes.dryRun.output.summary' } },
    next: 'a',
    step: 'runLint',
    type: 'step',
  };

  it('switching a binding to literal wraps the text as `{ literal }`', () => {
    // Writing the bare value produced a spec `parseWorkflowSpec` refuses — a
    // record of `BindingSchema`, which is a union of `{ from }`/`{ literal }`/
    // `{ expr }` — so a literal binding could never be saved. Pinned here
    // because the editor is the only producer of these objects.
    const { changed } = renderNode('step', STEP_WITH_INPUT);
    pick('Binding type', 'Literal');
    const inputs = (changed() as Extract<SpecNode, { type: 'step' }>).inputs;
    expect(inputs?.summary).toEqual({ literal: 'nodes.dryRun.output.summary' });
  });

  it('edits the text of an existing literal', () => {
    const { changed } = renderNode('step', {
      inputs: { count: { literal: 1 } },
      next: 'a',
      step: 'runLint',
      type: 'step',
    });
    fireEvent.change(screen.getAllByLabelText('Binding value')[0] as HTMLElement, {
      target: { value: 'hello' },
    });
    const inputs = (changed() as Extract<SpecNode, { type: 'step' }>).inputs;
    expect(inputs?.count).toEqual({ literal: 'hello' });
  });

  it('adds a new binding as a valid path, not a bare string', () => {
    const { changed } = renderNode('step', { next: 'a', step: 'runLint', type: 'step' });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    const inputs = (changed() as Extract<SpecNode, { type: 'step' }>).inputs;
    expect(inputs?.input).toEqual({ from: '' });
  });

  it('edits a terminate result binding', () => {
    const { changed } = renderNode('terminate', {
      result: { pr: { from: 'context.currentCodeResult' } },
      status: 'SUCCESS',
      type: 'terminate',
    });
    expect(screen.getByText('Result')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Binding key'), { target: { value: 'pullRequest' } });
    fireEvent.blur(screen.getByLabelText('Binding key'), { target: { value: 'pullRequest' } });
    const result = (changed() as Extract<SpecNode, { type: 'terminate' }>).result;
    expect(result?.pullRequest).toEqual({ from: 'context.currentCodeResult' });
  });
});

describe('NodeInspector set node', () => {
  const VALUES = {
    a: { default: 1, from: 'ctx.x' },
    b: { literal: '5' },
    c: { expr: 'ctx.n + 1' },
    d: { literal: 'hello' },
    e: { from: 'ctx.plain' },
  };
  const SET: SpecNode = { type: 'set', values: VALUES } as SpecNode;
  const valuesOf = (node: SpecNode) => (node as Extract<SpecNode, { type: 'set' }>).values;

  it('lists one row per value, with unrepresentable bindings as JSON', () => {
    renderNode('set', SET);

    const inputValue = (el: HTMLElement) => (el as HTMLInputElement).value;
    expect(screen.getAllByLabelText('Context path').map(inputValue)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    // `a` carries a default and `b` is the string "5", which the literal field
    // would turn into a number: neither survives the form unchanged, so both are
    // shown verbatim as JSON.
    expect(JSON.parse(inputValue(screen.getByLabelText('Value for a (JSON)')))).toEqual(VALUES.a);
    expect(JSON.parse(inputValue(screen.getByLabelText('Value for b (JSON)')))).toEqual(VALUES.b);
    expect(screen.getAllByLabelText('Binding value').map(inputValue)).toEqual([
      'ctx.n + 1',
      'hello',
      'ctx.plain',
    ]);
  });

  it('edits one row and leaves every other value exactly as stored', () => {
    const { changed } = renderNode('set', SET);

    fireEvent.change(screen.getByDisplayValue('ctx.plain'), { target: { value: 'ctx.other' } });

    expect(valuesOf(changed())).toEqual({ ...VALUES, e: { from: 'ctx.other' } });
  });

  it('applies edited JSON for a row on blur, keeping row order', () => {
    const { changed } = renderNode('set', SET);
    const raw = screen.getByLabelText('Value for b (JSON)');

    fireEvent.change(raw, { target: { value: '{"literal":[1,2]}' } });
    fireEvent.blur(raw);

    expect(valuesOf(changed()).b).toEqual({ literal: [1, 2] });
    expect(Object.keys(valuesOf(changed()))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not apply invalid JSON', () => {
    const { onChangeNode } = renderNode('set', SET);
    const raw = screen.getByLabelText('Value for b (JSON)');

    fireEvent.change(raw, { target: { value: '{oops' } });
    fireEvent.blur(raw);

    expect(onChangeNode).not.toHaveBeenCalled();
  });

  it('adds an empty path row and removes a row', () => {
    const { changed } = renderNode('set', SET);

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(valuesOf(changed()).value).toEqual({ from: '' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove c' }));
    expect(Object.keys(valuesOf(changed()))).toEqual(['a', 'b', 'd', 'e']);
  });

  it('renames a row in place and refuses a duplicate key', () => {
    const { changed, onChangeNode } = renderNode('set', SET);
    const key = screen.getAllByLabelText('Context path')[1] as HTMLElement;

    fireEvent.change(key, { target: { value: 'a' } });
    fireEvent.blur(key);
    expect(onChangeNode).not.toHaveBeenCalled();

    fireEvent.change(key, { target: { value: 'renamed' } });
    fireEvent.blur(key);
    expect(Object.entries(valuesOf(changed()))[1]).toEqual(['renamed', { literal: '5' }]);
  });

  it('switches a row to an expression', () => {
    const { changed } = renderNode('set', {
      type: 'set',
      values: { x: { from: 'ctx.a' } },
    } as SpecNode);

    pick('Binding type', 'Expression');

    expect(valuesOf(changed()).x).toEqual({ expr: 'ctx.a' });
  });
});

describe('NodeInspector onError and spanName', () => {
  const NODES: [string, SpecNode][] = [
    ['step', STEP],
    ['agent', { agentRef: 'implementer', type: 'agent' } as SpecNode],
    ['mcp', { connectionRef: 'c', tool: 't', type: 'mcp' } as SpecNode],
    ['shell', { command: 'echo', image: 'node:24-alpine', type: 'shell' } as SpecNode],
    ['containerStep', { image: 'x:1', type: 'containerStep' } as SpecNode],
    [
      'eval',
      {
        scorers: [{ kind: 'pii' }],
        target: { from: 'ctx.diff' },
        type: 'eval',
      } as SpecNode,
    ],
  ];
  const onErrorOf = (node: SpecNode) => (node as { onError?: string }).onError;

  it.each(NODES)('sets onError on a %s node', (_name, node) => {
    const { changed } = renderNode(node.type, node);

    pick('When this node throws', 'Continue past the error');

    expect(onErrorOf(changed())).toBe('continue');
  });

  it.each(NODES)('clears onError back to the default on a %s node', (_name, node) => {
    const { changed } = renderNode(node.type, { ...node, onError: 'continue' } as SpecNode);

    openSelect('When this node throws');
    fireEvent.click(screen.getByRole('option', { name: /Fail the node/ }));

    expect(onErrorOf(changed())).toBeUndefined();
  });

  it('says what onError covers and that it wins over onFail', () => {
    renderNode('step', STEP);
    expect(screen.getByText(/errors thrown by the node.s activity.*wins over/)).toBeTruthy();
  });

  it('edits spanName on an agent node', () => {
    const node = NODES.find(([name]) => name === 'agent')?.[1] as SpecNode;
    const { changed } = renderNode('agent', node);

    fireEvent.change(screen.getByLabelText('Span name'), { target: { value: 'my-span' } });

    expect((changed() as { spanName?: string }).spanName).toBe('my-span');
  });

  it.each(['mcp', 'eval'])('offers no spanName on a %s node, which ignores it', (type) => {
    const node = NODES.find(([name]) => name === type)?.[1] as SpecNode;
    renderNode(node.type, node);

    expect(screen.queryByLabelText('Span name')).toBeNull();
  });
});

describe('NodeInspector fanOut items binding', () => {
  const FAN = { over: { from: 'ctx.items' }, type: 'fanOut' } as SpecNode;
  const overOf = (node: SpecNode) => (node as { over: unknown }).over;

  it('writes an expression binding for over, carrying the text across', () => {
    const { changed } = renderNode('fanOut', FAN);

    pick('Path', 'Expression');

    expect(overOf(changed())).toEqual({ expr: 'ctx.items' });
  });

  it('keeps editing a path, and preserves its default', () => {
    const { changed } = renderNode('fanOut', {
      over: { default: [], from: 'ctx.items' },
      type: 'fanOut',
    } as SpecNode);

    fireEvent.change(screen.getByLabelText('Items'), { target: { value: 'ctx.other' } });

    expect(overOf(changed())).toEqual({ default: [], from: 'ctx.other' });
  });
});

describe('NodeInspector set node row edge cases', () => {
  const SET: SpecNode = {
    type: 'set',
    values: { a: { literal: '5' }, b: { from: 'ctx.b' } },
  } as SpecNode;
  const valuesOf = (node: SpecNode) => (node as Extract<SpecNode, { type: 'set' }>).values;

  it('refuses a JSON edit that is not a binding, and names the shapes', () => {
    const { onChangeNode } = renderNode('set', SET);
    const raw = screen.getByLabelText('Value for a (JSON)');

    fireEvent.change(raw, { target: { value: '{"nope":1}' } });
    fireEvent.blur(raw);

    expect(onChangeNode).not.toHaveBeenCalled();
    expect(screen.getByText(/Must be \{ "from"/)).toBeTruthy();
  });

  it('does nothing when a JSON row is left unchanged', () => {
    const { onChangeNode } = renderNode('set', SET);

    fireEvent.blur(screen.getByLabelText('Value for a (JSON)'));

    expect(onChangeNode).not.toHaveBeenCalled();
  });

  it('allows a key that only exists on Object.prototype', () => {
    const { changed } = renderNode('set', SET);
    const key = screen.getAllByLabelText('Context path')[1] as HTMLElement;

    fireEvent.change(key, { target: { value: 'constructor' } });
    fireEvent.blur(key);

    expect(Object.keys(valuesOf(changed()))).toEqual(['a', 'constructor']);
  });

  it('keeps the rows on screen in step with the data after a removal', () => {
    const { onChangeNode } = renderNode('set', SET);

    fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));

    expect(valuesOf(onChangeNode.mock.calls.at(-1)?.[0] as SpecNode)).toEqual({
      b: { from: 'ctx.b' },
    });
  });
});

describe('NodeInspector eval node', () => {
  const EVAL = {
    scorers: [{ kind: 'judge', rubricRef: 'quality' }],
    target: { from: 'ctx.diff' },
    type: 'eval',
  } as SpecNode;

  it('names the rubric by bare slug and offers no baseline input', () => {
    renderNode('eval', EVAL);

    expect(screen.getByPlaceholderText('code-review-quality')).toBeTruthy();
    expect(screen.queryByLabelText(/baseline/i)).toBeNull();
  });

  it('has no input-bindings section, since the executor reads only the target', () => {
    renderNode('eval', EVAL);

    expect(screen.queryByText('Input bindings')).toBeNull();
  });
});

describe('NodeInspector authored commands', () => {
  it('warns on a gate step with its own command, and says who may save it', () => {
    renderInspector(
      { config: { command: 'npm run lint' }, next: 'a', step: 'runLint', type: 'step' },
      'lint'
    );
    const alert = screen.getByText('Authored command').closest('[role]') ?? document.body;
    expect(alert.textContent).toMatch(/runs in the run's workspace/);
    expect(alert.textContent).toMatch(/team admin/);
    cleanup();
  });

  it('warns on an eval node whose gate scorer has a command', () => {
    renderInspector(
      {
        scorers: [{ command: 'npm run check', gate: 'lint', kind: 'gate' }],
        target: { from: 'nodes.a.output' },
        type: 'eval',
      },
      'ev'
    );
    expect(screen.getByText('Authored command')).toBeTruthy();
    cleanup();
  });

  it('says nothing for a gate step that runs the repository command', () => {
    renderInspector({ next: 'a', step: 'runLint', type: 'step' }, 'lint');
    expect(screen.queryByText('Authored command')).toBeNull();
    cleanup();
  });
});
