'use client';

import { create } from 'zustand';

/**
 * The Help panel's state. `target` is the element inside the panel that pages portal their help
 * into (`PageHelp`); `sections` counts how many `PageHelp` blocks the current page has mounted,
 * so the panel can fall back to a default when the page has none. Memory only.
 */
interface HelpState {
  open: boolean;
  target: HTMLElement | null;
  sections: number;
  setOpen: (open: boolean) => void;
  setTarget: (target: HTMLElement | null) => void;
  addSection: () => void;
  removeSection: () => void;
}

export const useHelpStore = create<HelpState>((set) => ({
  addSection: () => set((s) => ({ sections: s.sections + 1 })),
  open: false,
  removeSection: () => set((s) => ({ sections: Math.max(0, s.sections - 1) })),
  sections: 0,
  setOpen: (open) => set({ open }),
  setTarget: (target) => set({ target }),
  target: null,
}));
