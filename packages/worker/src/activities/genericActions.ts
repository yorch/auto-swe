import {
  type ConnectionType,
  decryptConnectionApiToken,
  type Prisma,
  parseConfluenceConnectionConfig,
  parseIssueTrackerConnectionConfig,
  parseNotionConnectionConfig,
  parseSlackConnectionConfig,
  parseZendeskConnectionConfig,
} from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { z } from 'zod';
import {
  createConfluencePage,
  readConfluencePage,
  updateConfluencePage,
} from '../connectors/confluence.js';
import { createIssue, fetchIssue } from '../connectors/issueTracker.js';
import {
  appendNotionBlocks,
  createNotionPage,
  type NotionBlock,
  readNotionPage,
} from '../connectors/notion.js';
import { postSlackMessage } from '../connectors/slack.js';
import { fetchZendeskTicket, postZendeskComment } from '../connectors/zendesk.js';

const ConnectionIdSchema = z.string().uuid();
const ToolNameSchema = z.string().min(1);

/**
 * Connection tools that only read.
 *
 * `runTool` names its tool as a string, so nothing in the type system says
 * whether it writes. Everything not listed here is treated as a mutation and has
 * to satisfy the same approval gate `writeOutcome` does — a new tool is gated by
 * default rather than by someone remembering to gate it. Reading is not gated: a
 * run whose policy demanded approval for a write has still not asked for one to
 * look a ticket up.
 */
const READ_ONLY_CONNECTION_TOOLS: ReadonlySet<string> = new Set([
  'fetchIssue',
  'fetchPage',
  'fetchTicket',
]);

function validateInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable(
      `Invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`
    );
  }
  return parsed.data;
}

/**
 * Generic read/write/tool activities parameterised by connection type.
 *
 * These are the foundation for non-SWE templates. Each handler is responsible
 * for loading its Connection, decrypting the API token, and producing a
 * structured result. For Phase 1 the non-git handlers are placeholders that
 * validate the connection and surface its metadata; concrete API calls land in
 * the domain-specific activity packs.
 */

export interface ReadSourceInput {
  connectionId: string;
  query?: unknown;
}

export interface ReadSourceResult {
  connectionType: ConnectionType;
  data?: unknown;
  ok: boolean;
  placeholder?: boolean;
}

export interface WriteOutcomeInput {
  connectionId: string;
  data: unknown;
  /** Spec node id that produced this outcome (for idempotency ledger). */
  nodeId?: string;
}

export interface WriteOutcomeResult {
  connectionType: ConnectionType;
  ok: boolean;
  placeholder?: boolean;
  reference?: string;
}

export interface RunToolInput {
  connectionId: string;
  inputs?: unknown;
  tool: string;
}

export interface RunToolResult {
  connectionType: ConnectionType;
  ok: boolean;
  output?: unknown;
  placeholder?: boolean;
}

async function loadConnection(connectionId: string) {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });
  if (!connection?.isActive) {
    throw ApplicationFailure.nonRetryable(`Connection ${connectionId} not found or inactive`);
  }
  return connection;
}

function getApiToken(connection: {
  apiKeyAuthTag: Buffer | Uint8Array | null;
  apiKeyCiphertext: Buffer | Uint8Array | null;
  apiKeyNonce: Buffer | Uint8Array | null;
  apiKeyVersion: number;
}): string | null {
  if (!connection.apiKeyCiphertext || !connection.apiKeyNonce || !connection.apiKeyAuthTag) {
    return null;
  }
  return decryptConnectionApiToken({
    apiKeyAuthTag: connection.apiKeyAuthTag,
    apiKeyCiphertext: connection.apiKeyCiphertext,
    apiKeyNonce: connection.apiKeyNonce,
    apiKeyVersion: connection.apiKeyVersion,
  });
}

/**
 * The `WorkflowRun` row for the executing workflow, or null when the workflow
 * keeps none. Read by the approval gate: a recorded `require_approval` decision
 * refuses a mutation whether it goes through `writeOutcome` or `runTool`.
 */
async function currentRun(): Promise<{ id: string } | null> {
  const workflowId = Context.current().info.workflowExecution?.workflowId;
  if (!workflowId) {
    return null;
  }
  return prisma.workflowRun.findUnique({ select: { id: true }, where: { workflowId } });
}

