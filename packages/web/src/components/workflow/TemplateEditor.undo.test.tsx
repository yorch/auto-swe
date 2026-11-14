// @vitest-environment jsdom

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
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
vi.mock('@/hooks/useValidateWorkflow', () => ({
  useValidateWorkflow: () => ({ mutateAsync: vi.fn() }),
}));
beforeEach(stubDialogPrototype);
afterEach(cleanup);

const BASE: WorkflowSpec = {
  description: 'undo fixture',
  entry: 'start',
  name: 'undo',
  nodes: {
    end: { status: 'SUCCESS', type: 'terminate' },
    middle: { next: 'end', type: 'set', values: {} },
    start: { next: 'middle', type: 'set', values: {} },
  },
  schemaVersion: 1,
};

/** A parent that edits the spec the way the inspector and the page do. */
function Harness({ serverError }: { serverError?: string }) {
  const [spec, setSpec] = useState<WorkflowSpec>(BASE);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div>
      <button
        onClick={() =>
          setSpec((s) => ({
            ...s,
            nodes: {
              ...s.nodes,
              start: { next: 'middle', type: 'set', values: { k: { literal: 'v' } } },
            },
          }))
        }
        type="button"
      >
        edit start
      </button>
      <button
        onClick={() =>
          setSpec((s) => ({
            ...s,
            nodes: { ...s.nodes, extra: { status: 'SUCCESS', type: 'terminate' } },
          }))
        }
        type="button"
      >
        add extra
      </button>
      <pre data-testid="spec">{JSON.stringify(spec)}</pre>
      <TemplateEditor
        onChange={setSpec}
        onSelect={setSelected}
        selectedNodeId={selected}
        {...(serverError ? { serverError } : {})}
        spec={spec}
        stepRegistry={[]}
      />
    </div>
  );
}

const current = () => JSON.parse(screen.getByTestId('spec').textContent ?? '{}') as WorkflowSpec;
const click = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
const canvas = () => screen.getByRole('application', { name: /Workflow editor canvas/ });
const undoButton = () => screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
const redoButton = () => screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
const transformOf = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.style.transform;

describe('editor undo and redo', () => {
  it('undoes an edit, redoes it, and records neither step as a new edit', async () => {
    render(<Harness />);
    await click('edit start');
    expect(current().nodes.start).toMatchObject({ values: { k: { literal: 'v' } } });

    await click('Undo');
    expect(current()).toEqual(BASE);
    expect(redoButton().disabled).toBe(false);
    expect(undoButton().disabled).toBe(true);

    await click('Redo');
    expect(current().nodes.start).toMatchObject({ values: { k: { literal: 'v' } } });
    expect(redoButton().disabled).toBe(true);

    // One entry, not two: a single Undo returns all the way to the start.
    await click('Undo');
    expect(current()).toEqual(BASE);
    expect(undoButton().disabled).toBe(true);
  });

  it('restores the pre-delete spec when a removal is undone', async () => {
    render(<Harness />);
    await click('edit start');
    const beforeDelete = current();
    fireEvent.click(document.querySelector('.react-flow__node[data-id="middle"]') as HTMLElement);
    fireEvent.keyDown(canvas(), { key: 'Delete' });
    await click('Remove node');
    expect(current().nodes.middle).toBeUndefined();

    await click('Undo removal');
    expect(current()).toEqual(beforeDelete);
    // Still one removal's worth of history: the edit before it is undoable next.
    await click('Undo');
    expect(current()).toEqual(BASE);
  });

  it('keeps surviving nodes where they were across a structural change', async () => {
    render(<Harness />);
    const before = ['start', 'middle', 'end'].map(transformOf);
    expect(before.every(Boolean)).toBe(true);
    await click('add extra');
    expect(['start', 'middle', 'end'].map(transformOf)).toEqual(before);
    expect(transformOf('extra')).toBeTruthy();
  });

  it('clears the save rejection once the spec is edited', async () => {
    render(<Harness serverError="Node start is wrong" />);
    expect(screen.getAllByText(/Node start is wrong/).length).toBeGreaterThan(0);
    await click('edit start');
    expect(screen.queryAllByText(/Node start is wrong/)).toHaveLength(0);
  });
});

describe('the undo shortcut', () => {
  it('undoes when focus is on the canvas', async () => {
    render(<Harness />);
    await click('edit start');
    await act(async () => {
      fireEvent.keyDown(canvas(), { ctrlKey: true, key: 'z' });
    });
    expect(current()).toEqual(BASE);
  });

  it('undoes when no element has focus', async () => {
    render(<Harness />);
    await click('edit start');
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    });
    expect(current()).toEqual(BASE);
  });

  it('leaves a text control to its own undo', async () => {
    render(<Harness />);
    await click('edit start');
    const box = document.createElement('textarea');
    canvas().appendChild(box);
    await act(async () => {
      fireEvent.keyDown(box, { ctrlKey: true, key: 'z' });
    });
    expect(current().nodes.start).toMatchObject({ values: { k: { literal: 'v' } } });
  });

  it('does nothing while a dialog is open', async () => {
    render(<Harness />);
    await click('edit start');
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const inside = document.createElement('button');
    dialog.appendChild(inside);
    document.body.appendChild(dialog);
    await act(async () => {
      fireEvent.keyDown(inside, { ctrlKey: true, key: 'z' });
      fireEvent.keyDown(canvas(), { ctrlKey: true, key: 'z' });
      fireEvent.keyDown(document.body, { ctrlKey: true, key: 'z' });
    });
    dialog.remove();
    expect(current().nodes.start).toMatchObject({ values: { k: { literal: 'v' } } });
  });

  it('ignores a key pressed outside the editor', async () => {
    render(<Harness />);
    await click('edit start');
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'edit start' }), {
        ctrlKey: true,
        key: 'z',
      });
    });
    expect(current().nodes.start).toMatchObject({ values: { k: { literal: 'v' } } });
  });
});

describe('node positions', () => {
  it('puts a deleted node back where it was placed when the removal is undone', async () => {
    render(<Harness />);
    await click('Add node');
    await click('Add Terminate node');
    const placed = transformOf('terminate');
    expect(placed).toBeTruthy();

    fireEvent.keyDown(canvas(), { key: 'Delete' });
    await click('Remove node');
    expect(transformOf('terminate')).toBeUndefined();
    await click('Undo removal');
    expect(transformOf('terminate')).toBe(placed);
  });
});
