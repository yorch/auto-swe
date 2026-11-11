import { CONNECTION_TYPES } from '@auto-swe/shared';
import { GENERIC_STEP_CONNECTION_TYPES } from '@auto-swe/shared/lib/connectionTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConfluenceFooterComment,
  createConfluenceInlineComment,
  createConfluencePage,
  readConfluencePage,
  updateConfluencePage,
} from '../connectors/confluence.js';
import { httpApiRequest } from '../connectors/httpApi.js';
import {
  createHubSpotRecord,
  fetchHubSpotRecord,
  searchHubSpotRecords,
  updateHubSpotRecord,
} from '../connectors/hubspot.js';
import { createIssue, fetchIssue } from '../connectors/issueTracker.js';
import { appendNotionBlocks, createNotionPage, readNotionPage } from '../connectors/notion.js';
import { fetchZendeskTicket, postZendeskComment } from '../connectors/zendesk.js';
import { readSource, runTool, writeOutcome } from './genericActions.js';
import { callMcpConnectionTool } from './mcpCallTool.js';

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string) =>
      Object.assign(new Error(message), { nonRetryable: true, type }),
  },
  // `connectionAccess` logs through `activityLog`, which imports this to decide between
  // the Temporal logger and the console.
  asyncLocalStorage: { getStore: () => undefined },
  Context: {
    current: vi.fn(() => ({
      info: { attempt: 1, workflowExecution: { workflowId: 'wf-1' } },
    })),
  },
}));

vi.mock('@auto-swe/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@auto-swe/shared')>();
  return {
    ...mod,
    decryptConnectionApiToken: () => 'test-token',
  };
});

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    autonomyDecision: { findFirst: vi.fn() },
    connection: { findUnique: vi.fn() },
    workflowOutcomeReference: {
      // The effect is claimed before the provider is called and completed afterwards, so a mock
      // needs all four: the claim (`create`), the completion (`updateMany`), the read, and the
      // release a connector uses when it refused before sending (`deleteMany`).
      create: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    workflowRun: { findUnique: vi.fn() },
  },
}));

vi.mock('../connectors/notion.js', () => ({
  appendNotionBlocks: vi.fn(),
  createNotionPage: vi.fn(),
  readNotionPage: vi.fn(),
}));

vi.mock('../connectors/httpApi.js', () => ({ httpApiRequest: vi.fn() }));

vi.mock('../connectors/hubspot.js', () => ({
  createHubSpotRecord: vi.fn(),
  fetchHubSpotRecord: vi.fn(),
  searchHubSpotRecords: vi.fn(),
  updateHubSpotRecord: vi.fn(),
}));

vi.mock('./mcpCallTool.js', () => ({ callMcpConnectionTool: vi.fn() }));

vi.mock('../connectors/zendesk.js', () => ({
  fetchZendeskTicket: vi.fn(),
  postZendeskComment: vi.fn(),
}));

vi.mock('../connectors/issueTracker.js', () => ({
  createIssue: vi.fn(),
  fetchIssue: vi.fn(),
}));

vi.mock('../connectors/confluence.js', () => ({
  createConfluenceFooterComment: vi.fn(),
  createConfluenceInlineComment: vi.fn(),
  createConfluencePage: vi.fn(),
  readConfluencePage: vi.fn(),
  updateConfluencePage: vi.fn(),
}));

const { prisma } = await import('@auto-swe/shared/db');

function makeConnection(type: string, options?: { config?: unknown; token?: boolean }) {
  return {
    apiKeyAuthTag: options?.token ? Buffer.from('tag') : null,
    apiKeyCiphertext: options?.token ? Buffer.from('cipher') : null,
    apiKeyNonce: options?.token ? Buffer.from('nonce') : null,
    apiKeyVersion: 1,
    config: options?.config ?? { baseUrl: 'https://example.com' },
    isActive: true,
    type,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // An authorized run by default: every connection id these cases name is in the pin, so
  // each one exercises the step it names. The refusal is a case of its own.
  (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    authorizedConnectionIds: [
      '11111111-1111-4111-8111-111111111111',
      '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5',
      'bd4483f7-1fcc-4abe-916c-deab2811a4dc',
      'e9108636-3b75-440c-a4f9-987449669502',
    ],
    id: 'run-1',
  });
});

describe('input validation', () => {
  it('rejects a non-UUID connectionId for readSource', async () => {
    await expect(readSource({ connectionId: 'not-a-uuid' })).rejects.toThrow('Invalid input');
  });

  it('rejects an empty tool name for runTool', async () => {
    await expect(
      runTool({ connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5', inputs: {}, tool: '' })
    ).rejects.toThrow('Invalid input');
  });

  it('rejects a non-UUID connectionId for writeOutcome', async () => {
    await expect(writeOutcome({ connectionId: 'not-a-uuid', data: { ok: true } })).rejects.toThrow(
      'Invalid input'
    );
  });
});

describe('readSource', () => {
  it('reads from a notion connection', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (readNotionPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      blocks: [{ type: 'paragraph' }],
      page: {
        id: '0123456789abcdef0123456789abcdef',
        object: 'page',
        properties: {},
        url: 'https://notion.so/0123456789abcdef0123456789abcdef',
      },
    });

    const result = await readSource({
      connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5',
      query: { pageId: '0123456789abcdef0123456789abcdef' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.data).toEqual({
      blocks: [{ type: 'paragraph' }],
      page: {
        id: '0123456789abcdef0123456789abcdef',
        object: 'page',
        properties: {},
        url: 'https://notion.so/0123456789abcdef0123456789abcdef',
      },
    });
  });

  it('throws when the notion connection has no page id', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );

    await expect(
      readSource({ connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5' })
    ).rejects.toThrow('Notion readSource requires a pageId');
  });

  it('throws when the connection is inactive', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: false,
      type: 'http_api',
    });

    await expect(
      readSource({ connectionId: '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5' })
    ).rejects.toThrow('not found or inactive');
  });
});

describe('writeOutcome approval guard', () => {
  const args = {
    connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
    data: { blocks: [{ type: 'paragraph' }], pageId: '0123456789abcdef0123456789abcdef' },
  };
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  beforeEach(() => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1' });
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: '0123456789abcdef0123456789abcdef',
    });
  });

  it('refuses when the latest publish decision requires approval and none was recorded', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'internal_write',
      })
      .mockResolvedValueOnce(null);

    await expect(writeOutcome(args)).rejects.toThrow('requires human approval');
    expect(appendNotionBlocks).not.toHaveBeenCalled();
  });

  it('writes when an approval was recorded after the publish decision', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
      })
      .mockResolvedValueOnce({ id: 'approval-1' });

    const result = await writeOutcome(args);
    expect(result.ok).toBe(true);
  });

  it('writes when the publish decision is auto', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      createdAt: publishedAt,
      payload: { decision: 'auto' },
    });

    const result = await writeOutcome(args);
    expect(result.ok).toBe(true);
  });

  it('does not gate a run that recorded no publish decision', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await writeOutcome(args);
    expect(result.ok).toBe(true);
  });

  // The approval guard runs after the ledger is read and before the claim, as in `mcpCallTool`.
  // A refusal must leave no PENDING row, or a retry made after approval finds the stale claim and
  // fails with OUTCOME_AMBIGUOUS instead of writing.
  it('refuses with APPROVAL_REQUIRED before claiming the effect', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'internal_write',
      })
      .mockResolvedValueOnce(null);

    await expect(writeOutcome({ ...args, nodeId: 'node-1' })).rejects.toHaveProperty(
      'type',
      'APPROVAL_REQUIRED'
    );
    expect(appendNotionBlocks).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('returns a recorded outcome without consulting approval', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      createdAt: publishedAt,
      payload: { decision: 'require_approval' },
    });
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: { connectionType: 'notion', ok: true, reference: 'stored-page' },
      state: 'DONE',
    });

    const result = await writeOutcome({ ...args, nodeId: 'node-1' });

    expect(result).toEqual({ connectionType: 'notion', ok: true, reference: 'stored-page' });
    expect(prisma.autonomyDecision.findFirst).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
    expect(appendNotionBlocks).not.toHaveBeenCalled();
  });
});

