// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StudioIntegrationsPage from './page';

const nav = vi.hoisted(() => ({ tab: null as string | null }));

vi.mock('@/hooks/useUrlFilters', () => ({
  useUrlFilters: () => ({
    params: { get: (k: string) => (k === 'tab' ? nav.tab : null) },
    update: vi.fn(),
  }),
}));

function Draft({ label }: { label: string }) {
  const [v, setV] = useState('');
  return <input aria-label={label} onChange={(e) => setV(e.target.value)} value={v} />;
}

vi.mock('@/components/integrations/GitHubTab', () => ({ GitHubTab: () => <Draft label="gh" /> }));
vi.mock('@/components/integrations/SlackTab', () => ({ SlackTab: () => <Draft label="slack" /> }));
vi.mock('@/components/integrations/IssueTrackerTab', () => ({ IssueTrackerTab: () => null }));
vi.mock('@/components/integrations/KnowledgeBaseTab', () => ({ KnowledgeBaseTab: () => null }));
vi.mock('@/components/integrations/FigmaTab', () => ({ FigmaTab: () => null }));
vi.mock('@/components/audit/ConfigAuditLogTab', () => ({ ConfigAuditLogTab: () => null }));
vi.mock('@/components/setup/SetupReadiness', () => ({ SetupBanner: () => null }));

afterEach(cleanup);

describe('integrations page tabs', () => {
  it('keeps a tab’s unsaved edits when the URL moves away and back (browser Back)', () => {
    nav.tab = null;
    const { rerender } = render(<StudioIntegrationsPage />);
    fireEvent.change(screen.getByLabelText('gh'), { target: { value: 'ghp_draft' } });

    nav.tab = 'slack';
    rerender(<StudioIntegrationsPage />);
    expect(screen.getByLabelText('slack')).toBeTruthy();

    nav.tab = null;
    rerender(<StudioIntegrationsPage />);
    expect((screen.getByLabelText('gh') as HTMLInputElement).value).toBe('ghp_draft');
  });
});
