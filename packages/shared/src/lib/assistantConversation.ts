import { z } from 'zod';

/**
 * The parts of an in-app assistant conversation that the gateway, the worker and the dashboard must
 * agree on: the conversation workflow's id and signal, the page context a message carries, and the
 * shape of a reply's tool steps. Pure, so the dashboard can import it.
 *
 * See `docs/adr/in-app-assistant.md`.
 */

/** The workflow type the gateway starts for a conversation. */
export const ASSISTANT_CONVERSATION_WORKFLOW = 'AssistantConversationWorkflow';

/** The signal that hands the conversation workflow a new turn. */
export const ASSISTANT_TURN_SIGNAL = 'assistantTurn';

/** The conversation workflow's id: one execution chain per conversation. */
export function assistantConversationWorkflowId(conversationId: string): string {
  return `assistant-${conversationId}`;
}

export interface AssistantConversationInput {
  conversationId: string;
  userId: string;
  /** Turns signalled to a previous execution that it had not started when it continued as new. */
  pending?: AssistantTurnRequest[];
}

/** The workflow type the gateway starts to name a conversation now (a reset to automatic). */
export const ASSISTANT_TITLE_WORKFLOW = 'AssistantTitleWorkflow';

/** The title workflow's id: at most one naming per conversation at a time. */
export function assistantTitleWorkflowId(conversationId: string): string {
  return `assistant-title-${conversationId}`;
}

export interface AssistantTitleInput {
  conversationId: string;
  userId: string;
}

/** One turn: the reply row to fill, and the token its tools call the gateway with. */
export interface AssistantTurnRequest {
  /** The ASSISTANT message row the gateway created PENDING for this turn. */
  replyId: string;
  /**
   * The assistant token the gateway minted for this turn (`asst_…`), bound to the user and the
   * conversation. It travels in the signal, so it is in the workflow's history until it expires.
   */
  token: string;
}

/** Longest message a user may send. */
export const MAX_ASSISTANT_MESSAGE_CHARS = 8000;

/** Longest conversation title, whoever wrote it. */
export const MAX_ASSISTANT_TITLE_CHARS = 80;

/**
 * Where a conversation's title came from: the start of its first message, the `assistantTitler`
 * agent, or the user. A USER title is never replaced by a model's.
 */
export type AssistantTitleSource = 'FIRST_MESSAGE' | 'MODEL' | 'USER';

/**
 * A title as stored: one line, every run of whitespace collapsed, at most
 * {@link MAX_ASSISTANT_TITLE_CHARS} with an ellipsis when cut. Empty when the text has none.
 */
export function normalizeAssistantTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_ASSISTANT_TITLE_CHARS
    ? line
    : `${line.slice(0, MAX_ASSISTANT_TITLE_CHARS - 1).trimEnd()}…`;
}

/** Longest admin-only failure detail kept on a FAILED reply (`AssistantMessage.errorDetail`). */
export const MAX_ASSISTANT_ERROR_DETAIL_CHARS = 2000;

/** Causes followed when describing an error; deeper ones are dropped. */
const ERROR_DETAIL_CAUSE_DEPTH = 3;

/**
 * The failure detail for a reply whose turn never reported back: the activity timed out or its
 * worker stopped, so there is no error to describe. Temporal's history for the conversation
 * workflow has the rest.
 */
export const ASSISTANT_TURN_LOST_DETAIL =
  'The turn did not complete: the activity timed out or its worker stopped. See the conversation ' +
  "workflow's history in Temporal.";

/** The failure detail for a reply whose turn could not be handed to the conversation workflow. */
export const ASSISTANT_TURN_NOT_STARTED_DETAIL =
  'The turn could not be handed to the conversation workflow: ';

function describeOne(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const type = (err as { type?: unknown }).type;
  const head = typeof type === 'string' && type ? `${err.name} [${type}]` : err.name;
  return err.message ? `${head}: ${err.message}` : head;
}