describe('runTool governance', () => {
  const ZENDESK = 'e9108636-3b75-440c-a4f9-987449669502';
  const publishedAt = new Date('2026-01-01T00:00:00Z');
  const postInputs = { body: 'reply', public: false, ticketId: '42' };

  function requireApprovalThenNothing() {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'external_communication',
      })
      .mockResolvedValueOnce(null);
  }

  beforeEach(() => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1' });
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (postZendeskComment as ReturnType<typeof vi.fn>).mockResolvedValue({
      comment: {},
      ticketId: '42',
    });
    (fetchZendeskTicket as ReturnType<typeof vi.fn>).mockResolvedValue({ ticket: { id: 42 } });
  });

  // A tool that changes state outside the platform is governed exactly like
  // writeOutcome. Before this, a template could record a require_approval
  // decision and then post through `runTool`, so the audit log claimed a gate
  // that never happened.
  it('refuses a mutating tool when the recorded policy requires an approval that never came', async () => {
    requireApprovalThenNothing();

    await expect(
      runTool({
        connectionId: ZENDESK,
        inputs: postInputs,
        nodeId: 'notify',
        tool: 'postComment',
      })
    ).rejects.toThrow(/requires human approval/);
    expect(postZendeskComment).not.toHaveBeenCalled();
  });

  it('lets a read-only tool through under the same policy', async () => {
    requireApprovalThenNothing();

    const result = await runTool({
      connectionId: ZENDESK,
      inputs: { ticketId: '42' },
      nodeId: 'lookup',
      tool: 'fetchTicket',
    });
    expect(result.ok).toBe(true);
    // A read changes nothing, so it is neither gated nor recorded.
    expect(prisma.autonomyDecision.findFirst).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('refuses with APPROVAL_REQUIRED before claiming the effect', async () => {
    requireApprovalThenNothing();

    await expect(
      runTool({
        connectionId: ZENDESK,
        inputs: postInputs,
        nodeId: 'notify',
        tool: 'postComment',
      })
    ).rejects.toHaveProperty('type', 'APPROVAL_REQUIRED');
    expect(postZendeskComment).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('returns a recorded outcome without consulting approval', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      createdAt: publishedAt,
      payload: { decision: 'require_approval' },
    });
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: { connectionType: 'zendesk', ok: true, output: 'stored' },
      state: 'DONE',
    });

    const result = await runTool({
      connectionId: ZENDESK,
      inputs: postInputs,
      nodeId: 'notify',
      tool: 'postComment',
    });

    expect(result).toEqual({ connectionType: 'zendesk', ok: true, output: 'stored' });
    expect(prisma.autonomyDecision.findFirst).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
    expect(postZendeskComment).not.toHaveBeenCalled();
  });

  it('records the effect, so a retry returns it instead of posting twice', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        result: { connectionType: 'zendesk', ok: true, output: 'first' },
        state: 'DONE',
      });

    const args = {
      connectionId: ZENDESK,
      inputs: postInputs,
      nodeId: 'notify',
      tool: 'postComment',
    };
    const first = await runTool(args);
    const second = await runTool(args);

    expect(first.ok).toBe(true);
    expect(second.output).toBe('first');
    expect(postZendeskComment).toHaveBeenCalledTimes(1);
    // Claimed before the call, completed with what it returned: the claim carries no result, and
    // the completion is what a retry reads.
    expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        connectionId: ZENDESK,
        nodeId: 'notify',
        runId: 'run-1',
        state: 'PENDING',
      }),
    });
    expect(prisma.workflowOutcomeReference.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'DONE' }),
      })
    );
  });
});

describe('writeOutcome', () => {
  it('throws for a notion connection without a token', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion')
    );

    await expect(
      writeOutcome({
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        data: { page: { title: 'Q3' } },
      })
    ).rejects.toThrow('Connection API token is required');
  });

  it('appends blocks to a notion page', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: '0123456789abcdef0123456789abcdef',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: {
        blocks: [{ type: 'paragraph' }],
        pageId: '0123456789abcdef0123456789abcdef',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.reference).toBe('0123456789abcdef0123456789abcdef');
  });

  it('creates a new notion page', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (createNotionPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      pageId: 'fedcba9876543210fedcba9876543210',
      url: 'https://notion.so/new-page',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: {
        pageId: '0123456789abcdef0123456789abcdef',
        title: 'Draft',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.reference).toBe('https://notion.so/new-page');
  });

  it('appends text to a notion page as paragraph blocks', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 2,
      pageId: '0123456789abcdef0123456789abcdef',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { pageId: '0123456789abcdef0123456789abcdef', text: 'Line one\nLine two' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('notion');
    expect(result.reference).toBe('0123456789abcdef0123456789abcdef');
    expect(appendNotionBlocks).toHaveBeenCalledWith(
      { apiToken: expect.any(String) },
      '0123456789abcdef0123456789abcdef',
      [
        {
          paragraph: { rich_text: [{ text: { content: 'Line one' }, type: 'text' }] },
          type: 'paragraph',
        },
        {
          paragraph: { rich_text: [{ text: { content: 'Line two' }, type: 'text' }] },
          type: 'paragraph',
        },
      ]
    );
  });

  it('throws when the notion payload has no text, blocks, or create fields', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );

    await expect(
      writeOutcome({
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        data: { unknown: 'field' },
      })
    ).rejects.toThrow(
      'Notion writeOutcome data must include text, blocks, or a create-page request'
    );
  });

  it('records an outcome reference when nodeId is provided', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: '0123456789abcdef0123456789abcdef',
    });

    await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { blocks: [{ type: 'paragraph' }], pageId: '0123456789abcdef0123456789abcdef' },
      nodeId: 'node-1',
    });

    expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attempt: 1,
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        nodeId: 'node-1',
        runId: '11111111-1111-4111-8111-111111111111',
      }),
    });
  });

  it('returns a stored outcome reference on retry without re-calling the provider', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: {
        connectionType: 'notion',
        ok: true,
        reference: 'stored-page',
      },
      state: 'DONE',
    });
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: '0123456789abcdef0123456789abcdef',
    });

    const result = await writeOutcome({
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { blocks: [{ type: 'paragraph' }], pageId: '0123456789abcdef0123456789abcdef' },
      nodeId: 'node-1',
    });

    expect(result).toEqual({ connectionType: 'notion', ok: true, reference: 'stored-page' });
    expect(appendNotionBlocks).not.toHaveBeenCalled();
    // The lookup must not key on the Temporal attempt: a retry is a new attempt
    // number, so an attempt-scoped key could never find the previous write. Nor is it ordered by
    // attempt any more — one effect has one row, so there is nothing to order.
    expect(prisma.workflowOutcomeReference.findFirst).toHaveBeenCalledWith({
      where: {
        connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
        nodeId: 'node-1',
        runId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('returns the stored result on the second call and does not repeat the external write', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        result: {
          connectionType: 'notion',
          ok: true,
          reference: '0123456789abcdef0123456789abcdef',
        },
        state: 'DONE',
      });
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: '0123456789abcdef0123456789abcdef',
    });

    const args = {
      connectionId: '4dcf895a-9ed7-450c-8858-e45b8415db4b',
      data: { blocks: [{ type: 'paragraph' }], pageId: '0123456789abcdef0123456789abcdef' },
      nodeId: 'node-1',
    };

    const first = await writeOutcome(args);
    const second = await writeOutcome(args);

    expect(first).toEqual({
      connectionType: 'notion',
      ok: true,
      reference: '0123456789abcdef0123456789abcdef',
    });
    expect(second).toEqual(first);
    expect(appendNotionBlocks).toHaveBeenCalledTimes(1);
    expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledTimes(1);
  });
});

