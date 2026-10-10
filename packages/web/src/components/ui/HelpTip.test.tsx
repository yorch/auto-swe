// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HelpTip } from './HelpTip';
import { Modal } from './Modal';

afterEach(cleanup);

// jsdom implements <dialog> without showModal()/close(); stand in for the browser's.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

describe('HelpTip', () => {
  it('is named from the glossary term', () => {
    render(<HelpTip term="gate" />);
    expect(screen.getByRole('button', { name: 'What is a gate?' })).toBeTruthy();
  });

  it('uses "an" before a vowel', () => {
    render(<HelpTip term="agent" />);
    expect(screen.getByRole('button', { name: 'What is an agent?' })).toBeTruthy();
  });

  it('opens on click with the definition and a docs link, wiring aria', () => {
    render(<HelpTip term="gate" />);
    const button = screen.getByRole('button', { name: 'What is a gate?' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);

    const dialog = screen.getByRole('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    expect(button.getAttribute('aria-describedby')).toBe(dialog.id);
    expect(dialog.textContent).toContain('A place where a run stops until a person acts');
    expect(screen.getByRole('link', { name: /learn more/i }).getAttribute('href')).toBe(
      '/docs/hitl-workflows#what-a-hitl-node-does'
    );
  });

  it('closes on a second click', () => {
    render(<HelpTip term="run" />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on keyboard focus and closes on Escape, returning focus to the button', () => {
    render(<HelpTip term="run" />);
    const button = screen.getByRole('button');
    act(() => button.focus());
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('leaves focus alone on Escape when it is elsewhere (a hover-opened tip)', () => {
    render(
      <>
        <input aria-label="elsewhere" />
        <HelpTip term="run" />
      </>
    );
    const input = screen.getByLabelText('elsewhere');
    act(() => input.focus());
    fireEvent.pointerEnter(screen.getByRole('button'), { pointerType: 'mouse' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('opens on hover', () => {
    render(<HelpTip term="run" />);
    fireEvent.pointerEnter(screen.getByRole('button'), { pointerType: 'mouse' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes on an outside press', () => {
    render(
      <div>
        <HelpTip term="run" />
        <p>elsewhere</p>
      </div>
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when focus leaves', () => {
    render(<HelpTip term="run" />);
    const button = screen.getByRole('button');
    act(() => button.focus());
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => button.blur());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves keyboard focus into the docs link with Tab', () => {
    render(<HelpTip term="run" />);
    const button = screen.getByRole('button');
    act(() => button.focus());
    fireEvent.keyDown(button, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('link'));
  });

  it('shows custom text and no docs link', () => {
    render(<HelpTip label="retries">How many times a step is retried.</HelpTip>);
    const button = screen.getByRole('button', { name: 'About retries' });
    fireEvent.click(button);
    expect(screen.getByRole('dialog').textContent).toContain('How many times a step is retried.');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('names its docs link for the term', () => {
    render(<HelpTip term="gate" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('link', { name: 'Learn more about gate' })).toBeTruthy();
  });

  it('prevents the default of Escape so an enclosing native dialog does not cancel', () => {
    render(<HelpTip term="run" />);
    fireEvent.click(screen.getByRole('button'));
    const notPrevented = fireEvent.keyDown(document.body, { cancelable: true, key: 'Escape' });
    expect(notPrevented).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('inside a Modal', () => {
    function renderInModal() {
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose} open title="Policy">
          <HelpTip term="gate" />
        </Modal>
      );
      const modal = screen.getByRole('dialog', { hidden: true, name: 'Policy' });
      return { modal, onClose };
    }

    it('portals the popover into the dialog, not the body', () => {
      const { modal } = renderInModal();
      fireEvent.click(screen.getByRole('button', { hidden: true, name: 'What is a gate?' }));
      const tip = screen.getByRole('dialog', { name: 'Gate' });
      expect(modal.contains(tip)).toBe(true);
      expect(tip.parentElement).toBe(modal);
    });

    it('closes only the tip on Escape and leaves the modal open', () => {
      const { modal, onClose } = renderInModal();
      fireEvent.click(screen.getByRole('button', { hidden: true, name: 'What is a gate?' }));
      const notPrevented = fireEvent.keyDown(modal, { cancelable: true, key: 'Escape' });
      expect(notPrevented).toBe(false);
      expect(screen.queryByRole('dialog', { name: 'Gate' })).toBeNull();
      expect(modal.hasAttribute('open')).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
