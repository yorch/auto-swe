import type { ReactNode } from 'react';

/**
 * A stand-in for `PageHelp` in page tests: it renders the help where it is declared instead of
 * portalling it into the Help panel, so a test can assert the text a page moved into its help
 * without mounting the top bar. Use it as
 * `vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'))`.
 * The panel itself, and the portal, are covered by `HelpPanel.test.tsx`.
 */
export function PageHelp({ children }: { children: ReactNode }) {
  return <div data-testid="page-help">{children}</div>;
}