describe('runTool', () => {
  it('fetches a zendesk ticket via fetchTicket tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (fetchZendeskTicket as ReturnType<typeof vi.fn>).mockResolvedValue({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });

    const result = await runTool({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      inputs: { ticketId: '42' },
      tool: 'fetchTicket',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.output).toEqual({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });
  });

  it('posts a zendesk comment via postComment tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (postZendeskComment as ReturnType<typeof vi.fn>).mockResolvedValue({
      comment: { body: 'reply', public: false },
      ticketId: '42',
    });

    const result = await runTool({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      inputs: { body: 'reply', public: false, ticketId: '42' },
      tool: 'postComment',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.output).toEqual({ comment: { body: 'reply', public: false }, ticketId: '42' });
  });

  it('throws for unsupported zendesk tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );

    await expect(
      runTool({
        connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
        inputs: {},
        tool: 'deleteTicket',
      })
    ).rejects.toThrow('Unsupported Zendesk tool: deleteTicket');
  });
});

describe('readSource', () => {
  it('fetches a zendesk ticket', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (fetchZendeskTicket as ReturnType<typeof vi.fn>).mockResolvedValue({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });

    const result = await readSource({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      query: { ticketId: '42' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.data).toEqual({
      ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
    });
  });
});

describe('writeOutcome', () => {
  it('posts a zendesk comment', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (postZendeskComment as ReturnType<typeof vi.fn>).mockResolvedValue({
      comment: { body: 'reply', public: false },
      ticketId: '42',
    });

    const result = await writeOutcome({
      connectionId: 'e9108636-3b75-440c-a4f9-987449669502',
      data: { body: 'reply', ticketId: '42' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('zendesk');
    expect(result.reference).toBe('42');
  });

  it('creates an issue_tracker issue', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('issue_tracker', { config: { provider: 'linear' }, token: true })
    );
    (createIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      url: 'https://linear.app/issue/TEAM-1',
    });

    const result = await writeOutcome({
      connectionId: 'bd4483f7-1fcc-4abe-916c-deab2811a4dc',
      data: { description: 'A bug', projectKey: 'team-uuid', title: 'Bug' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('issue_tracker');
    expect(result.reference).toBe('https://linear.app/issue/TEAM-1');
  });
});

describe('readSource', () => {
  it('fetches an issue_tracker issue', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('issue_tracker', { config: { provider: 'linear' }, token: true })
    );
    (fetchIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      identifier: 'TEAM-1',
      title: 'Bug',
      url: 'https://linear.app/issue/TEAM-1',
    });

    const result = await readSource({
      connectionId: 'bd4483f7-1fcc-4abe-916c-deab2811a4dc',
      query: { issueId: 'TEAM-1' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('issue_tracker');
    expect(result.data).toEqual({
      id: 'issue-1',
      identifier: 'TEAM-1',
      title: 'Bug',
      url: 'https://linear.app/issue/TEAM-1',
    });
  });
});

describe('runTool', () => {
  it('creates an issue via the issue_tracker createIssue tool', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('issue_tracker', { config: { provider: 'jira' }, token: true })
    );
    (createIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '10001',
      identifier: 'PROJ-42',
      url: 'https://x.atlassian.net/browse/PROJ-42',
    });

    const result = await runTool({
      connectionId: 'bd4483f7-1fcc-4abe-916c-deab2811a4dc',
      inputs: { description: 'A task', projectKey: 'PROJ', title: 'Task' },
      tool: 'createIssue',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('issue_tracker');
    expect(result.output).toEqual({
      id: '10001',
      identifier: 'PROJ-42',
      url: 'https://x.atlassian.net/browse/PROJ-42',
    });
  });
});

const confluenceConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.com' };
const confluenceConnectionId = '4dcf895a-9ed7-450c-8858-e45b8415db4b';

describe('confluence readSource', () => {
  it('reads a page and returns its plain text', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
    (readConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      bodyText: 'Steps',
      id: '123',
      title: 'Runbook',
      url: 'https://x.atlassian.net/wiki/pages/123',
      version: 2,
    });

    const result = await readSource({
      connectionId: confluenceConnectionId,
      query: { pageId: '123' },
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('confluence');
    expect(result.data).toEqual({
      bodyText: 'Steps',
      id: '123',
      title: 'Runbook',
      url: 'https://x.atlassian.net/wiki/pages/123',
      version: 2,
    });
    expect(readConfluencePage).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'test-token' }),
      '123'
    );
  });

  it('throws when no page id is supplied', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );

    await expect(readSource({ connectionId: confluenceConnectionId })).rejects.toThrow(
      'Confluence readSource requires a pageId'
    );
  });
});

