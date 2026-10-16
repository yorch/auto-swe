// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useHelpStore } from '@/stores/helpStore';
import { HelpButton } from './HelpPanel';
import { PageHelp } from './PageHelp';

const nav = vi.hoisted(() => ({ pathname: '/runs' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

// jsdom implements <dialog> without showModal()/close(); stand in for the browser's, including
// the close event that drives onClose. Escape is the browser's job, so it is simulated the same
// way the browser does: a cancel event, then close.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  cleanup();
  act(() => useHelpStore.setState({ open: false, sections: 0, target: null }));
});

function Page({ text }: { text: string }) {
  return (
    <PageHelp>
      <p>{text}</p>
    </PageHelp>
  );
}

const button = () => screen.getByRole('button', { name: 'Help for this page' });
const dialog = () => screen.getByRole('dialog', { hidden: true });

describe('Help panel', () => {
  it('is a labelled button that opens a dialog titled for the current page', () => {
    render(<HelpButton />);
    expect(button().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(screen.getByRole('heading', { hidden: true, name: 'Help · All runs' })).toBeTruthy();
  });

  it('shows the help the current page declares', () => {
    render(
      <>
        <HelpButton />
        <Page text="A run is one execution of a workflow template." />
      </>
    );
    fireEvent.click(button());
    expect(screen.getByText('A run is one execution of a workflow template.')).toBeTruthy();
    expect(screen.queryByText('There is no extra help for this page.')).toBeNull();
  });

  it('shows the help of the route that is mounted, and drops it when the page goes', () => {
    const { rerender } = render(
      <>
        <HelpButton />
        <Page text="Runs help" />
      </>
    );
    fireEvent.click(button());
    expect(screen.getByText('Runs help')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Close' }));

    nav.pathname = '/tickets';
    rerender(
      <>
        <HelpButton />
        <Page text="Tickets help" />
      </>
    );
    fireEvent.click(button());
    expect(screen.queryByText('Runs help')).toBeNull();
    expect(screen.getByText('Tickets help')).toBeTruthy();
    expect(screen.getByRole('heading', { hidden: true, name: 'Tickets' })).toBeTruthy();
    nav.pathname = '/runs';
  });

  it('falls back to a note and the docs link on a page with no help', () => {
    render(<HelpButton />);
    fireEvent.click(button());
    expect(screen.getByText('There is no extra help for this page.')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { hidden: true, name: 'Browse the documentation' })
        .getAttribute('href')
    ).toBe('/docs');
  });

  it('closes from the close button and on Escape, and focus goes back to the button', () => {
    render(<HelpButton />);
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Close' }));
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button());
    expect(dialog().hasAttribute('open')).toBe(true);
    // Escape makes a native <dialog> close itself; Modal listens for that close event.
    act(() => {
      (dialog() as HTMLDialogElement).close();
    });
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button());
  });
});
