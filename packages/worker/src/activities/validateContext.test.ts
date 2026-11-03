import { beforeEach, describe, expect, it, vi } from 'vitest';

const { persistMock, readTicketMock, runAgentMock, settingMock, ticketMock, upsertMock } =
  vi.hoisted(() => ({
    persistMock: vi.fn(async (..._args: unknown[]) => {}),
    readTicketMock: vi.fn(
      async (..._args: unknown[]) => ({ reason: null, ticket: null }) as unknown
    ),
    runAgentMock: vi.fn(),
    settingMock: vi.fn(async (..._args: unknown[]) => false),
    ticketMock: vi.fn(async (..._args: unknown[]) => ''),
    upsertMock: vi.fn(async () => ({ id: 'snap-1' })),
  }));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { contextSnapshot: { upsert: upsertMock } },
}));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: () => {},
}));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: (...args: unknown[]) => persistMock(...args),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn(async () => ({ agentKey: 'validateContext' })),
}));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: (...args: unknown[]) => settingMock(...args),
}));
vi.mock('../lib/ticketContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ticketContext.js')>()),
  loadTicketContext: ticketMock,
  readTicket: (...args: unknown[]) => readTicketMock(...args),
}));
vi.mock('./runAgent.js', () => ({ runAgent: runAgentMock }));

import { NO_CRITERIA_REASON } from '../lib/contextAmbiguity.js';
import {
  buildValidationUserMessage,
  isThinRequest,
  THIN_REQUEST_MAX_CHARS,
  THIN_REQUEST_MAX_TOKENS,
  validateContext,
} from './validateContext.js';

describe('buildValidationUserMessage', () => {
  it('uses the structured payload for generic requests', () => {
    const request = {
      connectionId: 'conn-1',
      payload: { title: 'Draft Q3 roadmap', urgency: 'high' },
      workRequestId: 'wr-1',
    };

    const message = buildValidationUserMessage(request);
    const parsed = JSON.parse(message);

    expect(parsed).toEqual({
      payload: { title: 'Draft Q3 roadmap', urgency: 'high' },
    });
  });

  it('falls back to legacy SWE fields when no payload is present', () => {
    const request = {
      description: 'Add a health endpoint',
      externalTicketId: 'JIRA-42',
      repoId: 'repo-1',
      requestPayload: '{ "foo": "bar" }',
      workRequestId: 'wr-2',
    };

    const message = buildValidationUserMessage(request);
    const parsed = JSON.parse(message);

    expect(parsed).toEqual({
      description: 'Add a health endpoint',
      requestPayload: '{ "foo": "bar" }',
      title: 'JIRA-42',
    });
  });
});

describe('buildValidationUserMessage with a tracker ticket', () => {
  const ticket = '\n\n## Issue tracker ticket\n<ticket>\nTitle: Health endpoint\n</ticket>';

  it('adds the ticket beside the structured payload', () => {
    const parsed = JSON.parse(
      buildValidationUserMessage(
        { payload: { title: 'T' }, workRequestId: 'wr-1' } as never,
        ticket
      )
    );
    expect(parsed).toEqual({ payload: { title: 'T' }, ticket });
  });

  it('adds the ticket to the legacy fields, and leaves them alone without one', () => {
    const request = {
      description: 'D',
      externalTicketId: 'JIRA-1',
      workRequestId: 'wr-1',
    } as never;
    expect(JSON.parse(buildValidationUserMessage(request, ticket))).toEqual({
      description: 'D',
      ticket,
      title: 'JIRA-1',
    });
    expect(JSON.parse(buildValidationUserMessage(request, ''))).not.toHaveProperty('ticket');
  });
});

describe('validateContext degradation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues with empty criteria, and records why, when the LLM call fails', async () => {
    runAgentMock.mockRejectedValue(new Error('provider 529'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);

    expect(out).toEqual({
      actionable: true,
      ambiguities: [],
      contextSnapshotId: 'snap-1',
      successCriteria: [],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider 529'));
    const [tracer, key] = persistMock.mock.calls[0] as [
      { records: Array<{ type: string; toolName?: string | null; error?: string | null }> },
      string,
    ];
    expect(key).toBe('validateContext');
    expect(tracer.records).toContainEqual(
      expect.objectContaining({
        error: 'provider 529',
        toolName: 'context_validation.degraded',
        type: 'activity_event',
      })
    );
    warn.mockRestore();
  });

  it('records no degradation event on success', async () => {
    runAgentMock.mockResolvedValue({ object: { successCriteria: ['a'] } });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.successCriteria).toEqual(['a']);
    expect(persistMock).not.toHaveBeenCalled();
  });
});