describe('confluence writeOutcome', () => {
  beforeEach(() => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
  });

  it('creates a page when no target page is named', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/spaces/ENG/pages/9',
      version: 1,
    });

    const result = await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { bodyText: 'Draft', spaceKey: 'ENG', title: 'From a ticket' },
    });

    expect(result).toEqual({
      connectionType: 'confluence',
      ok: true,
      reference: 'https://x.atlassian.net/wiki/spaces/ENG/pages/9',
    });
    expect(createConfluencePage).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ baseUrl: confluenceConfig.baseUrl }),
      }),
      expect.objectContaining({ bodyText: 'Draft', spaceKey: 'ENG', title: 'From a ticket' })
    );
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('updates the named page instead of creating one', async () => {
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 3,
    });

    const result = await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { bodyText: 'Draft', targetPageId: '9', title: 'Doc' },
    });

    expect(result).toEqual({
      connectionType: 'confluence',
      ok: true,
      reference: 'https://x.atlassian.net/wiki/pages/9',
    });
    expect(updateConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      '9',
      expect.objectContaining({ bodyText: 'Draft', title: 'Doc' })
    );
    expect(createConfluencePage).not.toHaveBeenCalled();
  });

  it('refuses a write with no body', async () => {
    await expect(
      writeOutcome({ connectionId: confluenceConnectionId, data: { title: 'Doc' } })
    ).rejects.toThrow('Confluence writeOutcome requires bodyText');
  });

  it('refuses a create with no title', async () => {
    await expect(
      writeOutcome({ connectionId: confluenceConnectionId, data: { bodyText: 'Draft' } })
    ).rejects.toThrow('requires a title to create a page');
  });

  it('uses the fallback title when the request named none', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/spaces/ENG/pages/9',
      version: 1,
    });

    // A form submits an untouched optional field as `''`, and no binding can say
    // "the first non-empty of these", so the caller passes the source's title and
    // the choice is made here.
    await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { bodyText: 'Draft', fallbackTitle: 'From the issue', title: '' },
    });

    expect(createConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'From the issue' })
    );
  });

  it('propagates a connector failure instead of reporting success', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Confluence API error (400)')
    );

    await expect(
      writeOutcome({
        connectionId: confluenceConnectionId,
        data: { bodyText: 'Draft', title: 'Doc' },
      })
    ).rejects.toThrow('Confluence API error (400)');
  });
});

describe('confluence runTool', () => {
  beforeEach(() => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
  });

  it('creates a page', async () => {
    (createConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 1,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'Draft', spaceKey: 'ENG', title: 'Doc' },
      tool: 'createPage',
    });
    expect(result.ok).toBe(true);
    expect(result.connectionType).toBe('confluence');
  });

  it('updates a page', async () => {
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 2,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'New', pageId: '9' },
      tool: 'updatePage',
    });
    expect(result.ok).toBe(true);
    expect(updateConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      '9',
      expect.objectContaining({ bodyText: 'New' })
    );
  });

  it('rejects an unknown tool', async () => {
    await expect(
      runTool({ connectionId: confluenceConnectionId, inputs: {}, tool: 'deletePage' })
    ).rejects.toThrow('Unsupported Confluence tool');
  });

  it('forwards a caller-supplied version rather than refreshing it', async () => {
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 8,
    });

    await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'Draft', pageId: '9', version: 7 },
      tool: 'updatePage',
    });

    expect(updateConfluencePage).toHaveBeenCalledWith(
      expect.anything(),
      '9',
      expect.objectContaining({ bodyText: 'Draft', version: 7 })
    );
  });

  it('refuses a version that is not a positive whole number', async () => {
    await expect(
      runTool({
        connectionId: confluenceConnectionId,
        inputs: { bodyText: 'Draft', pageId: '9', version: 0 },
        tool: 'updatePage',
      })
    ).rejects.toThrow('positive whole number');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });
});

describe('runTool approval guard', () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  beforeEach(() => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1' });
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
  });

  it('refuses a mutating tool when the policy required approval and none was recorded', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'external_write',
      })
      .mockResolvedValueOnce(null);

    // `runTool` used to bypass the gate `writeOutcome` applies, so a template that
    // recorded "approval required" and then wrote through a tool published anyway.
    await expect(
      runTool({
        connectionId: confluenceConnectionId,
        inputs: { bodyText: 'Draft', pageId: '9' },
        tool: 'updatePage',
      })
    ).rejects.toThrow('requires human approval');
    expect(updateConfluencePage).not.toHaveBeenCalled();
  });

  it('writes through a tool when an approval was recorded', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: publishedAt,
        payload: { decision: 'require_approval' },
      })
      .mockResolvedValueOnce({ id: 'approval-1' });
    (updateConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '9',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 2,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { bodyText: 'Draft', pageId: '9' },
      tool: 'updatePage',
    });
    expect(result.ok).toBe(true);
  });

  it('does not gate a read tool', async () => {
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      createdAt: publishedAt,
      payload: { decision: 'require_approval' },
      policyName: 'default',
    });
    (readConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      bodyText: 'Body',
      id: '9',
      title: 'Runbook',
      url: 'https://x.atlassian.net/wiki/pages/9',
      version: 1,
    });

    const result = await runTool({
      connectionId: confluenceConnectionId,
      inputs: { pageId: '9' },
      tool: 'fetchPage',
    });

    expect(result.ok).toBe(true);
    // The gate is not consulted at all for a read: a run whose policy demanded
    // approval for a write has not asked for one to look a page up.
    expect(prisma.autonomyDecision.findFirst).not.toHaveBeenCalled();
  });
});

describe('refusals before the provider call leave no claim', () => {
  const NOTION = '4dcf895a-9ed7-450c-8858-e45b8415db4b';
  const ZENDESK = 'e9108636-3b75-440c-a4f9-987449669502';
  const writeArgs = { connectionId: NOTION, data: { text: 'hi' }, nodeId: 'node-1' };

  beforeEach(() => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorizedConnectionIds: [NOTION, ZENDESK],
      id: 'run-1',
    });
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('notion', { token: true })
    );
  });

  it('writeOutcome: an inactive connection is refused before the claim', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: false,
      type: 'notion',
    });

    await expect(writeOutcome(writeArgs)).rejects.toThrow('not found or inactive');
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('writeOutcome: a connection the run may not use is refused before the claim', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorizedConnectionIds: [],
      id: 'run-1',
    });

    await expect(writeOutcome(writeArgs)).rejects.toThrow();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('writeOutcome: an unsupported connection type is refused before the claim', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('carrier_pigeon', { token: true })
    );

    await expect(writeOutcome(writeArgs)).rejects.toThrow('no implementation for carrier_pigeon');
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('writeOutcome: returns a recorded result even when the connection is now inactive', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: false,
      type: 'notion',
    });
    (prisma.workflowOutcomeReference.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: { connectionType: 'notion', ok: true, reference: 'stored' },
      state: 'DONE',
    });

    await expect(writeOutcome(writeArgs)).resolves.toEqual({
      connectionType: 'notion',
      ok: true,
      reference: 'stored',
    });
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('writeOutcome: a connector payload refusal releases the claim it took', async () => {
    await expect(writeOutcome({ ...writeArgs, data: {} })).rejects.toThrow(
      'Notion writeOutcome data must include'
    );
    expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledTimes(1);
    expect(prisma.workflowOutcomeReference.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('runTool: an inactive connection is refused before the claim', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: false,
      type: 'zendesk',
    });

    await expect(
      runTool({ connectionId: ZENDESK, inputs: {}, nodeId: 'node-1', tool: 'postComment' })
    ).rejects.toThrow('not found or inactive');
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('runTool: an unsupported tool name releases the claim it took', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );

    await expect(
      runTool({ connectionId: ZENDESK, inputs: {}, nodeId: 'node-1', tool: 'explode' })
    ).rejects.toThrow('Unsupported Zendesk tool');
    expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledTimes(1);
    expect(prisma.workflowOutcomeReference.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('runTool: a mutating tool without a nodeId is still refused without approval', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('zendesk', { config: { email: 'a@b.com', subdomain: 'x' }, token: true })
    );
    (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        createdAt: new Date('2026-01-01T00:00:00Z'),
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'external_communication',
      })
      .mockResolvedValueOnce(null);

    await expect(
      runTool({
        connectionId: ZENDESK,
        inputs: { body: 'x', ticketId: '42' },
        tool: 'postComment',
      })
    ).rejects.toHaveProperty('type', 'APPROVAL_REQUIRED');
    expect(postZendeskComment).not.toHaveBeenCalled();
  });

  it('runTool: confluence updatePage input and unknown-tool refusals release the claim', async () => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { token: true })
    );
    for (const [tool, message] of [
      ['updatePage', 'updatePage requires'],
      ['explode', 'Unsupported Confluence tool'],
    ] as const) {
      vi.mocked(prisma.workflowOutcomeReference.create).mockClear();
      vi.mocked(prisma.workflowOutcomeReference.deleteMany).mockClear();
      await expect(
        runTool({ connectionId: ZENDESK, inputs: {}, nodeId: 'node-1', tool })
      ).rejects.toThrow(message);
      expect(prisma.workflowOutcomeReference.create).toHaveBeenCalledTimes(1);
      expect(prisma.workflowOutcomeReference.deleteMany).toHaveBeenCalledTimes(1);
    }
  });
});

