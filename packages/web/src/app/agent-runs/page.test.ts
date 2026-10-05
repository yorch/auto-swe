import { describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

import AgentRunsPage from './page';

describe('/agent-runs', () => {
  it('forwards old links to Start work in agent mode', () => {
    AgentRunsPage();
    expect(redirect).toHaveBeenCalledWith('/start?mode=agent');
  });
});