describe('validateContext verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a request whose every criterion is an ambiguity as not actionable', async () => {
    runAgentMock.mockResolvedValue({
      object: { successCriteria: ['AMBIGUOUS: only a Jira URL, no description'] },
    });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out).toEqual({
      actionable: false,
      ambiguities: ['only a Jira URL, no description'],
      contextSnapshotId: 'snap-1',
      successCriteria: ['AMBIGUOUS: only a Jira URL, no description'],
    });
    // The snapshot keeps the criteria exactly as the agent wrote them.
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          successCriteria: ['AMBIGUOUS: only a Jira URL, no description'],
        }),
      })
    );
  });

  it('reports a successful extraction that found nothing as not actionable', async () => {
    runAgentMock.mockResolvedValue({ object: { successCriteria: [] } });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.actionable).toBe(false);
    expect(out.ambiguities).toEqual(['validation could not extract any verifiable criteria']);
    expect(out.successCriteria).toEqual([]);
  });

  it('does not stop a request when the extraction itself failed', async () => {
    runAgentMock.mockRejectedValue(new Error('provider 529'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.actionable).toBe(true);
    warn.mockRestore();
  });

  it('reports a request with a verifiable criterion as actionable', async () => {
    runAgentMock.mockResolvedValue({
      object: { successCriteria: ['GET /health returns 200', 'AMBIGUOUS: no auth stated'] },
    });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.actionable).toBe(true);
    expect(out.ambiguities).toEqual(['no auth stated']);
  });
});

describe('validateContext ticket context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingMock.mockResolvedValue(false);
    ticketMock.mockResolvedValue('');
    runAgentMock.mockResolvedValue({ object: { successCriteria: ['a'] } });
  });

  const sentMessage = () => JSON.parse(runAgentMock.mock.calls[0]?.[1] as string);

  describe('from an earlier step', () => {
    it('gives the model the ticket the gatherer step produced, and fetches nothing itself', async () => {
      settingMock.mockResolvedValue(true);
      await validateContext(
        { description: 'Some work', workRequestId: 'wr-9' } as never,
        undefined,
        '<ticket>Title: Health endpoint</ticket>'
      );
      expect(sentMessage().ticket).toContain('Health endpoint');
      expect(ticketMock).not.toHaveBeenCalled();
    });

    it('takes an empty ticket from the step as "none", even with the fallback on', async () => {
      settingMock.mockResolvedValue(true);
      await validateContext({ description: 'x', workRequestId: 'wr-9' } as never, undefined, '');
      expect(sentMessage()).not.toHaveProperty('ticket');
      expect(ticketMock).not.toHaveBeenCalled();
    });
  });

  describe('when no step provided one', () => {
    it('does not fetch on its own while the fallback setting is off', async () => {
      await validateContext({ description: 'Some work', workRequestId: 'wr-9' } as never);
      expect(settingMock).toHaveBeenCalledWith('workflow.ticketContextFallback', expect.anything());
      expect(ticketMock).not.toHaveBeenCalled();
      expect(sentMessage()).not.toHaveProperty('ticket');
    });

    it("fetches the run's ticket when the fallback is on", async () => {
      settingMock.mockResolvedValue(true);
      ticketMock.mockResolvedValue('<ticket>Title: Health endpoint</ticket>');
      await validateContext({ description: 'Some work', workRequestId: 'wr-9' } as never);
      expect(ticketMock).toHaveBeenCalledWith(expect.objectContaining({ workRequestId: 'wr-9' }));
      expect(sentMessage().ticket).toContain('Health endpoint');
    });

    it('reads a failing setting as off, and still validates when the lookup itself fails', async () => {
      settingMock.mockRejectedValue(new Error('db down'));
      const off = await validateContext({ description: 'x', workRequestId: 'wr-9' } as never);
      expect(off.successCriteria).toEqual(['a']);
      expect(ticketMock).not.toHaveBeenCalled();

      settingMock.mockResolvedValue(true);
      ticketMock.mockRejectedValue(new Error('boom'));
      const on = await validateContext({ description: 'x', workRequestId: 'wr-9' } as never);
      expect(on.successCriteria).toEqual(['a']);
    });

    it('persists the ticket events it recorded, once, together with any degradation', async () => {
      settingMock.mockResolvedValue(true);
      ticketMock.mockImplementation(async (args: unknown) => {
        (
          args as { tracer: { addActivityEvent: (e: { name: string }) => void } }
        ).tracer.addActivityEvent({
          name: 'ticket.context_loaded',
        });
        return '<ticket>x</ticket>';
      });
      runAgentMock.mockRejectedValue(new Error('provider 529'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await validateContext({ description: 'x', workRequestId: 'wr-9' } as never);
      expect(persistMock).toHaveBeenCalledTimes(1);
      const [tracer] = persistMock.mock.calls[0] as [
        { records: Array<{ toolName?: string | null }> },
      ];
      expect(tracer.records.map((r) => r.toolName)).toEqual([
        'ticket.context_loaded',
        'context_validation.degraded',
      ]);
      warn.mockRestore();
    });
  });
});