describe('confluence writeOutcome: review comments', () => {
  const pageUrl = 'https://x.atlassian.net/wiki/pages/9';
  beforeEach(() => {
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('confluence', { config: confluenceConfig, token: true })
    );
    (readConfluencePage as ReturnType<typeof vi.fn>).mockResolvedValue({
      bodyText: 'Goals\nShip fast.\nThe API is fast. The API is cheap.',
      id: '9',
      title: 'Doc',
      url: pageUrl,
      version: 2,
    });
    (createConfluenceInlineComment as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (createConfluenceFooterComment as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c2' });
  });

  it('anchors a comment to a passage that is on the page, and counts how often it appears', async () => {
    const result = await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { comments: [{ body: '[major] vague', quote: 'The API' }], pageId: '9' },
    });

    expect(createConfluenceInlineComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bodyText: '[major] vague',
        matchCount: 2,
        matchIndex: 0,
        pageId: '9',
        textSelection: 'The API',
      })
    );
    expect(createConfluenceFooterComment).not.toHaveBeenCalled();
    expect(result).toEqual({
      comments: { footer: 0, inline: 1 },
      connectionType: 'confluence',
      ok: true,
      reference: pageUrl,
    });
  });

  it('puts a comment with no quote, or a quote that is not on the page, at the foot of the page', async () => {
    const result = await writeOutcome({
      connectionId: confluenceConnectionId,
      data: {
        comments: [
          { body: 'Automated review: not ready.', quote: '' },
          { body: '[minor] missing', quote: 'text the page does not have' },
        ],
        pageId: '9',
      },
    });

    expect(createConfluenceInlineComment).not.toHaveBeenCalled();
    expect(createConfluenceFooterComment).toHaveBeenNthCalledWith(1, expect.anything(), {
      bodyText: 'Automated review: not ready.',
      pageId: '9',
    });
    expect(createConfluenceFooterComment).toHaveBeenNthCalledWith(2, expect.anything(), {
      bodyText: '[minor] missing\n"text the page does not have"',
      pageId: '9',
    });
    expect(result.comments).toEqual({ footer: 2, inline: 0 });
  });

  it('falls back to a footer comment when Confluence refuses the anchor, and keeps the passage', async () => {
    (createConfluenceInlineComment as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('refused'), { nonRetryable: true })
    );
    const result = await writeOutcome({
      connectionId: confluenceConnectionId,
      data: { comments: [{ body: '[major] vague', quote: 'Ship fast.' }], pageId: '9' },
    });

    expect(createConfluenceFooterComment).toHaveBeenCalledWith(expect.anything(), {
      bodyText: '[major] vague\n"Ship fast."',
      pageId: '9',
    });
    expect(result.comments).toEqual({ footer: 1, inline: 0 });
  });

  it('does not swallow an outage: a transient failure is thrown for the ledger to handle', async () => {
    (createConfluenceInlineComment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Confluence API transient error (503)')
    );
    await expect(
      writeOutcome({
        connectionId: confluenceConnectionId,
        data: { comments: [{ body: 'x', quote: 'Ship fast.' }], pageId: '9' },
      })
    ).rejects.toThrow('transient');
    expect(createConfluenceFooterComment).not.toHaveBeenCalled();
  });

  it('refuses comments with no page, an empty list, or an entry with no body, before reading the page', async () => {
    for (const data of [
      { comments: [{ body: 'x', quote: '' }] },
      { comments: [], pageId: '9' },
      { comments: [{ body: '  ', quote: '' }], pageId: '9' },
      { comments: 'not a list', pageId: '9' },
    ]) {
      await expect(writeOutcome({ connectionId: confluenceConnectionId, data })).rejects.toThrow(
        /comments/
      );
    }
    expect(readConfluencePage).not.toHaveBeenCalled();
  });
});

describe('issue_tracker writeOutcome: ticket plan', () => {
  const trackerConnectionId = 'bd4483f7-1fcc-4abe-916c-deab2811a4dc';
  const plan = {
    epic: { description: 'Deliver the thing', title: 'The thing' },
    rationale: 'Two tickets',
    tickets: [
      {
        acceptanceCriteria: ['It works'],
        description: 'Build A',
        subtasks: [{ description: 'Design A', title: 'Design A' }],
        title: 'A',
      },
      { description: 'Build B', title: 'B' },
    ],
  };
  let n = 0;
  beforeEach(() => {
    n = 0;
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConnection('issue_tracker', {
        config: { baseUrl: 'https://jira.example.com', defaultProjectKey: 'ENG', provider: 'jira' },
        token: true,
      })
    );
    (createIssue as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      n++;
      return {
        id: `id-${n}`,
        identifier: `ENG-${n}`,
        url: `https://jira.example.com/browse/ENG-${n}`,
      };
    });
  });

  it('creates the epic, a ticket under it for each entry, and a sub-task under its ticket', async () => {
    const result = await writeOutcome({
      connectionId: trackerConnectionId,
      data: { plan, projectKey: 'PAY' },
    });

    const calls = (createIssue as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls).toEqual([
      expect.objectContaining({ issueType: 'Epic', projectKey: 'PAY', title: 'The thing' }),
      expect.objectContaining({
        description: 'Build A\n\nAcceptance criteria:\n- It works',
        issueType: 'Story',
        parentId: 'ENG-1',
        title: 'A',
      }),
      expect.objectContaining({ issueType: 'Sub-task', parentId: 'ENG-2', title: 'Design A' }),
      expect.objectContaining({ issueType: 'Story', parentId: 'ENG-1', title: 'B' }),
    ]);
    expect(result).toEqual({
      connectionType: 'issue_tracker',
      ok: true,
      reference: 'https://jira.example.com/browse/ENG-1',
      references: [1, 2, 3, 4].map((i) => `https://jira.example.com/browse/ENG-${i}`),
    });
  });

  it('takes the issue type names from the request, and treats blank ones as unset', async () => {
    await writeOutcome({
      connectionId: trackerConnectionId,
      data: {
        epicIssueType: 'Initiative',
        plan,
        projectKey: '',
        storyIssueType: '',
        subtaskIssueType: 'Subtask',
      },
    });
    const calls = (createIssue as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls.map((c) => c.issueType)).toEqual(['Initiative', 'Story', 'Subtask', 'Story']);
    // A blank project key falls back to the connection's default, not an empty string.
    expect(calls[0].projectKey).toBe('ENG');
  });

  it("stops at the first failure and names what was created, without the tracker's own text", async () => {
    (createIssue as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'id-1',
        identifier: 'ENG-1',
        url: 'https://jira.example.com/browse/ENG-1',
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Jira API error (400): secret internal detail'), {
          nonRetryable: true,
        })
      );

    const failure = await writeOutcome({
      connectionId: trackerConnectionId,
      data: { plan },
    }).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'The tracker refused the ticket after 1 issue(s) were created (ENG-1).'
    );
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it('refuses a plan that does not match the shape, before creating anything', async () => {
    for (const bad of [
      'a string',
      { epic: { title: 'x' }, tickets: [] },
      { epic: { title: '' }, tickets: [{ title: 'a' }] },
      { epic: { title: 'x' }, tickets: [{ subtasks: [{ title: '' }], title: 'a' }] },
    ]) {
      await expect(
        writeOutcome({ connectionId: trackerConnectionId, data: { plan: bad } })
      ).rejects.toThrow('ticket plan shape');
    }
    expect(createIssue).not.toHaveBeenCalled();
  });
});

