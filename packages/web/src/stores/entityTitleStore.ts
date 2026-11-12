'use client';

import { create } from 'zustand';
import type { DetailParent } from '@/lib/navigation';

export interface EntityTitleEntry {
  pathname: string;
  title: string;
  owner: string;
  parent?: DetailParent;
}

export const useEntityTitleStore = create<{
  entry: EntityTitleEntry | null;
  publish: (entry: EntityTitleEntry) => void;
  clear: (owner: string) => void;
}>((set) => ({
  clear: (owner) => set((state) => (state.entry?.owner === owner ? { entry: null } : state)),
  entry: null,
  publish: (entry) => set({ entry }),
}));
