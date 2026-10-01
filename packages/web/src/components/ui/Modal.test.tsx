// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

// jsdom implements <dialog> without showModal()/close(); stand in for the
// browser's, including the close event that drives onClose.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

function renderModal(props: { closeOnBackdropClick?: boolean } = {}) {
  const onClose = vi.fn();
  render(
    <Modal onClose={onClose} open title="Skill" {...props}>
      <input aria-label="Name" />
    </Modal>
  );
  return { dialog: screen.getByRole('dialog', { hidden: true }), onClose };
}

describe('Modal', () => {
  it('closes once from the close button', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click', () => {
    const { dialog, onClose } = renderModal();
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores the backdrop when closeOnBackdropClick is off, but still closes from the button', () => {
    const { dialog, onClose } = renderModal({ closeOnBackdropClick: false });
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on a click inside the content', () => {
    const { onClose } = renderModal();
    const input = screen.getByRole('textbox', { hidden: true, name: 'Name' });
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when a press inside the content is released on the backdrop', () => {
    const { dialog, onClose } = renderModal();
    fireEvent.mouseDown(screen.getByRole('textbox', { hidden: true, name: 'Name' }));
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });
});
