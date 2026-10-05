import { describe, expect, it } from 'vitest';
import { focusWhenReady } from './focusWhenReady';

/** An element that, like a React Flow node before it is measured, ignores focus() until `ready`. */
function fakeNode() {
  const doc: { activeElement: unknown } = { activeElement: null };
  const node = {
    focus() {
      node.focusCalls++;
      if (node.ready) {
        doc.activeElement = node;
      }
    },
    focusCalls: 0,
    ownerDocument: doc,
    ready: false,
  };
  return node;
}

function frames() {
  const queue: Array<() => void> = [];
  return {
    run(n: number) {
      for (let i = 0; i < n && queue.length > 0; i++) {
        queue.shift()?.();
      }
    },
    schedule: (cb: () => void) => {
      queue.push(cb);
    },
  };
}

describe('focusWhenReady', () => {
  it('keeps trying while the element refuses focus, and stops once it has it', () => {
    const node = fakeNode();
    const f = frames();
    focusWhenReady(() => node as unknown as HTMLElement, { schedule: f.schedule });
    f.run(3);
    expect(node.ownerDocument.activeElement).toBe(null);
    node.ready = true;
    f.run(1);
    expect(node.ownerDocument.activeElement).toBe(node);
    const calls = node.focusCalls;
    f.run(10);
    expect(node.focusCalls).toBe(calls);
  });

  it('waits for an element that is not in the DOM yet', () => {
    const node = fakeNode();
    node.ready = true;
    let present = false;
    const f = frames();
    focusWhenReady(() => (present ? (node as unknown as HTMLElement) : null), {
      schedule: f.schedule,
    });
    f.run(2);
    present = true;
    f.run(1);
    expect(node.ownerDocument.activeElement).toBe(node);
  });

  it('gives up after the frame budget rather than spinning forever', () => {
    const node = fakeNode();
    const f = frames();
    focusWhenReady(() => node as unknown as HTMLElement, { frames: 5, schedule: f.schedule });
    f.run(100);
    expect(node.focusCalls).toBe(5);
  });
});
