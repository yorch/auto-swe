import {
  type ConnectionType,
  decryptConnectionApiToken,
  parseConfluenceConnectionConfig,
  parseIssueTrackerConnectionConfig,
  parseNotionConnectionConfig,
  parseSlackConnectionConfig,
  parseZendeskConnectionConfig,
} from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';
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
import { assertConnectionAuthorized } from '../lib/connectionAccess.js';
import {
  assertApprovalSatisfied,
  findRecordedOutcome,
  isMutatingToolCall,
  mutationScope,
  notSent,
  type OutcomeKey,
  performOnce,
} from '../lib/externalWrite.js';

const ConnectionIdSchema = z.string().uuid();
const ToolNameSchema = z.string().min(1);

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
  /**
   * The step's recording id (the interpreter's `dispatchKey`). Keys the outcome
   * ledger, so a retry of a mutating tool returns the first call's result
   * instead of posting twice.
   */
  nodeId?: string;
  tool: string;
}

export interface RunToolResult {
  connectionType: ConnectionType;
  ok: boolean;
  output?: unknown;
  placeholder?: boolean;
}

/**
 * Load a connection this run is allowed to use.
 *
 * The authorization check lives here because every generic step that targets a
 * connection — `readSource`, `writeOutcome`, `runTool` — loads it through this one
 * function, so a node whose connection id came from anywhere (a declared payload field, a
 * nested path, another node's output) is checked against the run's pinned set before its
 * credential is decrypted.
 */
