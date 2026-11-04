// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmModal } from './ConfirmModal';
import { Modal } from './Modal';

// A real browser's close() clears `open` and then fires `close`. The shared jsdom stub does not
// fire the event, so a modal that refuses to close could not be tested with it.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    if (!this.hasAttribute('open')) {
      return;
    }
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(cleanup);

function Page() {
  const [editing, setEditing] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  return (
    <>
      <button onClick={() => setEditing('a')} type="button">
        Edit A
      </button>
      <Modal onClose={() => setDiscard(true)} open={editing !== null} title="Edit agent">
        <input aria-label="field" defaultValue={editing ?? ''} />
      </Modal>
      <ConfirmModal
        message="discard?"
        onClose={() => setDiscard(false)}
        onConfirm={() => {
          setEditing(null);
          setDiscard(false);
        }}
        open={discard}
        title="Discard unsaved changes?"
      />
    </>
  );
}

describe('Modal whose caller refuses to close', () => {
  it('stays open after the user chooses to keep editing', () => {
    vi.useFakeTimers();
    render(<Page />);
    fireEvent.click(screen.getByText('Edit A'));
    const edit = screen.getByLabelText('field').closest('dialog') as HTMLDialogElement;
    fireEvent.click(screen.getAllByRole('button', { hidden: true, name: 'Close' })[0] as Element);
    act(() => {
      vi.runAllTimers();
    });
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Cancel' }));
    act(() => {
      vi.runAllTimers();
    });
    expect(edit.hasAttribute('open')).toBe(true);
    vi.useRealTimers();
  });

  it('still closes when the caller clears open', () => {
    vi.useFakeTimers();
    render(<Page />);
    fireEvent.click(screen.getByText('Edit A'));
    const edit = screen.getByLabelText('field').closest('dialog') as HTMLDialogElement;
    fireEvent.click(screen.getAllByRole('button', { hidden: true, name: 'Close' })[0] as Element);
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Confirm' }));
    act(() => {
      vi.runAllTimers();
    });
    expect(edit.hasAttribute('open')).toBe(false);
    vi.useRealTimers();
  });
});
