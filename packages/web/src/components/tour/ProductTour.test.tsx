// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TourStep } from '@/lib/tourSteps';
import { ProductTour } from './ProductTour';

const STEPS: TourStep[] = [
  { anchor: 'nav:/a', body: 'About A', id: 'a', roles: ['ENGINEER'], title: 'Alpha' },
  { anchor: 'nav:/missing', body: 'About B', id: 'b', roles: ['ENGINEER'], title: 'Beta' },
  { anchor: null, body: 'About C', id: 'c', roles: ['ENGINEER'], title: 'Gamma' },
];

/** jsdom has no layout: give every element with a data-tour a real size, except `zero`. */
function layout(zero?: string) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const tour = this.getAttribute('data-tour');
    const size = tour && tour !== zero ? 40 : 0;
    return {
      bottom: size,
      height: size,
      left: 0,
      right: size,
      toJSON: () => ({}),
      top: 0,
      width: size,
      x: 0,
      y: 0,
    };
  });
}

function addAnchor(tour: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('data-tour', tour);
  a.href = '/a';
  a.textContent = tour;
  document.body.appendChild(a);
  return a;
}

function addSidebarAnchor() {
  const aside = document.createElement('aside');
  aside.setAttribute('data-tour', 'sidebar');
  document.body.appendChild(aside);
  const link = document.createElement('a');
  link.setAttribute('data-tour', 'nav:/a');
  link.href = '/a';
  aside.appendChild(link);
  return { aside, link };
}

const card = () => screen.getByRole('dialog');

