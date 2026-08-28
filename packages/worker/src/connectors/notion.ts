import { ApplicationFailure } from '@temporalio/activity';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_TIMEOUT_MS = 30_000;

/**
 * Minimal Notion block representation used by the connector. Teams can pass
 * richer blocks through the payload; unknown shapes are forwarded as-is.
 */
export interface NotionBlock {
  [key: string]: unknown;
  type: string;
}

export interface NotionPage {
  id: string;
  object: 'page';
  properties: Record<string, unknown>;
  url: string;
}

export interface NotionPageContent {
  blocks: NotionBlock[];
  page: NotionPage;
}

interface NotionConnectionLike {
  apiToken: string;
}

function notionHeaders(apiToken: string) {
  return {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };
}

async function notionFetch<T>(
  connection: NotionConnectionLike,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${NOTION_API_BASE}${path}`;
  const timeoutSignal = AbortSignal.timeout(NOTION_TIMEOUT_MS);
  const response = await fetch(url, {
    ...init,
    headers: {
      ...notionHeaders(connection.apiToken),
      ...(init.headers ?? {}),
    },
    signal: init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    const status = response.status;
    if (status === 401 || status === 403) {
      throw ApplicationFailure.nonRetryable(
        `Notion API authentication failed (${status}): ${body}`
      );
    }
    if (status === 404) {
      throw ApplicationFailure.nonRetryable(`Notion resource not found (${status}): ${body}`);
    }
    if (status >= 500 || status === 429) {
      throw ApplicationFailure.create({
        message: `Notion API transient error (${status}): ${body}`,
        type: 'NotionTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`Notion API error (${status}): ${body}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Read a Notion page and its immediate block children.
 */
export async function readNotionPage(
  connection: NotionConnectionLike,
  pageId: string
): Promise<NotionPageContent> {
  const [page, blocks] = await Promise.all([
    notionFetch<NotionPage>(connection, `/pages/${pageId}`),
    notionFetch<{ results: NotionBlock[] }>(connection, `/blocks/${pageId}/children?page_size=100`),
  ]);
  return { blocks: blocks.results, page };
}

/**
 * Append blocks to an existing Notion page.
 */
export async function appendNotionBlocks(
  connection: NotionConnectionLike,
  pageId: string,
  blocks: NotionBlock[]
): Promise<{ pageId: string; appended: number }> {
  await notionFetch<{ results: NotionBlock[] }>(connection, `/blocks/${pageId}/children`, {
    body: JSON.stringify({ children: blocks }),
    method: 'PATCH',
  });
  return { appended: blocks.length, pageId };
}

/**
 * Create a new Notion page as a child of a page or a database.
 */
export async function createNotionPage(
  connection: NotionConnectionLike,
  options: {
    databaseId?: string;
    pageId?: string;
    properties?: Record<string, unknown>;
    title?: string;
  }
): Promise<{ pageId: string; url: string }> {
  const parent = options.databaseId
    ? { database_id: options.databaseId }
    : { page_id: options.pageId };
  if (!parent.database_id && !parent.page_id) {
    throw ApplicationFailure.nonRetryable('createNotionPage requires databaseId or pageId');
  }

  const properties = { ...(options.properties ?? {}) };
  if (options.title) {
    properties.title = {
      title: [{ text: { content: options.title } }],
    };
  }

  const page = await notionFetch<NotionPage>(connection, '/pages', {
    body: JSON.stringify({ parent, properties }),
    method: 'POST',
  });

  return { pageId: page.id, url: page.url };
}