async function loadConnection(connectionId: string, step: string) {
  await assertConnectionAuthorized(connectionId, step);
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
    throw notSent('Connection API token is required');
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
  const connection = await loadConnection(connectionId, 'readSource');
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

const WRITE_OUTCOME_TYPES: ReadonlySet<string> = new Set([
  'git_repo',
  'notion',
  'zendesk',
  'slack_workspace',
  'issue_tracker',
  'confluence',
  'http_api',
  'hubspot',
  'mcp',
]);

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
    throw notSent('Notion writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const apiToken = requireToken(token);

  // Append plain text to an existing page as paragraph blocks.
  if (typeof d.text === 'string') {
    const pageId = (d.pageId as string | undefined) ?? config.sourcePageId;
    if (!pageId) {
      throw notSent(
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
      throw notSent(
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
    throw notSent('Notion writeOutcome data must include text, blocks, or a create-page request');
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
    throw notSent('Zendesk writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const ticketId = d.ticketId;
  const body = d.body;
  if (typeof ticketId !== 'string' || typeof body !== 'string') {
    throw notSent('Zendesk writeOutcome requires ticketId and body strings');
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
    throw notSent('issue_tracker writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const title = d.title;
  const description = d.description;
  if (typeof title !== 'string') {
    throw notSent('issue_tracker writeOutcome requires a title string');
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
  throw notSent('Confluence writeOutcome version must be a positive whole number');
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
    throw notSent('Confluence writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const bodyText = text(d.bodyText) ?? text(d.text);
  if (!bodyText) {
    throw notSent('Confluence writeOutcome requires bodyText');
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
    throw notSent(
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
    throw notSent('Slack writeOutcome data must be an object');
  }
  const d = data as Record<string, unknown>;
  const channelId = d.channelId;
  const text = d.text;
  if (typeof channelId !== 'string' || typeof text !== 'string') {
    throw notSent('Slack writeOutcome requires channelId and text strings');
  }
  const config = parseSlackConnectionConfig(connection.config);
  const resolvedChannelId = channelId || config.defaultChannelId;
  if (!resolvedChannelId) {
    throw notSent(
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
export async function writeOutcome(input: WriteOutcomeInput): Promise<WriteOutcomeResult> {
  const { connectionId, data, nodeId } = validateInput(
    z.object({
      connectionId: ConnectionIdSchema,
      data: z.unknown(),
      nodeId: z.string().min(1).optional(),
    }),
    input
  );

  // Governance + idempotency for an external effect (see lib/externalWrite.ts):
  // a write is refused when the recorded policy requires an approval that never
  // came, and a retry after a successful write returns the stored result rather
  // than writing twice. `lib/externalWrite.ts` owns both guards, so `writeOutcome`,
  // `runTool` and `mcpCallTool` cannot drift apart.
  const scope = await mutationScope();
  const ledgerKey: OutcomeKey | null =
    nodeId && scope.runId ? { connectionId, nodeId, runId: scope.runId } : null;

  // Everything that can refuse before the provider is contacted runs before the claim: a refusal
  // after it leaves a PENDING row, and the next attempt then fails OUTCOME_AMBIGUOUS although
  // nothing was sent.
  async function prepare() {
    const connection = await loadConnection(connectionId, 'writeOutcome');
    const token = getApiToken(connection);
    if (!WRITE_OUTCOME_TYPES.has(connection.type)) {
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for writeOutcome: ${connection.type}`
      );
    }
    return { connection, token };
  }

  async function perform(
    prepared: Awaited<ReturnType<typeof prepare>>
  ): Promise<WriteOutcomeResult> {
    const { connection, token } = prepared;
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
        // Unreachable: `prepare()` refuses any type outside `WRITE_OUTCOME_TYPES`.
        throw ApplicationFailure.nonRetryable(
          `Unsupported connection type for writeOutcome: ${connection.type}`
        );
    }
  }

  if (!ledgerKey) {
    if (scope.runId) {
      await assertApprovalSatisfied(scope.runId);
    }
    return perform(await prepare());
  }

  // As in `mcpCallTool`, the ledger is read before the approval guard: a recorded effect already
  // happened, and returning it performs no second one. The guard and the connection checks run
  // before the claim, so a refusal leaves no PENDING row for a later retry to mistake for ambiguity.
  const existing = await findRecordedOutcome<WriteOutcomeResult>(ledgerKey);
  if (existing) {
    return existing;
  }
  await assertApprovalSatisfied(ledgerKey.runId);
  const prepared = await prepare();

  // Claimed before the dispatch and completed with its result: a retry returns what this attempt
  // produced, and one that may have reached the provider without recording anything refuses rather
  // than acting twice.
  return performOnce({ attempt: scope.attempt, dispatch: () => perform(prepared), key: ledgerKey });
}

const RUN_TOOL_TYPES: ReadonlySet<string> = new Set([
  'git_repo',
  'zendesk',
  'slack_workspace',
  'issue_tracker',
  'confluence',
  'http_api',
  'hubspot',
  'mcp',
  'notion',
]);

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
      throw notSent('fetchTicket requires a string ticketId input');
    }
    const result = await fetchZendeskTicket({ apiToken, config }, ticketId);
    return { connectionType: 'zendesk', ok: true, output: result };
  }
  if (tool === 'postComment') {
    const data = typeof inputs === 'object' && inputs != null ? inputs : {};
    const ticketId = (data as Record<string, unknown>).ticketId;
    const body = (data as Record<string, unknown>).body;
    if (typeof ticketId !== 'string' || typeof body !== 'string') {
      throw notSent('postComment requires string ticketId and body inputs');
    }
    const isPublic = (data as Record<string, unknown>).public === true;
    const result = await postZendeskComment({ apiToken, config }, ticketId, {
      body,
      public: isPublic,
    });
    return { connectionType: 'zendesk', ok: true, output: result };
  }
  throw notSent(`Unsupported Zendesk tool: ${tool}`);
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
      throw notSent('postMessage requires a channelId and text string inputs');
    }
    const result = await postSlackMessage({ apiToken }, { channelId, text });
    return { connectionType: 'slack_workspace', ok: true, output: result };
  }
  throw notSent(`Unsupported Slack tool: ${tool}`);
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
      throw notSent('createIssue requires a title string');
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
      throw notSent('fetchIssue requires an issueId string');
    }
    const result = await fetchIssue({ apiToken, config }, issueId);
    return { connectionType: 'issue_tracker', ok: true, output: result };
  }
  throw notSent(`Unsupported issue_tracker tool: ${tool}`);
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
      throw notSent('fetchPage requires a string pageId input');
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
      throw notSent('createPage requires string title and bodyText inputs');
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
      throw notSent('updatePage requires string pageId and bodyText inputs');
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
  throw notSent(`Unsupported Confluence tool: ${tool}`);
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
 *
 * Governed exactly like `writeOutcome`: `postComment`, `postMessage` and
 * `createIssue` change state outside the platform, so they are recorded against
 * the same outcome ledger and refused when the recorded policy requires an
 * approval that was never given. Reads (`fetchTicket`, `fetchIssue`) skip both —
 * they change nothing and a retry should observe current state.
 */
export async function runTool(input: RunToolInput): Promise<RunToolResult> {
  const { connectionId, nodeId, tool, inputs } = validateInput(
    z.object({
      connectionId: ConnectionIdSchema,
      inputs: z.unknown().optional(),
      nodeId: z.string().min(1).optional(),
      tool: ToolNameSchema,
    }),
    input
  );
  const mutating = isMutatingToolCall(tool);
  const scope = await mutationScope();
  const ledgerKey: OutcomeKey | null =
    mutating && nodeId && scope.runId ? { connectionId, nodeId, runId: scope.runId } : null;

  // See `writeOutcome`: refusals that precede the provider call run before the claim.
  async function prepare() {
    const connection = await loadConnection(connectionId, 'runTool');
    const token = getApiToken(connection);
    if (!RUN_TOOL_TYPES.has(connection.type)) {
      throw ApplicationFailure.nonRetryable(
        `Unsupported connection type for runTool: ${connection.type}`
      );
    }
    return { connection, token };
  }

  async function perform(prepared: Awaited<ReturnType<typeof prepare>>): Promise<RunToolResult> {
    const { connection, token } = prepared;
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
        // Unreachable: `prepare()` refuses any type outside `RUN_TOOL_TYPES`.
        throw ApplicationFailure.nonRetryable(
          `Unsupported connection type for runTool: ${connection.type}`
        );
    }
  }
  if (!ledgerKey) {
    if (mutating && scope.runId) {
      await assertApprovalSatisfied(scope.runId);
    }
    return perform(await prepare());
  }
  // As in `writeOutcome` and `mcpCallTool`: a recorded effect is returned before the approval
  // guard, and the guard and connection checks run before the claim so a refusal leaves no
  // PENDING row behind.
  const existing = await findRecordedOutcome<RunToolResult>(ledgerKey);
  if (existing) {
    return existing;
  }
  await assertApprovalSatisfied(ledgerKey.runId);
  const prepared = await prepare();
  // As in `writeOutcome`: the claim goes in before the dispatch.
  return performOnce({ attempt: scope.attempt, dispatch: () => perform(prepared), key: ledgerKey });
}
