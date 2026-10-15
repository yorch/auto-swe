'use client';

import { create } from 'zustand';

/**
 * Whether the assistant panel is open and which conversation it shows. Kept in memory only: the
 * conversations themselves are on the server, and a reload starts with the panel closed.
 */
interface AssistantPanelState {
  open: boolean;
  /** The conversation on screen; null for a new one not yet sent. */
  conversationId: string | null;
  /** The conversation list instead of a conversation. */
  showingList: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  select: (conversationId: string | null) => void;
  showList: (showing: boolean) => void;
}

export const useAssistantStore = create<AssistantPanelState>((set) => ({
  conversationId: null,
  open: false,
  select: (conversationId) => set({ conversationId, showingList: false }),
  setOpen: (open) => set({ open }),
  showingList: false,
  showList: (showingList) => set({ showingList }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