describe('isThinRequest', () => {
  const key = 'UIP-15211';

  it('treats the bare ticket key and a few words beside it as thin', () => {
    expect(isThinRequest('Vuln UIP-15211', key)).toBe(true);
    expect(isThinRequest('UIP-15211', key)).toBe(true);
    expect(isThinRequest(`${key}: Vuln!`, key)).toBe(true);
    expect(isThinRequest('x.atlassian.net/UIP-15211', key)).toBe(true);
  });

  it('treats empty and whitespace-only text as thin', () => {
    expect(isThinRequest('', key)).toBe(true);
    expect(isThinRequest('  \n\t \n', key)).toBe(true);
    expect(isThinRequest(`  ${key}  `, key)).toBe(true);
  });

  it.each([
    'Add a retry to the Kafka consumer when the broker returns NOT_LEADER',
    'Fix the login redirect loop on Safari when SSO is enabled',
    'Bump the gRPC deadline on the billing read path from 2s to 10s',
    'Fix the login bug',
    '修复在启用单点登录时苹果浏览器上登录页面无限重定向的问题请尽快处理',
  ])('does not treat a real one-sentence request as thin: %s', (text) => {
    expect(isThinRequest(`${key} ${text}`, key)).toBe(false);
  });

  it('does not treat a single long token, such as a URL, as thin', () => {
    expect(isThinRequest('https://github.com/acme/web/issues/42', key)).toBe(false);
    expect(isThinRequest('https://x.atlassian.net/browse/UIP-15211', key)).toBe(false);
  });

  it('does not treat a short but structured description as thin', () => {
    expect(isThinRequest('- returns 200', key)).toBe(false);
    expect(isThinRequest('Do X\n1. returns 200', key)).toBe(false);
    expect(isThinRequest('Do X\n  * returns 200', key)).toBe(false);
    expect(isThinRequest('Do X\nAcceptance: it works', key)).toBe(false);
    expect(isThinRequest('Do X\nCriteria - it works', key)).toBe(false);
    expect(isThinRequest('Do X\n- [ ] it works', key)).toBe(false);
  });

  it('is exact at the token boundary: 2 tokens are thin, 3 are not', () => {
    expect(THIN_REQUEST_MAX_TOKENS).toBe(3);
    expect(isThinRequest(`a b ${key}`, key)).toBe(true);
    expect(isThinRequest(`a b c ${key}`, key)).toBe(false);
  });

  it('is exact at the character boundary: 15 code points are thin, 16 are not', () => {
    const n = THIN_REQUEST_MAX_CHARS;
    expect(n).toBe(16);
    expect(isThinRequest(`${'a'.repeat(n - 1)} ${key}`, key)).toBe(true);
    expect(isThinRequest(`${key} - ${'a'.repeat(n)}.`, key)).toBe(false);
    expect(isThinRequest('𝒜'.repeat(n - 1), key)).toBe(true);
    expect(isThinRequest('𝒜'.repeat(n), key)).toBe(false);
    expect(isThinRequest('ñ'.repeat(n - 1), key)).toBe(true);
    expect(isThinRequest('ñ'.repeat(n), key)).toBe(false);
  });

  it.each([
    'CVE-2026-1234 in lodash',
    'Enable CSP headers',
    'Add dark mode',
    'Upgrade Node 22',
    'Delete dead code',
    'Fix flaky test',
    'typo in README',
    'Fix typo in README',
  ])('does not treat a short substantive request as thin: %s', (text) => {
    expect(isThinRequest(text, key)).toBe(false);
    expect(isThinRequest(`${key} ${text}`, key)).toBe(false);
  });

  it.each(['TODO', '🔥', 'n/a', '...', 'Bump lodash', 'Revert #123', 'Vuln'])(
    'treats a near-empty request as thin: %s',
    (text) => {
      expect(isThinRequest(text, key)).toBe(true);
      expect(isThinRequest(`${key} ${text}`, key)).toBe(true);
    }
  );

  it('removes the key case-insensitively and every occurrence', () => {
    expect(isThinRequest('uip-15211 UIP-15211 uip-15211', key)).toBe(true);
  });
});