// ── http_api / hubspot / mcp / notion tools ─────────────────────────────────

const GENERIC = '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5';
const connectionMock = () => prisma.connection.findUnique as ReturnType<typeof vi.fn>;
const claimMock = () => prisma.workflowOutcomeReference.create as ReturnType<typeof vi.fn>;
const httpMock = () => httpApiRequest as ReturnType<typeof vi.fn>;
const mcpMock = () => callMcpConnectionTool as ReturnType<typeof vi.fn>;

/** A refusal may claim and release; what matters is that no PENDING row stays behind. */
function expectNoClaimRemains() {
  expect(prisma.workflowOutcomeReference.deleteMany).toHaveBeenCalledTimes(
    claimMock().mock.calls.length
  );
}

function useConnection(type: string, options?: { config?: unknown; token?: boolean }) {
  connectionMock().mockResolvedValue(makeConnection(type, options));
}

describe('http_api steps', () => {
  beforeEach(() => {
    useConnection('http_api', { token: true });
    httpMock().mockResolvedValue({ body: { a: 1 }, headers: {}, status: 200 });
  });

  it('readSource sends a GET and returns status and body', async () => {
    const result = await readSource({
      connectionId: GENERIC,
      query: { path: '/v1/items', query: { limit: 5 } },
    });
    expect(httpMock()).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'test-token' }),
      { method: 'GET', path: '/v1/items', query: { limit: 5 } },
      { signal: undefined }
    );
    expect(result).toEqual({
      connectionType: 'http_api',
      data: { body: { a: 1 }, status: 200 },
      ok: true,
    });
  });

  it('readSource reports a truncated body', async () => {
    httpMock().mockResolvedValue({ body: 'xx', headers: {}, status: 200, truncated: true });
    const result = await readSource({ connectionId: GENERIC, query: { path: '/x' } });
    expect(result.data).toEqual({ body: 'xx', status: 200, truncated: true });
  });

  it('readSource refuses a query without a path before any request', async () => {
    await expect(readSource({ connectionId: GENERIC, query: {} })).rejects.toThrow(
      'http_api readSource query'
    );
    expect(httpMock()).not.toHaveBeenCalled();
  });

  it('readSource refuses per-request headers: a read is ungoverned', async () => {
    await expect(
      readSource({
        connectionId: GENERIC,
        query: { headers: { 'x-a': 'b' }, path: '/v1/items' },
      })
    ).rejects.toThrow('http_api readSource query');
    expect(httpMock()).not.toHaveBeenCalled();
  });

  it('writeOutcome defaults to POST and references the status', async () => {
    const result = await writeOutcome({
      connectionId: GENERIC,
      data: { body: { n: 1 }, path: '/v1/items' },
    });
    expect(httpMock()).toHaveBeenCalledWith(
      expect.anything(),
      { body: { n: 1 }, method: 'POST', path: '/v1/items' },
      { signal: undefined }
    );
    expect(result).toEqual({
      connectionType: 'http_api',
      ok: true,
      reference: '200',
      response: { body: { a: 1 }, status: 200 },
    });
  });

  it('writeOutcome prefers the Location header as the reference', async () => {
    httpMock().mockResolvedValue({
      body: null,
      headers: { location: 'https://api.example.com/v1/items/9' },
      status: 201,
    });
    const result = await writeOutcome({
      connectionId: GENERIC,
      data: { method: 'PUT', path: '/v1/items' },
    });
    expect(result.reference).toBe('https://api.example.com/v1/items/9');
  });

  it('writeOutcome refuses GET, leaving no ledger claim', async () => {
    await expect(
      writeOutcome({
        connectionId: GENERIC,
        data: { method: 'GET', path: '/v1/items' },
        nodeId: 'n1',
      })
    ).rejects.toThrow('http_api writeOutcome data');
    expect(httpMock()).not.toHaveBeenCalled();
    expectNoClaimRemains();
  });

  it('writeOutcome claims the ledger for a valid write', async () => {
    await writeOutcome({ connectionId: GENERIC, data: { path: '/v1/items' }, nodeId: 'n1' });
    expect(claimMock()).toHaveBeenCalledTimes(1);
  });

  it('runTool request allows GET and returns the shaped response', async () => {
    const result = await runTool({
      connectionId: GENERIC,
      inputs: { method: 'GET', path: '/v1/items' },
      tool: 'request',
    });
    expect(result).toEqual({
      connectionType: 'http_api',
      ok: true,
      output: { body: { a: 1 }, status: 200 },
    });
  });

  it('runTool request is governed as a mutation even for GET', async () => {
    await runTool({
      connectionId: GENERIC,
      inputs: { method: 'GET', path: '/v1/items' },
      nodeId: 'n1',
      tool: 'request',
    });
    expect(claimMock()).toHaveBeenCalledTimes(1);
  });

  it('runTool refuses another tool name and a bad method, leaving no claim', async () => {
    await expect(
      runTool({ connectionId: GENERIC, inputs: {}, nodeId: 'n1', tool: 'delete' })
    ).rejects.toThrow('Unsupported http_api tool: delete');
    await expect(
      runTool({
        connectionId: GENERIC,
        inputs: { method: 'TRACE', path: '/x' },
        nodeId: 'n1',
        tool: 'request',
      })
    ).rejects.toThrow('http_api request inputs');
    expect(httpMock()).not.toHaveBeenCalled();
    expectNoClaimRemains();
  });
});

