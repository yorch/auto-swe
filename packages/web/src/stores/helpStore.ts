'use client';

import { create } from 'zustand';
import type { PageTourStep } from '@/lib/tourSteps';

/** Which tour was asked for, and the element that asked (focus goes back there when it ends). */
export interface TourRequest {
  kind: 'product' | 'page';
  opener: HTMLElement | null;
}

/**
 * The Help panel's state. `target` is the element inside the panel that pages portal their help
 * into (`PageHelp`); `sections` counts how many `PageHelp` blocks the current page has mounted,
 * so the panel can fall back to a default when the page has none. `pageTour` holds the steps the
 * current page registered through `PageTour` (null when it has none), and `tourRequest` is the
 * tour the shell's `TourHost` is running. Memory only.
 */
interface HelpState {
  open: boolean;
  target: HTMLElement | null;
  sections: number;
  pageTour: PageTourStep[] | null;
  tourRequest: TourRequest | null;
  setOpen: (open: boolean) => void;
  setTarget: (target: HTMLElement | null) => void;
  addSection: () => void;
  removeSection: () => void;
  setPageTour: (steps: PageTourStep[] | null) => void;
  requestTour: (kind: TourRequest['kind'], opener: HTMLElement | null) => void;
  endTour: () => void;
}

export const useHelpStore = create<HelpState>((set) => ({
  addSection: () => set((s) => ({ sections: s.sections + 1 })),
  endTour: () => set({ tourRequest: null }),
  open: false,
  pageTour: null,
  removeSection: () => set((s) => ({ sections: Math.max(0, s.sections - 1) })),
  requestTour: (kind, opener) => set({ tourRequest: { kind, opener } }),
  sections: 0,
  setOpen: (open) => set({ open }),
  setPageTour: (pageTour) => set({ pageTour }),
  setTarget: (target) => set({ target }),
  target: null,
  tourRequest: null,
}));
