import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  persist: vi.fn(async (..._args: unknown[]) => {}),
  readTicket: vi.fn(),
  resolveSpec: vi.fn(async (..._args: unknown[]) => ({ agentKey: 'ticketContextGatherer' })),
  runAgent: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: () => {},
}));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: (...args: unknown[]) => mocks.persist(...args),
}));
vi.mock('../lib/cancellation.js', () => ({ throwIfActivityCancelled: () => mocks.cancel() }));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: (...args: unknown[]) => mocks.resolveSpec(...args),
}));
vi.mock('../lib/config/contextLookup.js', () => ({ currentRequestContext: async () => ({}) }));
vi.mock('../lib/ticketContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ticketContext.js')>()),
  readTicket: (...args: unknown[]) => mocks.readTicket(...args),
}));
vi.mock('./runAgent.js', () => ({ runAgent: (...args: unknown[]) => mocks.runAgent(...args) }));

import { TicketDigestSchema } from '../lib/ticketContext.js';
import { gatherTicketContext } from './gatherTicketContext.js';

const ISSUE = {
  comments: [{ author: 'Al', body: 'Use the existing router.', created: '2026-10-01' }],
  description: 'Add a /health endpoint.',
  labels: [],
  parent: {
    description: 'Observability',
    id: 'AIDEVEX-1',
    status: 'Open',
    title: 'Epic',
    type: 'Epic',
  },
  richFetched: true,
  status: 'To Do',
  title: 'Health endpoint',
  url: 'https://x.atlassian.net/browse/AIDEVEX-8',
};
const LOADED = {
  issue: ISSUE,
  provider: 'jira',
  requestedById: 'user-1',
  source: 'tracker',
  ticketId: 'AIDEVEX-8',
};
const REQUEST = { description: 'Some work', workRequestId: 'wr-1' } as never;
const DIGEST = { acceptanceCriteria: ['200 on GET'], summary: 'Add a health endpoint.' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readTicket.mockResolvedValue({ reason: null, ticket: LOADED });
  mocks.runAgent.mockResolvedValue({ object: DIGEST });
});

describe('gatherTicketContext', () => {
  it('reads the ticket rich, hands it to the gatherer, and returns the digest rendered for a prompt', async () => {
    const out = await gatherTicketContext(REQUEST);
    expect(mocks.readTicket).toHaveBeenCalledWith(
      expect.objectContaining({ rich: true, workRequestId: 'wr-1' })
    );
    const spec = mocks.resolveSpec.mock.calls[0]?.[0] as {
      agentKey: string;
      outputSchema: unknown;
    };
    expect(spec.agentKey).toBe('ticketContextGatherer');
    expect(spec.outputSchema).toBe(TicketDigestSchema);
    const message = mocks.runAgent.mock.calls[0]?.[1] as string;
    expect(message).toContain('Use the existing router.');
    expect(message).toContain('Epic');
    expect(out).toMatchObject({ available: true, digested: true });
    expect(out.text).toContain('Summary: Add a health endpoint.');
    expect(out.text).toContain('Acceptance criteria:\n- 200 on GET');
    expect(out.text).toContain('Add a /health endpoint.');
  });

  it('makes no model call and returns nothing when there is no ticket', async () => {
    mocks.readTicket.mockResolvedValue({ reason: null, ticket: null });
    expect(await gatherTicketContext(REQUEST)).toEqual({
      available: false,
      digested: false,
      text: '',
      unavailableReason: '',
    });
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it.each(['forbidden', 'not_found', 'unauthorized', 'unconfigured', 'empty'])(
    'says why the ticket is unavailable (%s) next to available: false',
    async (reason) => {
      mocks.readTicket.mockResolvedValue({ reason, ticket: null });
      expect(await gatherTicketContext(REQUEST)).toEqual({
        available: false,
        digested: false,
        text: '',
        unavailableReason: reason,
      });
      expect(mocks.runAgent).not.toHaveBeenCalled();
    }
  );

  it('has an empty unavailableReason when the ticket was read', async () => {
    expect((await gatherTicketContext(REQUEST)).unavailableReason).toBe('');
  });

  it('falls back to the plain ticket, and says so on the trace, when the gatherer fails', async () => {
    mocks.runAgent.mockRejectedValue(new Error('provider 529'));
    const out = await gatherTicketContext(REQUEST);
    expect(out).toMatchObject({ available: true, digested: false });
    expect(out.text).toContain('Health endpoint');
    expect(out.text).toContain('Use the existing router.');
    const [tracer] = mocks.persist.mock.calls[0] as [
      { records: Array<{ toolName?: string; error?: string }> },
    ];
    expect(tracer.records).toContainEqual(
      expect.objectContaining({ error: 'provider 529', toolName: 'ticket.digest_degraded' })
    );
  });

  it('treats an answer that does not fit the schema as a failed gatherer', async () => {
    mocks.runAgent.mockResolvedValue({ object: { requirements: 'not a list' } });
    expect(await gatherTicketContext(REQUEST)).toMatchObject({ available: true, digested: false });
  });

  it('lets a cancellation stop the activity instead of returning a partial result', async () => {
    mocks.runAgent.mockRejectedValue(new Error('aborted'));
    mocks.cancel.mockImplementation(() => {
      throw new Error('CANCELLED');
    });
    await expect(gatherTicketContext(REQUEST)).rejects.toThrow('CANCELLED');
  });

  it("passes the step's system prompt override to the agent", async () => {
    await gatherTicketContext(REQUEST, 'CUSTOM PROMPT');
    expect(mocks.resolveSpec.mock.calls[0]?.[0]).toMatchObject({ promptOverride: 'CUSTOM PROMPT' });
  });

  it('persists its trace when the ticket lookup recorded events, and does not fail when that write does', async () => {
    mocks.readTicket.mockImplementation(
      async (args: { tracer: { addActivityEvent: (e: { name: string }) => void } }) => {
        args.tracer.addActivityEvent({ name: 'ticket.context_loaded' });
        return { reason: null, ticket: LOADED };
      }
    );
    mocks.persist.mockRejectedValueOnce(new Error('db down'));
    await expect(gatherTicketContext(REQUEST)).resolves.toMatchObject({ available: true });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
});