describe('hubspot steps', () => {
  const record = { id: '77', properties: { email: 'a@b.c' } };

  beforeEach(() => {
    useConnection('hubspot', { token: true });
    (fetchHubSpotRecord as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    (createHubSpotRecord as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    (updateHubSpotRecord as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    (searchHubSpotRecords as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [record],
      total: 1,
    });
  });

  it('readSource fetches a record by id', async () => {
    const result = await readSource({
      connectionId: GENERIC,
      query: { objectId: '77', objectType: 'contacts', properties: ['email'] },
    });
    expect(fetchHubSpotRecord).toHaveBeenCalledWith(
      { apiToken: 'test-token' },
      { objectId: '77', objectType: 'contacts', properties: ['email'] },
      {}
    );
    expect(result).toEqual({ connectionType: 'hubspot', data: record, ok: true });
  });

  it('readSource searches', async () => {
    const result = await readSource({
      connectionId: GENERIC,
      query: { objectType: 'contacts', search: { query: 'ann' } },
    });
    expect(searchHubSpotRecords).toHaveBeenCalledWith(
      { apiToken: 'test-token' },
      { objectType: 'contacts', query: 'ann' },
      {}
    );
    expect(result.data).toEqual({ results: [record], total: 1 });
  });

  it('readSource refuses a query with neither objectId nor search', async () => {
    await expect(
      readSource({ connectionId: GENERIC, query: { objectType: 'contacts' } })
    ).rejects.toThrow('hubspot readSource query');
    expect(fetchHubSpotRecord).not.toHaveBeenCalled();
  });

  it('writeOutcome creates without an objectId and references the record id', async () => {
    const result = await writeOutcome({
      connectionId: GENERIC,
      data: { objectType: 'contacts', properties: { email: 'a@b.c' } },
    });
    expect(createHubSpotRecord).toHaveBeenCalled();
    expect(updateHubSpotRecord).not.toHaveBeenCalled();
    expect(result).toEqual({ connectionType: 'hubspot', ok: true, reference: '77' });
  });

  it('writeOutcome updates with an objectId', async () => {
    await writeOutcome({
      connectionId: GENERIC,
      data: { objectId: '77', objectType: 'contacts', properties: { phone: '1' } },
    });
    expect(updateHubSpotRecord).toHaveBeenCalledWith(
      { apiToken: 'test-token' },
      { objectId: '77', objectType: 'contacts', properties: { phone: '1' } },
      {}
    );
  });

  it('writeOutcome refuses missing properties, leaving no claim', async () => {
    await expect(
      writeOutcome({ connectionId: GENERIC, data: { objectType: 'contacts' }, nodeId: 'n1' })
    ).rejects.toThrow('hubspot writeOutcome data');
    expectNoClaimRemains();
  });

  it('runTool: fetchRecord and searchRecords are reads and take no claim', async () => {
    await runTool({
      connectionId: GENERIC,
      inputs: { objectId: '77', objectType: 'contacts' },
      nodeId: 'n1',
      tool: 'fetchRecord',
    });
    await runTool({
      connectionId: GENERIC,
      inputs: { objectType: 'contacts', query: 'ann' },
      nodeId: 'n2',
      tool: 'searchRecords',
    });
    expectNoClaimRemains();
  });

  it('runTool: createRecord and updateRecord are governed writes', async () => {
    await runTool({
      connectionId: GENERIC,
      inputs: { objectType: 'contacts', properties: { a: 'b' } },
      nodeId: 'n1',
      tool: 'createRecord',
    });
    await runTool({
      connectionId: GENERIC,
      inputs: { objectId: '77', objectType: 'contacts', properties: { a: 'b' } },
      nodeId: 'n2',
      tool: 'updateRecord',
    });
    expect(createHubSpotRecord).toHaveBeenCalledTimes(1);
    expect(updateHubSpotRecord).toHaveBeenCalledTimes(1);
    expect(claimMock()).toHaveBeenCalledTimes(2);
  });

  it('runTool: an unknown tool is refused naming it, with no claim', async () => {
    await expect(
      runTool({ connectionId: GENERIC, inputs: {}, nodeId: 'n1', tool: 'deleteRecord' })
    ).rejects.toThrow('Unsupported hubspot tool: deleteRecord');
    expectNoClaimRemains();
  });
});

describe('mcp steps', () => {
  beforeEach(() => {
    useConnection('mcp');
    mcpMock().mockResolvedValue({ readOnly: true, result: { content: [{ text: 'ok' }] } });
  });

  it('readSource calls the core read-only', async () => {
    const result = await readSource({
      connectionId: GENERIC,
      query: { inputs: { id: 1 }, tool: 'get_thing' },
    });
    expect(mcpMock()).toHaveBeenCalledWith({
      connectionId: GENERIC,
      inputs: { id: 1 },
      mode: 'readOnly',
      step: 'readSource',
      tool: 'get_thing',
    });
    expect(result).toEqual({
      connectionType: 'mcp',
      data: { content: [{ text: 'ok' }] },
      ok: true,
    });
  });

  it('readSource fails on isError without echoing the result text', async () => {
    mcpMock().mockResolvedValue({
      readOnly: true,
      result: { content: [{ text: 'SECRET-DETAIL' }], isError: true },
    });
    const err = await readSource({ connectionId: GENERIC, query: { tool: 'get_thing' } }).catch(
      (e) => e
    );
    expect(err.message).toBe('MCP tool get_thing reported an error');
  });

  it('readSource refuses a query without a tool', async () => {
    await expect(readSource({ connectionId: GENERIC, query: {} })).rejects.toThrow(
      'mcp readSource query'
    );
    expect(mcpMock()).not.toHaveBeenCalled();
  });

  it('writeOutcome calls the core as mutating and never claims the ledger itself', async () => {
    const result = await writeOutcome({
      connectionId: GENERIC,
      data: { inputs: { a: 1 }, tool: 'create_thing' },
      nodeId: 'n1',
    });
    expect(mcpMock()).toHaveBeenCalledWith({
      connectionId: GENERIC,
      inputs: { a: 1 },
      mode: 'mutating',
      nodeId: 'n1',
      step: 'writeOutcome',
      tool: 'create_thing',
    });
    expectNoClaimRemains();
    expect(prisma.workflowOutcomeReference.findFirst).not.toHaveBeenCalled();
    expect(result.reference).toBe('create_thing');
    expect(result.response).toEqual({ content: [{ text: 'ok' }] });
  });

  it('writeOutcome still applies the run pin check', async () => {
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorizedConnectionIds: [],
      id: 'run-1',
    });
    await expect(
      writeOutcome({ connectionId: GENERIC, data: { tool: 't' }, nodeId: 'n1' })
    ).rejects.toThrow();
    expect(mcpMock()).not.toHaveBeenCalled();
  });

  it('writeOutcome fails on isError, including when the core replays a recorded result', async () => {
    mcpMock().mockResolvedValue({ readOnly: false, result: { isError: true } });
    await expect(
      writeOutcome({ connectionId: GENERIC, data: { tool: 'create_thing' }, nodeId: 'n1' })
    ).rejects.toThrow('MCP tool create_thing reported an error');
  });

  it('runTool delegates in auto mode and never claims the ledger itself', async () => {
    const result = await runTool({
      connectionId: GENERIC,
      inputs: { a: 1 },
      nodeId: 'n1',
      tool: 'create_thing',
    });
    expect(mcpMock()).toHaveBeenCalledWith({
      connectionId: GENERIC,
      inputs: { a: 1 },
      mode: 'auto',
      nodeId: 'n1',
      step: 'runTool',
      tool: 'create_thing',
    });
    expectNoClaimRemains();
    expect(result).toEqual({
      connectionType: 'mcp',
      ok: true,
      output: { content: [{ text: 'ok' }] },
    });
  });

  it('runTool: a tool named fetchPage is classified by the core, not by its name', async () => {
    await runTool({ connectionId: GENERIC, inputs: {}, nodeId: 'n1', tool: 'fetchPage' });
    expect(mcpMock()).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'auto', nodeId: 'n1', tool: 'fetchPage' })
    );
    // The name-based read-only set is not consulted: no approval lookup runs here either,
    // because the core owns it.
    expect(prisma.autonomyDecision.findFirst).not.toHaveBeenCalled();
  });

  it('refuses non-object inputs before calling the core, in all three steps', async () => {
    await expect(
      runTool({ connectionId: GENERIC, inputs: [1], nodeId: 'n1', tool: 't' })
    ).rejects.toMatchObject({ type: 'NOT_SENT' });
    await expect(
      runTool({ connectionId: GENERIC, inputs: 'x', nodeId: 'n1', tool: 't' })
    ).rejects.toMatchObject({ type: 'NOT_SENT' });
    await expect(
      readSource({ connectionId: GENERIC, query: { inputs: [1], tool: 't' } })
    ).rejects.toMatchObject({ type: 'NOT_SENT' });
    await expect(
      writeOutcome({ connectionId: GENERIC, data: { inputs: 'x', tool: 't' }, nodeId: 'n1' })
    ).rejects.toMatchObject({ type: 'NOT_SENT' });
    expect(mcpMock()).not.toHaveBeenCalled();
  });

  it('runTool fails on isError', async () => {
    mcpMock().mockResolvedValue({ readOnly: false, result: { isError: true } });
    await expect(
      runTool({ connectionId: GENERIC, inputs: {}, nodeId: 'n1', tool: 'create_thing' })
    ).rejects.toThrow('MCP tool create_thing reported an error');
  });
});

