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
import {
  CONNECTOR_NOT_IMPLEMENTED,
  type GenericConnectionStep,
  genericStepRefusal,
} from '@auto-swe/shared/lib/connectionTypes';
import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import {
  createConfluenceFooterComment,
  createConfluenceInlineComment,
  createConfluencePage,
  readConfluencePage,
  updateConfluencePage,
} from '../connectors/confluence.js';
import { createIssue, fetchIssue, type IssueResult } from '../connectors/issueTracker.js';
import {
  appendNotionBlocks,
  createNotionPage,
  type NotionBlock,
  readNotionPage,
} from '../connectors/notion.js';
import { postSlackMessage } from '../connectors/slack.js';
import { fetchZendeskTicket, postZendeskComment } from '../connectors/zendesk.js';
import { assertConnectionAuthorized } from '../lib/connectionAccess.js';
import { countOccurrences, MAX_REVIEW_FINDINGS, TicketPlanSchema } from '../lib/documentReview.js';
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
 * structured result. A connection type with no implementation behind a step
 * (`GENERIC_STEP_CONNECTION_TYPES`) fails that step with a non-retryable
 * `CONNECTOR_NOT_IMPLEMENTED`; no step reports success without acting.
 */

export interface ReadSourceInput {
  connectionId: string;
  query?: unknown;
}