describe('validateContext auth-refused fast path', () => {
  const thin = {
    description: 'Vuln UIP-15211',
    externalTicketId: 'UIP-15211',
    workRequestId: 'wr-1',
  };
  const substantive = {
    ...thin,
    description:
      'Upgrade the lodash dependency in the billing service to 4.17.21 to fix the prototype pollution CVE, then run the billing tests.',
  };
  const refused = (reason: string) => readTicketMock.mockResolvedValue({ reason, ticket: null });

  beforeEach(() => {
    vi.clearAllMocks();
    settingMock.mockResolvedValue(false);
    readTicketMock.mockResolvedValue({ reason: null, ticket: null });
    runAgentMock.mockResolvedValue({ object: { successCriteria: ['a'] } });
  });

  it.each(['unauthorized', 'forbidden'])(
    'skips the model and returns the stop shape for a thin request when the tracker says %s',
    async (reason) => {
      refused(reason);
      const out = await validateContext(thin as never, undefined, '');
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(out).toEqual({
        actionable: false,
        ambiguities: [NO_CRITERIA_REASON],
        contextSnapshotId: 'snap-1',
        successCriteria: [],
      });
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ successCriteria: [] }) })
      );
    }
  );

  it('records the skip and its class, and no provider text', async () => {
    refused('forbidden');
    await validateContext(thin as never, undefined, '');
    const [tracer, key] = persistMock.mock.calls[0] as [
      { records: Array<{ toolName?: string | null; outputJson?: unknown }> },
      string,
    ];
    expect(key).toBe('validateContext');
    const event = tracer.records.find((r) => r.toolName === 'context_validation.skipped');
    expect(event?.outputJson).toEqual({
      reason: 'ticket_auth_refused',
      ticketUnavailableReason: 'forbidden',
    });
  });

  it.each(['unauthorized', 'forbidden'])(
    'still validates a substantive request when the tracker says %s',
    async (reason) => {
      refused(reason);
      const out = await validateContext(substantive as never, undefined, '');
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(out.successCriteria).toEqual(['a']);
      expect(readTicketMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    'not_found',
    'rate_limited',
    'server_error',
    'timeout',
    'network',
    'redirect',
    'rejected',
    'refused',
    'unconfigured',
    'empty',
    'unknown',
  ])('still sends a thin request to the model when the class is %s', async (reason) => {
    refused(reason);
    await validateContext(thin as never, undefined, '');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('still validates when the reason is unknown or the re-read throws', async () => {
    readTicketMock.mockResolvedValue({ reason: null, ticket: null });
    await validateContext(thin as never, undefined, '');
    readTicketMock.mockRejectedValue(new Error('db down'));
    await validateContext(thin as never, undefined, '');
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('uses a ticket the re-read finds: the model gets its text and nothing is skipped', async () => {
    readTicketMock.mockResolvedValue({
      reason: null,
      ticket: { issue: { description: 'Rotate the signing key', title: 'Vuln' } },
    });
    const out = await validateContext(thin as never, undefined, '');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const message = JSON.parse(runAgentMock.mock.calls[0]?.[1] as string) as { ticket?: string };
    expect(message.ticket).toContain('Rotate the signing key');
    expect(message.ticket).toContain('<ticket>');
    expect(out.successCriteria).toEqual(['a']);
    expect(out.actionable).toBe(true);
  });

  it('lets a found ticket win over a forbidden reason', async () => {
    readTicketMock.mockResolvedValue({
      reason: 'forbidden',
      ticket: { issue: { description: 'Rotate the signing key', title: 'Vuln' } },
    });
    await validateContext(thin as never, undefined, '');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('passes a tracer to the re-read and persists it with the activity trace', async () => {
    refused('forbidden');
    await validateContext(thin as never, undefined, '');
    const args = readTicketMock.mock.calls[0]?.[0] as { tracer?: unknown };
    const [tracer] = persistMock.mock.calls[0] as [unknown, string];
    expect(args.tracer).toBe(tracer);

    persistMock.mockClear();
    readTicketMock.mockImplementationOnce(async (a: unknown) => {
      (a as { tracer: { addActivityEvent: (e: unknown) => void } }).tracer.addActivityEvent({
        name: 'ticket.context_unavailable',
        outputJson: { reason: 'timeout' },
      });
      return { reason: 'timeout', ticket: null };
    });
    await validateContext(thin as never, undefined, '');
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it('does not look at the tracker when a ticket was handed in or no gatherer step ran', async () => {
    await validateContext(thin as never, undefined, '<ticket>T</ticket>');
    await validateContext(thin as never);
    expect(readTicketMock).not.toHaveBeenCalled();
    expect(runAgentMock).toHaveBeenCalledTimes(2);
  });

  describe('with the JSON envelope every real launch carries as requestPayload', () => {
    const envelope = (description: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        budget: 'STANDARD',
        description,
        externalTicketId: 'UIP-15211',
        repoId: 'clz9abc',
        ...extra,
      });
    const withPayload = (description: string, requestPayload: string) => ({
      ...thin,
      description,
      requestPayload,
    });

    it.each(['unauthorized', 'forbidden'])(
      'takes the fast path for a thin description beside a realistic payload (%s)',
      async (reason) => {
        refused(reason);
        const out = await validateContext(
          withPayload('Vuln UIP-15211', envelope('Vuln UIP-15211')) as never,
          undefined,
          ''
        );
        expect(runAgentMock).not.toHaveBeenCalled();
        expect(out.actionable).toBe(false);
      }
    );

    it('takes the fast path for a Slack-style payload', async () => {
      refused('forbidden');
      const slack = JSON.stringify({
        channel: 'C0123ABCD',
        source: 'slack_modal',
        user: 'U0456EFGH',
        view: { callback_id: 'launch', values: { description: { value: 'UIP-15211' } } },
      });
      await validateContext(withPayload('UIP-15211', slack) as never, undefined, '');
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it('takes the fast path for a schedule-style payload', async () => {
      refused('unauthorized');
      const schedule = JSON.stringify({
        scheduledAt: '2026-11-03T00:00:00Z',
        scheduleId: 'sch_1',
        trigger: 'schedule',
      });
      await validateContext(withPayload('UIP-15211', schedule) as never, undefined, '');
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it('sends a substantive description with a realistic payload to the model', async () => {
      refused('forbidden');
      const description =
        'Upgrade the lodash dependency in the billing service to 4.17.21 to fix the prototype pollution CVE.';
      await validateContext(
        withPayload(description, envelope(description)) as never,
        undefined,
        ''
      );
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });

    it('sends an empty description with only the payload to the model', async () => {
      refused('forbidden');
      await validateContext(withPayload('', envelope('')) as never, undefined, '');
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });

    it('sends a missing description with only the payload to the model', async () => {
      refused('forbidden');
      await validateContext(
        {
          externalTicketId: 'UIP-15211',
          requestPayload: envelope(''),
          workRequestId: 'wr-1',
        } as never,
        undefined,
        ''
      );
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    });
  });

  it('never skips a structured-payload request', async () => {
    refused('forbidden');
    await validateContext({ payload: { a: 1 }, workRequestId: 'wr-1' } as never, undefined, '');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
});