describe('notion runTool', () => {
  beforeEach(() => {
    useConnection('notion', {
      config: { sourcePageId: '0123456789abcdef0123456789abcdef' },
      token: true,
    });
    (readNotionPage as ReturnType<typeof vi.fn>).mockResolvedValue({ blocks: [], page: {} });
    (createNotionPage as ReturnType<typeof vi.fn>).mockResolvedValue({ pageId: 'p', url: 'u' });
    (appendNotionBlocks as ReturnType<typeof vi.fn>).mockResolvedValue({
      appended: 1,
      pageId: '0123456789abcdef0123456789abcdef',
    });
  });

  it('fetchPage reads without a claim', async () => {
    const result = await runTool({
      connectionId: GENERIC,
      inputs: { pageId: '0123456789abcdef0123456789abcdef' },
      nodeId: 'n1',
      tool: 'fetchPage',
    });
    expect(readNotionPage).toHaveBeenCalledWith(
      { apiToken: 'test-token' },
      '0123456789abcdef0123456789abcdef'
    );
    expect(result.connectionType).toBe('notion');
    expectNoClaimRemains();
  });

  it('createPage is a governed write', async () => {
    const result = await runTool({
      connectionId: GENERIC,
      inputs: { title: 'T' },
      nodeId: 'n1',
      tool: 'createPage',
    });
    expect(createNotionPage).toHaveBeenCalledWith(
      { apiToken: 'test-token' },
      { pageId: '0123456789abcdef0123456789abcdef', title: 'T' }
    );
    expect(result.output).toEqual({ pageId: 'p', url: 'u' });
    expect(claimMock()).toHaveBeenCalledTimes(1);
  });

  it('appendBlocks falls back to the default page', async () => {
    await runTool({
      connectionId: GENERIC,
      inputs: { blocks: [{ type: 'paragraph' }] },
      nodeId: 'n1',
      tool: 'appendBlocks',
    });
    expect(appendNotionBlocks).toHaveBeenCalledWith(
      { apiToken: 'test-token' },
      '0123456789abcdef0123456789abcdef',
      [{ type: 'paragraph' }]
    );
  });

  it('refuses bad inputs and unknown tools with no claim', async () => {
    await expect(
      runTool({ connectionId: GENERIC, inputs: { blocks: [] }, nodeId: 'n1', tool: 'appendBlocks' })
    ).rejects.toThrow('appendBlocks inputs');
    await expect(
      runTool({ connectionId: GENERIC, inputs: {}, nodeId: 'n1', tool: 'deletePage' })
    ).rejects.toThrow('Unsupported Notion tool: deletePage');
    expectNoClaimRemains();
  });
});

describe('GENERIC_STEP_CONNECTION_TYPES is the one source of which pairs act', () => {
  type StepName = 'readSource' | 'writeOutcome' | 'runTool';
  const calls: Record<StepName, () => Promise<unknown>> = {
    readSource: () => readSource({ connectionId: GENERIC, query: {} }),
    runTool: () => runTool({ connectionId: GENERIC, inputs: {}, nodeId: 'n1', tool: 'anything' }),
    writeOutcome: () => writeOutcome({ connectionId: GENERIC, data: { a: 1 }, nodeId: 'n1' }),
  };
  const steps = Object.keys(GENERIC_STEP_CONNECTION_TYPES) as StepName[];
  const failureOf = (call: () => Promise<unknown>) =>
    call().then(
      () => null,
      (e: Error & { type?: string }) => e
    );

  const pairs = steps.flatMap((step) =>
    [...CONNECTION_TYPES, 'not_a_type'].map((type): [StepName, string, boolean] => [
      step,
      type,
      (GENERIC_STEP_CONNECTION_TYPES[step] as readonly string[]).includes(type),
    ])
  );

  it.each(pairs.filter(([, , listed]) => !listed))(
    '%s on a %s connection fails non-retryably with CONNECTOR_NOT_IMPLEMENTED',
    async (step, type) => {
      useConnection(type, { token: true });
      // With a nodeId, a run in scope and no approval required, a claim would be possible.
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'run-1',
      });
      (prisma.autonomyDecision.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const failure = await failureOf(calls[step]);
      expect(failure).not.toBeNull();
      expect((failure as { nonRetryable?: boolean }).nonRetryable).toBe(true);
      expect(failure?.type).toBe('CONNECTOR_NOT_IMPLEMENTED');
      expect(failure?.message).toContain(`${step} has no implementation for ${type}`);
      // Nothing was claimed, so a retry-ambiguity row cannot be left behind.
      expect(claimMock()).not.toHaveBeenCalled();
    }
  );

  it.each(pairs.filter(([, , listed]) => listed))(
    '%s on a %s connection has a handler',
    async (step, type) => {
      useConnection(type, { token: true });
      // The connectors are mocked and return nothing, so a handler may fail on that; what it
      // must not do is report the pair as having no implementation.
      const failure = await failureOf(calls[step]);
      expect(failure?.type).not.toBe('CONNECTOR_NOT_IMPLEMENTED');
    }
  );

  it('names the engineering activities for git_repo', async () => {
    useConnection('git_repo');
    const failure = await failureOf(calls.readSource);
    expect(failure?.message).toContain('engineering activities');
  });
});