export interface ReadSourceResult {
  connectionType: ConnectionType;
  data?: unknown;
  ok: boolean;
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
  reference?: string;
  /** Every item a multi-item write created (a ticket plan's issues), epic first. */
  references?: string[];
  /** What a comment write left: how many were anchored to a passage and how many sit at the foot. */
  comments?: { footer: number; inline: number };
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

/**
 * A step with no implementation for this connection type fails, non-retryably and loudly: a
 * step that reports `ok: true` without acting lets a run finish "successfully" having done nothing.
 */
function refuseUnimplemented(step: GenericConnectionStep, connectionType: string): never {
  const refusal = genericStepRefusal(step, connectionType);
  if (refusal) {
    throw ApplicationFailure.nonRetryable(refusal, CONNECTOR_NOT_IMPLEMENTED);
  }
  throw ApplicationFailure.nonRetryable(
    `${step} reached a ${connectionType} connection with no handler`,
    CONNECTOR_NOT_IMPLEMENTED
  );
}

/**
 * Read a source object from the target connection. Types with no read
 * implementation fail with `CONNECTOR_NOT_IMPLEMENTED`.
 */
export async function readSource(input: ReadSourceInput): Promise<ReadSourceResult> {
  const { connectionId, query } = validateInput(
    z.object({ connectionId: ConnectionIdSchema, query: z.unknown().optional() }),
    input
  );
  const connection = await loadConnection(connectionId, 'readSource');
  const token = getApiToken(connection);
  switch (connection.type) {
    case 'notion':
      return notionReadSource(connection, token, query);
    case 'zendesk':
      return zendeskReadSource(connection, token, query);
    case 'issue_tracker':
      return issueTrackerReadSource(connection, token, query);
    case 'confluence':
      return confluenceReadSource(connection, token, query);
    default:
      // Every other type (`git_repo`, `http_api`, `hubspot`, `mcp`, `slack_workspace`, or one
      // this build does not know) has no read implementation: fail rather than report success.
      return refuseUnimplemented('readSource', connection.type);
  }
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
  if (d.plan !== undefined) {
    return issueTrackerPlanOutcome(connection, token, d);
  }
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

/** A connector's permanent refusal, as opposed to an outage worth retrying. */
function isNonRetryable(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'nonRetryable' in err && err.nonRetryable === true
  );
}

/** A Jira issue type name from the request, or the default. */
function issueTypeName(value: unknown, fallback: string): string {
  return text(value)?.trim().slice(0, 60) ?? fallback;
}

/** The ticket text: its description, then its acceptance criteria as a list. */
function ticketBody(description: string, acceptanceCriteria: readonly string[]): string {
  return acceptanceCriteria.length === 0
    ? description
    : `${description}\n\nAcceptance criteria:\n${acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`;
}

/**
 * Create a ticket plan: one epic, a ticket under it for each entry, and a sub-task under each
 * ticket that has any. `data.plan` is validated again here, whatever produced it, and the issue
 * types come from the request (`epicIssueType`, `storyIssueType`, `subtaskIssueType`; Jira
 * defaults `Epic`, `Story`, `Sub-task`; Linear has none and nests by parent).
 *
 * Creation is sequential and not transactional: a failure part way leaves what was created. The
 * failure then names every issue created so far and none of the tracker's own text, so a person
 * can tidy up, and the ledger refuses a blind retry that could create them twice.
 */
async function issueTrackerPlanOutcome(
  connection: { config: unknown },
  token: string | null,
  d: Record<string, unknown>
): Promise<WriteOutcomeResult> {
  const parsed = TicketPlanSchema.safeParse(d.plan);
  if (!parsed.success) {
    throw notSent('issue_tracker writeOutcome plan does not match the ticket plan shape');
  }
  const plan = parsed.data;
  const config = parseIssueTrackerConnectionConfig(connection.config);
  const conn = { apiToken: requireToken(token), config };
  const projectKey = text(d.projectKey) ?? config.defaultProjectKey;
  const epicType = issueTypeName(d.epicIssueType, 'Epic');
  const storyType = issueTypeName(d.storyIssueType, 'Story');
  const subtaskType = issueTypeName(d.subtaskIssueType, 'Sub-task');
  const parentRef = (issue: IssueResult) => issue.identifier ?? issue.id;
  const created: IssueResult[] = [];

  const make = async (
    what: string,
    input: { description: string; issueType: string; parentId?: string; title: string }
  ): Promise<IssueResult> => {
    try {
      const issue = await createIssue(conn, { ...input, projectKey });
      created.push(issue);
      return issue;
    } catch (err) {
      const so_far = created.map((i) => i.identifier ?? i.url).join(', ') || 'none';
      const why = isNonRetryable(err) ? 'refused' : 'failed';
      throw ApplicationFailure.nonRetryable(
        `The tracker ${why} the ${what} after ${created.length} issue(s) were created (${so_far}).`
      );
    }
  };

  const epic = await make('epic', {
    description: plan.epic.description,
    issueType: epicType,
    title: plan.epic.title,
  });
  for (const ticket of plan.tickets) {
    const issue = await make('ticket', {
      description: ticketBody(ticket.description, ticket.acceptanceCriteria),
      issueType: storyType,
      parentId: parentRef(epic),
      title: ticket.title,
    });
    for (const subtask of ticket.subtasks) {
      await make('sub-task', {
        description: subtask.description,
        issueType: subtaskType,
        parentId: parentRef(issue),
        title: subtask.title,
      });
    }
  }
  return {
    connectionType: 'issue_tracker',
    ok: true,
    reference: epic.url,
    references: created.map((i) => i.url),
  };
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

const ReviewCommentsSchema = z
  .array(z.object({ body: z.string().trim().min(1), quote: z.string().default('') }))
  .min(1)
  .max(MAX_REVIEW_FINDINGS + 1);

/**
 * Leave review comments on a page: `data.pageId` and `data.comments`, each `{ body, quote }`.
 * A comment whose `quote` is a passage that appears in the page is anchored to it; one whose
 * passage is missing, or that Confluence refuses to anchor, goes at the foot of the page with the
 * passage quoted, so no finding is lost to a formatting mismatch. A transient failure is not
 * caught: the comments already left stay, and the ledger refuses a blind retry.
 */
async function confluenceCommentOutcome(
  connection: { config: unknown },
  token: string | null,
  d: Record<string, unknown>
): Promise<WriteOutcomeResult> {
  const pageId = text(d.pageId) ?? text(d.targetPageId);
  if (!pageId) {
    throw notSent('Confluence writeOutcome comments require a pageId');
  }
  const comments = ReviewCommentsSchema.safeParse(d.comments);
  if (!comments.success) {
    throw notSent(
      `Confluence writeOutcome comments must be 1 to ${MAX_REVIEW_FINDINGS + 1} entries, each with a body`
    );
  }
  const conn = {
    apiToken: requireToken(token),
    config: parseConfluenceConnectionConfig(connection.config),
  };
  const page = await readConfluencePage(conn, pageId);
  let inline = 0;
  let footer = 0;
  for (const comment of comments.data) {
    const quote = comment.quote.trim();
    const matchCount = countOccurrences(page.bodyText, quote);
    if (quote !== '' && matchCount > 0) {
      try {
        await createConfluenceInlineComment(conn, {
          bodyText: comment.body,
          matchCount,
          matchIndex: 0,
          pageId,
          textSelection: quote,
        });
        inline++;
        continue;
      } catch (err) {
        // A refusal falls back to a footer comment; a transient failure is the caller's to retry.
        if (!isNonRetryable(err)) {
          throw err;
        }
      }
    }
    await createConfluenceFooterComment(conn, {
      bodyText: quote === '' ? comment.body : `${comment.body}\n"${quote}"`,
      pageId,
    });
    footer++;
  }
  return {
    comments: { footer, inline },
    connectionType: 'confluence',
    ok: true,
    reference: page.url,
  };
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
  if (d.comments !== undefined) {
    return confluenceCommentOutcome(connection, token, d);
  }
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

/**
 * Write a validated outcome to the target connection. Types with no write
 * implementation fail with `CONNECTOR_NOT_IMPLEMENTED`.
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
    if (genericStepRefusal('writeOutcome', connection.type)) {
      refuseUnimplemented('writeOutcome', connection.type);
    }
    return { connection, token };
  }

  async function perform(
    prepared: Awaited<ReturnType<typeof prepare>>
  ): Promise<WriteOutcomeResult> {
    const { connection, token } = prepared;
    switch (connection.type) {
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
      default:
        // Unreachable: `prepare()` refuses any type outside `GENERIC_STEP_CONNECTION_TYPES.writeOutcome`.
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
    if (genericStepRefusal('runTool', connection.type)) {
      refuseUnimplemented('runTool', connection.type);
    }
    return { connection, token };
  }

  async function perform(prepared: Awaited<ReturnType<typeof prepare>>): Promise<RunToolResult> {
    const { connection, token } = prepared;
    switch (connection.type) {
      case 'zendesk':
        return zendeskRunTool(connection, token, tool, inputs);
      case 'slack_workspace':
        return slackRunTool(connection, token, tool, inputs);
      case 'issue_tracker':
        return issueTrackerRunTool(connection, token, tool, inputs);
      case 'confluence':
        return confluenceRunTool(connection, token, tool, inputs);
      default:
        // Unreachable: `prepare()` refuses any type outside `GENERIC_STEP_CONNECTION_TYPES.runTool`.
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
