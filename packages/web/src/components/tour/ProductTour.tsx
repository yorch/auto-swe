'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useOverlayPosition } from 'react-aria';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import type { TourStep } from '@/lib/tourSteps';

const RING_OUTLINE = '2px solid var(--color-ember-400)';

/**
 * An anchor the card can point at: in the document, laid out with a size, not
 * `visibility: hidden` (a closed mobile drawer), and not parked entirely off screen (the
 * drawer's slide-out transform).
 */
function isUsable(el: HTMLElement): boolean {
  if (!el.isConnected) {
    return false;
  }
  if (
    typeof el.checkVisibility === 'function' &&
    !el.checkVisibility({ visibilityProperty: true })
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth;
}

function findAnchor(anchor: string | null): HTMLElement | null {
  if (!anchor) {
    return null;
  }
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor.replace(/"/g, '\\"')}"]`);
  return el && isUsable(el) ? el : null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** True when `node` is a field whose own keys (typing, IME, its own Escape) are not ours. */
function isEditable(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  return (
    node.isContentEditable ||
    node.tagName === 'INPUT' ||
    node.tagName === 'TEXTAREA' ||
    node.tagName === 'SELECT'
  );
}

const CARD =
  'w-80 max-h-[calc(100vh-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-ink-400 bg-ink-800 p-4 text-left text-sm leading-relaxed text-paper-200 shadow-2xl shadow-black/40';

interface ProductTourProps {
  steps: TourStep[];
  /** Called when the tour ends by any route: Done (`true`), Skip tour or Escape (`false`). */
  onEnd: (completed: boolean) => void;
}

/**
 * A non-modal, step-by-step walk through the shell. The card is a `role="dialog"` without
 * `aria-modal`: the page behind it stays usable and there is no focus trap. Focus moves to the
 * step heading on every step; the caller restores it when the tour ends. The highlighted anchor
 * gets an outline (it takes no space, so layout never moves). A step whose anchor is missing or
 * hidden is shown centered instead.
 */
export function ProductTour({ steps, onEnd }: ProductTourProps) {
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const bodyId = useId();
  const stepCountId = useId();
  const step = steps[index];
  const last = index === steps.length - 1;

  const { overlayProps, updatePosition } = useOverlayPosition({
    containerPadding: 12,
    isOpen: target !== null,
    offset: 12,
    overlayRef: cardRef,
    placement: 'right top',
    targetRef,
  });

  const resolve = useCallback(() => {
    const el = findAnchor(step?.anchor ?? null);
    targetRef.current = el;
    setTarget(el);
  }, [step]);

  // Find the anchor for this step and bring it into view.
  useLayoutEffect(() => {
    resolve();
    findAnchor(step?.anchor ?? null)?.scrollIntoView?.({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [resolve, step]);

  // Focus moves into the card on every step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step is the trigger.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Highlight: an outline on the anchor, restored exactly as found when the step changes.
  useEffect(() => {
    if (!target) {
      return;
    }
    const previous = { outline: target.style.outline, outlineOffset: target.style.outlineOffset };
    target.style.outline = RING_OUTLINE;
    target.style.outlineOffset = '2px';
    target.setAttribute('data-tour-active', 'true');
    return () => {
      target.style.outline = previous.outline;
      target.style.outlineOffset = previous.outlineOffset;
      target.removeAttribute('data-tour-active');
    };
  }, [target]);

  useEffect(() => {
    if (target) {
      updatePosition();
    }
  }, [target, updatePosition]);

  // The viewport can change under the tour (a rotated phone, the drawer closing): look for the
  // anchor again, and follow it when something scrolls.
  useEffect(() => {
    const onScroll = () => {
      const current = targetRef.current;
      if (current && !current.isConnected) {
        resolve();
      } else if (current) {
        updatePosition();
      }
    };
    window.addEventListener('resize', resolve);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', resolve);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [resolve, updatePosition]);

  // The sidebar changes under the tour without a resize or a scroll: the mobile drawer slides in
  // or out (its class changes, then its transform transitions), and collapsing a section unmounts
  // the very link the card points at. Look for the anchor again when either happens.
  useEffect(() => {
    const aside = document.querySelector('[data-tour="sidebar"]');
    const onTransitionEnd = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-tour="sidebar"]')) {
        resolve();
      }
    };
    document.addEventListener('transitionend', onTransitionEnd, true);
    let observer: MutationObserver | undefined;
    if (aside && typeof MutationObserver === 'function') {
      observer = new MutationObserver(resolve);
      observer.observe(aside, {
        attributeFilter: ['class', 'hidden'],
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
    return () => {
      document.removeEventListener('transitionend', onTransitionEnd, true);
      observer?.disconnect();
    };
  }, [resolve]);

  // Escape ends the tour. The listener sits on `window`, after every `document` listener has
  // run, so an Escape the mobile drawer (or a popover) already used arrives `defaultPrevented`
  // and ends only that: one press never closes two things. A field's own Escape (clear, close)
  // and an IME composition are left alone unless focus is inside the card.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
        return;
      }
      const insideCard = event.target instanceof Node && !!cardRef.current?.contains(event.target);
      if (isEditable(event.target) && !insideCard) {
        return;
      }
      event.preventDefault();
      onEnd(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onEnd]);

  if (!step) {
    return null;
  }

  return createPortal(
    <div
      {...(target ? overlayProps : {})}
      aria-describedby={`${stepCountId} ${bodyId}`}
      aria-labelledby={headingId}
      className={
        target
          ? `z-50 ${CARD}`
          : `fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ${CARD}`
      }
      data-testid="product-tour"
      data-tour-card=""
      ref={cardRef}
      role="dialog"
    >
      <p className="text-xs text-paper-500" id={stepCountId}>
        Step {index + 1} of {steps.length}
      </p>
      <h2
        className="mt-1 text-base font-semibold text-paper-50 outline-none"
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
      >
        {step.title}
      </h2>
      <p className="mt-2 text-paper-300" id={bodyId}>
        {step.body}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {last ? (
          <span />
        ) : (
          <Button onClick={() => onEnd(false)} size="sm" variant="ghost">
            Skip tour
          </Button>
        )}
        <div className="flex gap-2">
          {index > 0 && (
            <Button onClick={() => setIndex(index - 1)} size="sm" variant="secondary">
              Back
            </Button>
          )}
          {last ? (
            <Button onClick={() => onEnd(true)} size="sm" variant="primary">
              Done
            </Button>
          ) : (
            <Button onClick={() => setIndex(index + 1)} size="sm" variant="primary">
              Next
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
