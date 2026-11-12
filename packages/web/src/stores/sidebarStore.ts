'use client';

import { create } from 'zustand';
import { SIDEBAR_STORAGE_KEY } from '@/lib/sidebar';

interface SidebarState {
  collapsed: boolean;
  sync: () => void;
  toggle: () => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: false,
  sync: () => {
    try {
      const collapsed = window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
      document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
      set({ collapsed });
    } catch {
      // Storage is optional.
    }
  },
  toggle: () => {
    const collapsed = !get().collapsed;
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
      // Keep the preference for this visit when storage is unavailable.
    }
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    set({ collapsed });
  },
}));