beforeEach(() => {
  layout();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ProductTour', () => {
  it('is a non-modal dialog named by the step heading, with "Step N of M"', () => {
    addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={STEPS} />);
    expect(card().getAttribute('aria-modal')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Alpha' })).toBeTruthy();
    // "Step N of M" and the body are both part of the dialog's description.
    const dialog = screen.getByRole('dialog', { description: /Step 1 of 3.*About A/ });
    expect(dialog).toBe(card());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { description: /Step 2 of 3.*About B/ })).toBeTruthy();
  });

  it('moves focus to the heading on every step, going forward and back', () => {
    addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={STEPS} />);
    const heading = () => screen.getByRole('heading', { level: 2 });
    expect(document.activeElement).toBe(heading());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(heading().textContent).toBe('Beta');
    expect(document.activeElement).toBe(heading());
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(heading().textContent).toBe('Alpha');
    expect(document.activeElement).toBe(heading());
  });

  it('offers Back only after the first step and Done instead of Next on the last', () => {
    addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={STEPS} />);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('reports completion only for Done', () => {
    const onEnd = vi.fn();
    render(<ProductTour onEnd={onEnd} steps={STEPS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onEnd).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onEnd).toHaveBeenLastCalledWith(true);
  });

  it('ends on Escape wherever focus is, once per press', () => {
    const onEnd = vi.fn();
    const link = addAnchor('nav:/a');
    render(<ProductTour onEnd={onEnd} steps={STEPS} />);
    link.focus();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it('ignores other keys and an Escape already handled elsewhere', () => {
    const onEnd = vi.fn();
    render(<ProductTour onEnd={onEnd} steps={STEPS} />);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    const handled = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('highlights the anchor with an outline and removes it when the step moves on', () => {
    const link = addAnchor('nav:/a');
    link.style.outline = '1px dotted red';
    render(<ProductTour onEnd={() => undefined} steps={STEPS} />);
    expect(link.getAttribute('data-tour-active')).toBe('true');
    expect(link.style.outline).toContain('2px solid');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(link.hasAttribute('data-tour-active')).toBe(false);
    expect(link.style.outline).toBe('1px dotted red');
  });

  it('does not trap focus: the page behind stays reachable', () => {
    const link = addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={STEPS} />);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it('falls back to a centered card when the anchor does not exist', () => {
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[1]]} />);
    expect(card().className).toContain('top-1/2');
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy();
  });

  it('falls back to a centered card when the anchor has no size (hidden drawer)', () => {
    layout('nav:/a');
    const link = addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).toContain('top-1/2');
    expect(link.hasAttribute('data-tour-active')).toBe(false);
  });

  it('falls back when the anchor is off screen to the left', () => {
    const link = addAnchor('nav:/a');
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: -240,
      right: -10,
      toJSON: () => ({}),
      top: 0,
      width: 230,
      x: -240,
      y: 0,
    });
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).toContain('top-1/2');
  });

  it('points at a visible anchor instead of centering', () => {
    addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).not.toContain('top-1/2');
  });

  it('finds an anchor that becomes visible after a resize', () => {
    layout('nav:/a');
    const link = addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).toContain('top-1/2');
    vi.restoreAllMocks();
    layout();
    fireEvent(window, new Event('resize'));
    expect(card().className).not.toContain('top-1/2');
    expect(link.getAttribute('data-tour-active')).toBe('true');
  });

  it('scrolls the anchor into view when the runtime can', () => {
    const link = addAnchor('nav:/a');
    const scroll = vi.fn();
    link.scrollIntoView = scroll;
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
  });

  it('does not animate the scroll for prefers-reduced-motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true }))
    );
    const link = addAnchor('nav:/a');
    const scroll = vi.fn();
    link.scrollIntoView = scroll;
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    vi.unstubAllGlobals();
  });

  it('does not end on Escape from a text field outside the card, nor during IME composition', () => {
    const onEnd = vi.fn();
    render(<ProductTour onEnd={onEnd} steps={STEPS} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    const area = document.createElement('textarea');
    document.body.appendChild(area);
    fireEvent.keyDown(area, { key: 'Escape' });
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.appendChild(editable);
    fireEvent.keyDown(editable, { key: 'Escape' });
    fireEvent.keyDown(document.body, { isComposing: true, key: 'Escape' });
    expect(onEnd).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('lets an Escape already used by the drawer end only the drawer', () => {
    const onEnd = vi.fn();
    render(<ProductTour onEnd={onEnd} steps={STEPS} />);
    // A document listener registered after the tour's still runs before it (window is last).
    const drawer = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', drawer);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', drawer);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('marks the card so the drawer focus trap treats it as inside, and lets it scroll', () => {
    render(<ProductTour onEnd={() => undefined} steps={STEPS} />);
    expect(card().hasAttribute('data-tour-card')).toBe(true);
    expect(card().className).toContain('overflow-y-auto');
  });

  it('cleans up when it unmounts mid-step: outline restored, listeners removed', () => {
    const link = addAnchor('nav:/a');
    link.style.outline = '1px dotted red';
    const onEnd = vi.fn();
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ProductTour onEnd={onEnd} steps={STEPS} />);
    expect(link.getAttribute('data-tour-active')).toBe('true');
    unmount();
    expect(link.style.outline).toBe('1px dotted red');
    expect(link.hasAttribute('data-tour-active')).toBe(false);
    const removed = remove.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(expect.arrayContaining(['keydown', 'resize', 'scroll']));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('centers the card when the anchor unmounts mid-step (a collapsed section)', async () => {
    const { link } = addSidebarAnchor();
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).not.toContain('top-1/2');
    link.remove();
    await waitFor(() => expect(card().className).toContain('top-1/2'));
  });

  it('centers the card on scroll once the anchor has been removed', () => {
    const link = addAnchor('nav:/a');
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).not.toContain('top-1/2');
    link.remove();
    fireEvent.scroll(window);
    expect(card().className).toContain('top-1/2');
  });

  it('looks again when the drawer opens (class change on the sidebar)', async () => {
    layout('nav:/a');
    const { aside } = addSidebarAnchor();
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).toContain('top-1/2');
    vi.restoreAllMocks();
    layout();
    aside.className = 'max-md:translate-x-0';
    await waitFor(() => expect(card().className).not.toContain('top-1/2'));
  });

  it('looks again when the drawer finishes sliding (transitionend inside the sidebar)', () => {
    layout('nav:/a');
    const { aside } = addSidebarAnchor();
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).toContain('top-1/2');
    vi.restoreAllMocks();
    layout();
    fireEvent.transitionEnd(aside);
    expect(card().className).not.toContain('top-1/2');
  });

  it('centers the card when the browser says the anchor is not visible', () => {
    const link = addAnchor('nav:/a');
    (link as unknown as { checkVisibility: () => boolean }).checkVisibility = () => false;
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).toContain('top-1/2');
    expect(link.hasAttribute('data-tour-active')).toBe(false);
  });

  it('points at the anchor when checkVisibility says it is visible', () => {
    const link = addAnchor('nav:/a');
    (link as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).not.toContain('top-1/2');
  });

  it('centers the card when the anchor ends exactly at the left edge (closed drawer)', () => {
    const link = addAnchor('nav:/a');
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: -234,
      right: 0,
      toJSON: () => ({}),
      top: 0,
      width: 234,
      x: -234,
      y: 0,
    });
    render(<ProductTour onEnd={() => undefined} steps={[STEPS[0]]} />);
    expect(card().className).toContain('top-1/2');
  });

  it('renders nothing for an empty step list rather than throwing', () => {
    render(<ProductTour onEnd={() => undefined} steps={[]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