// ── Read source ─────────────────────────────────────────────────────────────

async function gitRepoReadSource(_connection: unknown, query: unknown): Promise<ReadSourceResult> {
  const q = typeof query === 'object' && query != null ? query : {};
  return {
    connectionType: 'git_repo',
    data: {
      hint: 'Use the SWE activities (executeImplementation, shellStep) for git_repo work',
      query: q,
    },
    ok: true,
    placeholder: true,
  };
}

function requireToken(token: string | null): string {
  if (!token) {
    throw ApplicationFailure.nonRetryable('Connection API token is required');
  }
  return token;
}

async function notionReadSource(
  connection: { config: unknown },
  token: string | null,
  query: unknown
): Promise<ReadSourceResult> {
  const config = parseNotionConnectionConfig(connection.config);
  const requestedPageId =
    (typeof query === 'object' && query != null && (query as Record<string, unknown>).pageId) ||
    config.sourcePageId;
  if (typeof requestedPageId !== 'string') {
    throw ApplicationFailure.nonRetryable(
      'Notion readSource requires a pageId in query or connection config'
    );
  }
  const content = await readNotionPage({ apiToken: requireToken(token) }, requestedPageId);
  return { connectionType: 'notion', data: content, ok: true };
}

async function zendeskReadSource(
  connection: { config: unknown },
  token: string | null,
  query: unknown
): Promise<ReadSourceResult> {
  const requestedTicketId =
    typeof query === 'object' && query != null
      ? (query as Record<string, unknown>).ticketId
      : undefined;
  if (typeof requestedTicketId !== 'string') {
    throw ApplicationFailure.nonRetryable('Zendesk readSource requires a ticketId in query');
  }
  const result = await fetchZendeskTicket(
    { apiToken: requireToken(token), config: parseZendeskConnectionConfig(connection.config) },
    requestedTicketId
  );
  return { connectionType: 'zendesk', data: result, ok: true };
}

async function issueTrackerReadSource(
  connection: { config: unknown },
  token: string | null,
  query: unknown
): Promise<ReadSourceResult> {
  const requestedIssueId =
    typeof query === 'object' && query != null
      ? (query as Record<string, unknown>).issueId
      : undefined;
  if (typeof requestedIssueId !== 'string') {
    throw ApplicationFailure.nonRetryable('issue_tracker readSource requires an issueId in query');
  }
  const result = await fetchIssue(
    { apiToken: requireToken(token), config: parseIssueTrackerConnectionConfig(connection.config) },
    requestedIssueId
  );
  return { connectionType: 'issue_tracker', data: result, ok: true };
}

async function confluenceReadSource(
  connection: { config: unknown },
  token: string | null,
  query: unknown
): Promise<ReadSourceResult> {
  const requestedPageId =
    typeof query === 'object' && query != null
      ? text((query as Record<string, unknown>).pageId)
      : undefined;
  if (!requestedPageId) {
    throw ApplicationFailure.nonRetryable('Confluence readSource requires a pageId in query');
  }
  const content = await readConfluencePage(
    {
      apiToken: requireToken(token),
      config: parseConfluenceConnectionConfig(connection.config),
    },
    requestedPageId
  );
  return { connectionType: 'confluence', data: content, ok: true };
}

async function genericReadSource(
  connectionType: ConnectionType,
  _connection: unknown,
  _token: string | null
): Promise<ReadSourceResult> {
  return {
    connectionType,
    ok: true,
    placeholder: true,
  };
}

/**
 * Read a source object from the target connection. For `git_repo` this returns
 * a pointer that the SWE path already covers; for other types it is a
 * placeholder awaiting the domain-specific activity pack.
 */
