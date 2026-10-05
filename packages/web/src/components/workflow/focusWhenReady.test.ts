import { describe, expect, it } from 'vitest';
import { focusWhenReady } from './focusWhenReady';

/** A document with a body, and elements that ignore focus() until `ready` (like an unmeasured node). */
function makeDoc() {
  const body = { id: 'body' };
  const doc: { activeElement: unknown; body: unknown } = { activeElement: body, body };
  const element = (id: string, readyAfter = 0) => {
    const el = {
      calls: 0,
      focus() {
        el.calls++;
        if (el.calls > readyAfter) {
          doc.activeElement = el;
        }
      },
      id,
      ownerDocument: doc,
    };
    return el;
  };
  return { body, doc, element };
}

function frames() {
  const queue: Array<() => void> = [];
  return {
    pending: () => queue.length,
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

const asEl = (x: unknown) => x as HTMLElement;

describe('focusWhenReady', () => {
  it('keeps trying while the node is not measurable yet, then stops once it has focus', () => {
    const { doc, element } = makeDoc();
    const node = element('node', 4); // becomes focusable on the 5th frame
    const f = frames();
    focusWhenReady(() => asEl(node), {
      doc: asEl(doc) as unknown as Document,
      schedule: f.schedule,
    });
    f.run(4);
    expect(doc.activeElement).not.toBe(node);
    f.run(1);
    expect(doc.activeElement).toBe(node);
    const calls = node.calls;
    f.run(10);
    expect(node.calls).toBe(calls);
    expect(f.pending()).toBe(0);
  });

  it('waits for an element that is not in the DOM yet', () => {
    const { doc, element } = makeDoc();
    const node = element('node');
    let present = false;
    const f = frames();
    focusWhenReady(() => (present ? asEl(node) : null), {
      doc: doc as unknown as Document,
      schedule: f.schedule,
    });
    f.run(2);
    present = true;
    f.run(1);
    expect(doc.activeElement).toBe(node);
  });

  it('does not take focus back from something the user moved it to meanwhile', () => {
    const { doc, element } = makeDoc();
    const node = element('node', 3);
    const inspector = element('inspector');
    const f = frames();
    focusWhenReady(() => asEl(node), { doc: doc as unknown as Document, schedule: f.schedule });
    f.run(2);
    inspector.focus(); // the user tabs or clicks elsewhere
    f.run(10);
    expect(doc.activeElement).toBe(inspector);
    expect(node.calls).toBeLessThanOrEqual(2);
  });

  it('treats the element that had focus when it started (the card being removed) as not the user', () => {
    const { doc, element } = makeDoc();
    const card = element('card');
    card.focus();
    const node = element('node', 2);
    const f = frames();
    focusWhenReady(() => asEl(node), { doc: doc as unknown as Document, schedule: f.schedule });
    f.run(5);
    expect(doc.activeElement).toBe(node);
  });

  it('can be cancelled, and gives up after the frame budget', () => {
    const { doc, element } = makeDoc();
    const node = element('node', 1000);
    const f = frames();
    const cancel = focusWhenReady(() => asEl(node), {
      doc: doc as unknown as Document,
      frames: 50,
      schedule: f.schedule,
    });
    f.run(2);
    cancel();
    f.run(100);
    expect(node.calls).toBe(2);

    const again = element('again', 1000);
    const g = frames();
    focusWhenReady(() => asEl(again), {
      doc: doc as unknown as Document,
      frames: 5,
      schedule: g.schedule,
    });
    g.run(100);
    expect(again.calls).toBe(5);
  });
});