/**
 * Describe why an assistant turn failed, for an admin: the error's name, its failure type when it
 * carries one (`BUDGET_EXCEEDED`), its message, and the first few causes it wraps. Cut to
 * {@link MAX_ASSISTANT_ERROR_DETAIL_CHARS}.
 */
export function assistantErrorDetail(err: unknown, prefix = ''): string {
  const parts = [describeOne(err)];
  let cause = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < ERROR_DETAIL_CAUSE_DEPTH; depth += 1) {
    parts.push(`caused by ${describeOne(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  const text = prefix + parts.join(' — ');
  return text.length <= MAX_ASSISTANT_ERROR_DETAIL_CHARS
    ? text
    : `${text.slice(0, MAX_ASSISTANT_ERROR_DETAIL_CHARS - 1)}…`;
}

/** The kinds of entity a dashboard page can be about. */
export const ASSISTANT_PAGE_ENTITY_TYPES = [
  'run',
  'workflow',
  'template',
  'epic',
  'team',
  'organization',
  'evalRun',
  'evalDataset',
  'doc',
] as const;
export type AssistantPageEntityType = (typeof ASSISTANT_PAGE_ENTITY_TYPES)[number];

/**
 * The gateway route that reads an entity of each kind, for `getPageContext` to point the assistant
 * at. A doc is read with `searchDocs`, not the API.
 */
export const ASSISTANT_PAGE_ENTITY_ROUTES: Readonly<
  Record<Exclude<AssistantPageEntityType, 'doc'>, string>
> = {
  epic: '/api/v1/epics/:workflowId',
  evalDataset: '/api/v1/platform/evals/:id',
  evalRun: '/api/v1/platform/evals/runs/:id',
  organization: '/api/v1/platform/organizations/:orgId',
  run: '/api/v1/workflow-runs/:id',
  team: '/api/v1/teams/:id',
  template: '/api/v1/workflow-templates/:id',
  workflow: '/api/v1/workflows/:id',
};

/**
 * Where the user was when they sent a message: the dashboard route, and the entity it shows when it
 * shows one. The browser says this, so the assistant treats it as a hint to look up, never as proof
 * the user may see the entity: the gateway's own routes decide that when the assistant reads it.
 */
export const assistantPageContextSchema = z.object({
  entityId: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._:@-]+$/, 'an id')
    .optional(),
  entityType: z.enum(ASSISTANT_PAGE_ENTITY_TYPES).optional(),
  /** The dashboard path, e.g. `/runs/0b1c…`. No query string or fragment. */
  route: z
    .string()
    .trim()
    .max(300)
    .regex(/^\/[^?#\s]*$/, 'a path starting with /'),
});
export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;

/** One tool call in a reply, as the panel shows it. */
export interface AssistantToolStep {
  /** The model's tool-call id. */
  id: string;
  tool: string;
  /** The tool's input, as the model sent it. */
  input: unknown;
  status: 'running' | 'done' | 'error';
  /** A short account of the result, for the collapsed step. The full result is in the trace. */
  summary?: string;
}

export type AssistantMessageRoleName = 'USER' | 'ASSISTANT';
export type AssistantMessageStatusName = 'PENDING' | 'STREAMING' | 'COMPLETE' | 'FAILED';

/** A message as the gateway returns it and the panel renders it. */
export interface AssistantMessageView {
  id: string;
  role: AssistantMessageRoleName;
  content: string;
  steps: AssistantToolStep[];
  status: AssistantMessageStatusName;
  pageContext: AssistantPageContext | null;
  error: string | null;
  createdAt: string;
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  titleSource: AssistantTitleSource;
  createdAt: string;
  updatedAt: string;
}

/** A reply that is still being written. */
export function isAssistantReplyOpen(status: AssistantMessageStatusName): boolean {
  return status === 'PENDING' || status === 'STREAMING';
}
