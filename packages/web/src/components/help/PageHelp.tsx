'use client';

import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useHelpStore } from '@/stores/helpStore';

/**
 * Help for the page that renders it. It draws nothing in the page: its children appear in the
 * Help panel (the "?" in the top bar) while the page is mounted, and leave with it. Because it
 * portals rather than copying content into a registry, the help stays beside the code and the
 * state it describes, and a page with several blocks (a header and a body) shows all of them in
 * mount order.
 */
export function PageHelp({ children }: { children: ReactNode }) {
  const target = useHelpStore((s) => s.target);
  const addSection = useHelpStore((s) => s.addSection);
  const removeSection = useHelpStore((s) => s.removeSection);
  useEffect(() => {
    addSection();
    return removeSection;
  }, [addSection, removeSection]);
  return target ? createPortal(children, target) : null;
}