export async function readSource(input: ReadSourceInput): Promise<ReadSourceResult> {
  const { connectionId, query } = validateInput(
    z.object({ connectionId: ConnectionIdSchema, query: z.unknown().optional() }),
    input
  );
  const connection = await loadConnection(connectionId);
  const token = getApiToken(connection);
  switch (connection.type) {
    case 'git_repo':
      return gitRepoReadSource(connection, query);
    case 'notion':
      return notionReadSource(connection, token, query);
    case 'zendesk':
      return zendeskReadSource(connection, token, query);
    case 'issue_tracker':
      return issueTrackerReadSource(connection, token, query);
    case 'confluence':
      return confluenceReadSource(connection, token, query);
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'slack_workspace':
      return genericReadSource(connection.type, connection, token);
    default:
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for readSource: ${connection.type}`
      );
  }
}

async function gitRepoWriteOutcome(
  _connection: unknown,
  _data: unknown
): Promise<WriteOutcomeResult> {
  return {
    connectionType: 'git_repo',
    ok: true,
    placeholder: true,
    reference: 'Use createOrUpdatePullRequest for git_repo outcomes',
  };
}

function textToNotionBlocks(text: string): NotionBlock[] {
  return text.split('\n').map((line) => ({
    paragraph: {
      rich_text: [{ text: { content: line }, type: 'text' }],
    },
    type: 'paragraph',
  }));
}

async function notionWriteOutcome(
  connection: { config: unknown },
  token: string | null,
  data: unknown
): Promise<WriteOutcomeResult> {
  const config = parseNotionConnectionConfig(connection.config);
  if (typeof data !== 'object' || data == null) {
    throw ApplicationFailure.nonRetryable('Notion writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const apiToken = requireToken(token);

  // Append plain text to an existing page as paragraph blocks.
  if (typeof d.text === 'string') {
    const pageId = (d.pageId as string | undefined) ?? config.sourcePageId;
    if (!pageId) {
      throw ApplicationFailure.nonRetryable(
        'Notion writeOutcome text requires pageId or a default sourcePageId on the connection'
      );
    }
    const result = await appendNotionBlocks({ apiToken }, pageId, textToNotionBlocks(d.text));
    return {
      connectionType: 'notion',
      ok: true,
      reference: result.pageId,
    };
  }

  // Append blocks to an existing page.
  if (Array.isArray(d.blocks)) {
    const pageId = (d.pageId as string | undefined) ?? config.sourcePageId;
    if (!pageId) {
      throw ApplicationFailure.nonRetryable(
        'Notion writeOutcome blocks requires pageId or a default sourcePageId on the connection'
      );
    }
    const result = await appendNotionBlocks({ apiToken }, pageId, d.blocks as NotionBlock[]);
    return {
      connectionType: 'notion',
      ok: true,
      reference: result.pageId,
    };
  }

  if (!isCreatePageData(d)) {
    throw ApplicationFailure.nonRetryable(
      'Notion writeOutcome data must include text, blocks, or a create-page request'
    );
  }

  // Create a new page.
  const created = await createNotionPage(
    { apiToken },
    {
      databaseId: d.databaseId as string | undefined,
      pageId: (d.pageId as string | undefined) ?? config.sourcePageId,
      properties: (d.properties as Record<string, unknown> | undefined) ?? {},
      title: d.title as string | undefined,
    }
  );
  return { connectionType: 'notion', ok: true, reference: created.url };
}

async function zendeskWriteOutcome(
  connection: { config: unknown },
  token: string | null,
  data: unknown
): Promise<WriteOutcomeResult> {
  if (typeof data !== 'object' || data == null) {
    throw ApplicationFailure.nonRetryable('Zendesk writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const ticketId = d.ticketId;
  const body = d.body;
  if (typeof ticketId !== 'string' || typeof body !== 'string') {
    throw ApplicationFailure.nonRetryable(
      'Zendesk writeOutcome requires ticketId and body strings'
    );
  }
  const isPublic = d.public === true;
  const result = await postZendeskComment(
    { apiToken: requireToken(token), config: parseZendeskConnectionConfig(connection.config) },
    ticketId,
    { body, public: isPublic }
  );
  return { connectionType: 'zendesk', ok: true, reference: result.ticketId };
}

async function issueTrackerWriteOutcome(
  connection: { config: unknown },
  token: string | null,
  data: unknown
): Promise<WriteOutcomeResult> {
  if (typeof data !== 'object' || data == null) {
    throw ApplicationFailure.nonRetryable('issue_tracker writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const title = d.title;
  const description = d.description;
  if (typeof title !== 'string') {
    throw ApplicationFailure.nonRetryable('issue_tracker writeOutcome requires a title string');
  }
  const config = parseIssueTrackerConnectionConfig(connection.config);
  const projectKey = typeof d.projectKey === 'string' ? d.projectKey : config.defaultProjectKey;
  const result = await createIssue(
    { apiToken: requireToken(token), config },
    { description: typeof description === 'string' ? description : undefined, projectKey, title }
  );
  return { connectionType: 'issue_tracker', ok: true, reference: result.url };
}

/**
 * A non-empty string, or undefined.
 *
 * A bound payload field that is absent resolves to `undefined`, but one the
 * caller sent as `""` resolves to `""` — and `""` is a *string*, so a naive
 * `typeof x === 'string'` check passes it through as a target page id or a page
 * title, which Confluence rejects at best. Both spellings have to mean "not
 * supplied".
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * A caller's expected page version, or undefined when it named none.
 *
 * Refused rather than ignored when it is not a positive whole number: a version
 * the write does not honour is a precondition the caller believed was in force,
 * and dropping it silently is how a stale draft overwrites a newer page.
 */
function expectedVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw ApplicationFailure.nonRetryable(
    'Confluence writeOutcome version must be a positive whole number'
  );
}

/**
 * Create or update a Confluence page.
 *
 * `targetPageId` (or `pageId`) selects the update path and its absence the create
 * path, so one step covers both halves of "creates or updates". The connector
 * throws on every failure — it never returns a null page — so a failed write
 * cannot be reported as a successful `ok: true`.
 *
 * `fallbackTitle` is the name to use when `title` is blank **on creation only**. A
 * template that drafts from a record passes the record's own title here: a form
 * submits an untouched optional field as an empty string, and an expression cannot
 * express "the first non-empty of these" (the evaluator's `||` yields a boolean,
 * and `??` only covers null), so the choice is made here instead. An update never
 * takes it, or a body-only write would rename the page after the source record.
 *
 * The `pageId` and `text` aliases are reachable only by a caller passing an explicit
 * `data` object: the workflow dispatcher treats a flat `pageId` (or `text` with a
 * `pageId`) as an explicit payload shape and refuses to build one from the node's
 * own inputs, so a flat node on this connection binds `bodyText`/`targetPageId`.
 */
async function confluenceWriteOutcome(
  connection: { config: unknown },
  token: string | null,
  data: unknown
): Promise<WriteOutcomeResult> {
  if (typeof data !== 'object' || data == null) {
    throw ApplicationFailure.nonRetryable('Confluence writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const bodyText = text(d.bodyText) ?? text(d.text);
  if (!bodyText) {
    throw ApplicationFailure.nonRetryable('Confluence writeOutcome requires bodyText');
  }
  const conn = {
    apiToken: requireToken(token),
    config: parseConfluenceConnectionConfig(connection.config),
  };
  const targetPageId = text(d.targetPageId) ?? text(d.pageId);

  if (targetPageId) {
    // No `fallbackTitle` here: renaming an existing page because the *source
    // record* has a title would rename every page a body update touches. An
    // update renames only when the caller asked for a name.
    const title = text(d.title);
    const version = expectedVersion(d.version);
    const updated = await updateConfluencePage(conn, targetPageId, {
      bodyText,
      ...(title ? { title } : {}),
      ...(version ? { version } : {}),
    });
    return { connectionType: 'confluence', ok: true, reference: updated.url };
  }

  const title = text(d.title) ?? text(d.fallbackTitle);
  if (!title) {
    throw ApplicationFailure.nonRetryable(
      'Confluence writeOutcome requires a title to create a page (or a targetPageId to update one)'
    );
  }
  const spaceKey = text(d.spaceKey);
  const parentPageId = text(d.parentPageId);
  const created = await createConfluencePage(conn, {
    bodyText,
    ...(parentPageId ? { parentPageId } : {}),
    ...(spaceKey ? { spaceKey } : {}),
    title,
  });
  return { connectionType: 'confluence', ok: true, reference: created.url };
}

async function slackWriteOutcome(
  connection: { config: unknown },
  token: string | null,
  data: unknown
): Promise<WriteOutcomeResult> {
  if (typeof data !== 'object' || data == null) {
    throw ApplicationFailure.nonRetryable('Slack writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const channelId = d.channelId;
  const text = d.text;
  if (typeof channelId !== 'string' || typeof text !== 'string') {
    throw ApplicationFailure.nonRetryable('Slack writeOutcome requires channelId and text strings');
  }
  const config = parseSlackConnectionConfig(connection.config);
  const resolvedChannelId = channelId || config.defaultChannelId;
  if (!resolvedChannelId) {
    throw ApplicationFailure.nonRetryable(
      'Slack writeOutcome requires a channelId or a defaultChannelId on the connection'
    );
  }
  const result = await postSlackMessage(
    { apiToken: requireToken(token) },
    { channelId: resolvedChannelId, text }
  );
  return { connectionType: 'slack_workspace', ok: true, reference: result.ts };
}

function isCreatePageData(d: Record<string, unknown>): boolean {
  return (
    typeof d.databaseId === 'string' ||
    typeof d.pageId === 'string' ||
    typeof d.title === 'string' ||
    typeof d.properties === 'object'
  );
}

async function genericWriteOutcome(
  connectionType: ConnectionType,
  _connection: unknown,
  _token: string | null
): Promise<WriteOutcomeResult> {
  return { connectionType, ok: true, placeholder: true };
}

/**
 * Write a validated outcome to the target connection. Placeholder for non-git
 * types pending the domain-specific activity packs.
 */
/**
 * Refuse a write while the run's latest `publishOutcome` decision requires approval
 * and no approval has been recorded since. A template that records the decision but
 * routes straight to `writeOutcome` would otherwise write anyway while the audit log
 * says approval was required. A run with no recorded decision is not gated.
 */
async function assertApprovalSatisfied(runId: string): Promise<void> {
  const published = await prisma.autonomyDecision.findFirst({
    orderBy: { createdAt: 'desc' },
    where: { event: 'publish', runId },
  });
  const payload = published?.payload as { decision?: string } | null | undefined;
  if (!published || payload?.decision !== 'require_approval') {
    return;
  }
  const approved = await prisma.autonomyDecision.findFirst({
    where: { createdAt: { gte: published.createdAt }, event: 'approve', runId },
  });
  if (!approved) {
    throw ApplicationFailure.nonRetryable(
      `writeOutcome refused: policy '${published.policyName ?? 'unknown'}' requires human approval for '${published.riskClass ?? 'this action'}' and none was recorded`,
      'APPROVAL_REQUIRED'
    );
  }
}

export async function writeOutcome(input: WriteOutcomeInput): Promise<WriteOutcomeResult> {
  const { connectionId, data, nodeId } = validateInput(
    z.object({
      connectionId: ConnectionIdSchema,
      data: z.unknown(),
      nodeId: z.string().min(1).optional(),
    }),
    input
  );

  // Side-effects to external systems (Notion, Zendesk, issue tracker, Slack) are
  // not idempotent by default. A Temporal activity retry after a successful write
  // would duplicate the write unless we remember it. The ledger is looked up by
  // (run, node, connection) — deliberately NOT by attempt: a retry is by
  // definition a new attempt number, so keying on it could never find the row
  // the previous attempt wrote. `attempt` is still stored for audit.
  const attempt = Context.current().info.attempt;
  const run = await currentRun();
  const runId = nodeId ? run?.id : undefined;

  async function perform(): Promise<WriteOutcomeResult> {
    if (run) {
      await assertApprovalSatisfied(run.id);
    }
    const connection = await loadConnection(connectionId);
    const token = getApiToken(connection);
    switch (connection.type) {
      case 'git_repo':
        return gitRepoWriteOutcome(connection, data);
      case 'notion':
        return notionWriteOutcome(connection, token, data);
      case 'zendesk':
        return zendeskWriteOutcome(connection, token, data);
      case 'slack_workspace':
        return slackWriteOutcome(connection, token, data);
      case 'issue_tracker':
        return issueTrackerWriteOutcome(connection, token, data);
      case 'confluence':
        return confluenceWriteOutcome(connection, token, data);
      case 'http_api':
      case 'hubspot':
      case 'mcp':
        return genericWriteOutcome(connection.type, connection, token);
      default:
        throw ApplicationFailure.nonRetryable(
          `Unsupported connection type for writeOutcome: ${connection.type}`
        );
    }
  }

  if (!runId || !nodeId) {
    return perform();
  }

  const existing = await prisma.workflowOutcomeReference.findFirst({
    orderBy: { attempt: 'asc' },
    where: { connectionId, nodeId, runId },
  });
  if (existing) {
    return existing.result as unknown as WriteOutcomeResult;
  }

  const result = await perform();
  await prisma.workflowOutcomeReference.create({
    data: {
      attempt,
      connectionId,
      nodeId,
      result: result as unknown as Prisma.InputJsonValue,
      runId,
    },
  });
  return result;
}

async function gitRepoRunTool(
  _connection: unknown,
  tool: string,
  _inputs: unknown
): Promise<RunToolResult> {
  return {
    connectionType: 'git_repo',
    ok: true,
    output: { hint: `git_repo tool ${tool} is handled by the SWE activity set` },
    placeholder: true,
  };
}

async function zendeskRunTool(
  connection: { config: unknown },
  token: string | null,
  tool: string,
  inputs: unknown
): Promise<RunToolResult> {
  const apiToken = requireToken(token);
  const config = parseZendeskConnectionConfig(connection.config);
  if (tool === 'fetchTicket') {
    const ticketId =
      typeof inputs === 'object' && inputs != null
        ? (inputs as Record<string, unknown>).ticketId
        : undefined;
    if (typeof ticketId !== 'string') {
      throw ApplicationFailure.nonRetryable('fetchTicket requires a string ticketId input');
    }
    const result = await fetchZendeskTicket({ apiToken, config }, ticketId);
    return { connectionType: 'zendesk', ok: true, output: result };
  }
  if (tool === 'postComment') {
    const data = typeof inputs === 'object' && inputs != null ? inputs : {};
    const ticketId = (data as Record<string, unknown>).ticketId;
    const body = (data as Record<string, unknown>).body;
    if (typeof ticketId !== 'string' || typeof body !== 'string') {
      throw ApplicationFailure.nonRetryable('postComment requires string ticketId and body inputs');
    }
    const isPublic = (data as Record<string, unknown>).public === true;
    const result = await postZendeskComment({ apiToken, config }, ticketId, {
      body,
      public: isPublic,
    });
    return { connectionType: 'zendesk', ok: true, output: result };
  }
  throw ApplicationFailure.nonRetryable(`Unsupported Zendesk tool: ${tool}`);
}

async function slackRunTool(
  connection: { config: unknown },
  token: string | null,
  tool: string,
  inputs: unknown
): Promise<RunToolResult> {
  const apiToken = requireToken(token);
  const config = parseSlackConnectionConfig(connection.config);
  if (tool === 'postMessage') {
    const data = typeof inputs === 'object' && inputs != null ? inputs : {};
    const channelId = (data as Record<string, unknown>).channelId || config.defaultChannelId;
    const text = (data as Record<string, unknown>).text;
    if (typeof channelId !== 'string' || typeof text !== 'string') {
      throw ApplicationFailure.nonRetryable(
        'postMessage requires a channelId and text string inputs'
      );
    }
    const result = await postSlackMessage({ apiToken }, { channelId, text });
    return { connectionType: 'slack_workspace', ok: true, output: result };
  }
  throw ApplicationFailure.nonRetryable(`Unsupported Slack tool: ${tool}`);
}

async function issueTrackerRunTool(
  connection: { config: unknown },
  token: string | null,
  tool: string,
  inputs: unknown
): Promise<RunToolResult> {
  const apiToken = requireToken(token);
  const config = parseIssueTrackerConnectionConfig(connection.config);
  const data = typeof inputs === 'object' && inputs != null ? inputs : {};
  if (tool === 'createIssue') {
    const title = (data as Record<string, unknown>).title;
    const description = (data as Record<string, unknown>).description;
    if (typeof title !== 'string') {
      throw ApplicationFailure.nonRetryable('createIssue requires a title string');
    }
    const inputProjectKey = (data as Record<string, unknown>).projectKey;
    const projectKey =
      typeof inputProjectKey === 'string' ? inputProjectKey : config.defaultProjectKey;
    const result = await createIssue(
      { apiToken, config },
      { description: typeof description === 'string' ? description : undefined, projectKey, title }
    );
    return { connectionType: 'issue_tracker', ok: true, output: result };
  }
  if (tool === 'fetchIssue') {
    const issueId = (data as Record<string, unknown>).issueId;
    if (typeof issueId !== 'string') {
      throw ApplicationFailure.nonRetryable('fetchIssue requires an issueId string');
    }
    const result = await fetchIssue({ apiToken, config }, issueId);
    return { connectionType: 'issue_tracker', ok: true, output: result };
  }
  throw ApplicationFailure.nonRetryable(`Unsupported issue_tracker tool: ${tool}`);
}

async function confluenceRunTool(
  connection: { config: unknown },
  token: string | null,
  tool: string,
  inputs: unknown
): Promise<RunToolResult> {
  const conn = {
    apiToken: requireToken(token),
    config: parseConfluenceConnectionConfig(connection.config),
  };
  const data =
    typeof inputs === 'object' && inputs != null ? (inputs as Record<string, unknown>) : {};

  if (tool === 'fetchPage') {
    const pageId = text(data.pageId);
    if (!pageId) {
      throw ApplicationFailure.nonRetryable('fetchPage requires a string pageId input');
    }
    return {
      connectionType: 'confluence',
      ok: true,
      output: await readConfluencePage(conn, pageId),
    };
  }
  if (tool === 'createPage') {
    const title = text(data.title);
    const bodyText = text(data.bodyText);
    if (!title || !bodyText) {
      throw ApplicationFailure.nonRetryable('createPage requires string title and bodyText inputs');
    }
    const parentPageId = text(data.parentPageId);
    const spaceKey = text(data.spaceKey);
    return {
      connectionType: 'confluence',
      ok: true,
      output: await createConfluencePage(conn, {
        bodyText,
        ...(parentPageId ? { parentPageId } : {}),
        ...(spaceKey ? { spaceKey } : {}),
        title,
      }),
    };
  }
  if (tool === 'updatePage') {
    const pageId = text(data.pageId);
    const bodyText = text(data.bodyText);
    if (!pageId || !bodyText) {
      throw ApplicationFailure.nonRetryable(
        'updatePage requires string pageId and bodyText inputs'
      );
    }
    const title = text(data.title);
    // A supplied precondition must be forwarded, not refreshed away.
    const version = expectedVersion(data.version);
    return {
      connectionType: 'confluence',
      ok: true,
      output: await updateConfluencePage(conn, pageId, {
        bodyText,
        ...(title ? { title } : {}),
        ...(version ? { version } : {}),
      }),
    };
  }
  throw ApplicationFailure.nonRetryable(`Unsupported Confluence tool: ${tool}`);
}

async function genericRunTool(
  connectionType: ConnectionType,
  _connection: unknown,
  _token: string | null
): Promise<RunToolResult> {
  return { connectionType, ok: true, placeholder: true };
}

/**
 * Run an arbitrary tool against the target connection. Placeholder for non-git
 * types pending the domain-specific activity packs.
 */
export async function runTool(input: RunToolInput): Promise<RunToolResult> {
  const { connectionId, tool, inputs } = validateInput(
    z.object({
      connectionId: ConnectionIdSchema,
      inputs: z.unknown().optional(),
      tool: ToolNameSchema,
    }),
    input
  );
  // A tool that writes is subject to the approval the policy recorded, exactly as
  // `writeOutcome` is: `publishOutcome` can say `require_approval` and a template
  // that then calls `runTool(createPage)` would otherwise publish anyway, with the
  // audit log saying approval was required.
  if (!READ_ONLY_CONNECTION_TOOLS.has(tool)) {
    const run = await currentRun();
    if (run) {
      await assertApprovalSatisfied(run.id);
    }
  }
  const connection = await loadConnection(connectionId);
  const token = getApiToken(connection);
  switch (connection.type) {
    case 'git_repo':
      return gitRepoRunTool(connection, tool, inputs);
    case 'zendesk':
      return zendeskRunTool(connection, token, tool, inputs);
    case 'slack_workspace':
      return slackRunTool(connection, token, tool, inputs);
    case 'issue_tracker':
      return issueTrackerRunTool(connection, token, tool, inputs);
    case 'confluence':
      return confluenceRunTool(connection, token, tool, inputs);
    case 'http_api':
    case 'hubspot':
    case 'mcp':
    case 'notion':
      return genericRunTool(connection.type, connection, token);
    default:
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for runTool: ${connection.type}`
      );
  }
}
