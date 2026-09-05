import type { KnowledgeBaseProvider } from '../knowledgeBase.js';
import type { ResolvedKnowledgeBaseConfig } from '../registry.js';
import type { CreatedPage, KnowledgePage, PageCreateFields, SearchOptions } from '../types.js';

// ---- Notion API response shapes ----

interface NotionRichText {
  plain_text?: string;
  text?: { content: string };
  annotations?: { bold?: boolean };
}

interface NotionPageProperties {
  title?: { title?: NotionRichText[] };
  Name?: { title?: NotionRichText[] };
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  url: string;
  object: string;
  parent?: {
    type?: string;
    database_id?: string;
    page_id?: string;
  };
  properties?: NotionPageProperties;
}

interface NotionBlock {
  type?: string;
  paragraph?: { rich_text?: NotionRichText[] };
  heading_1?: { rich_text?: NotionRichText[] };
  heading_2?: { rich_text?: NotionRichText[] };
  heading_3?: { rich_text?: NotionRichText[] };
  bulleted_list_item?: { rich_text?: NotionRichText[] };
  numbered_list_item?: { rich_text?: NotionRichText[] };
  quote?: { rich_text?: NotionRichText[] };
  callout?: { rich_text?: NotionRichText[] };
  code?: { rich_text?: NotionRichText[] };
}

interface NotionBlocksResponse {
  results?: NotionBlock[];
}

interface NotionSearchResponse {
  results?: NotionPage[];
}

interface NotionCreatePageResponse {
  id: string;
  url: string;
  properties?: NotionPageProperties;
}

// ---- helpers ----

function extractTitle(page: NotionPage): string {
  const props = page.properties;
  if (!props) {
    return '';
  }
  // Notion pages created via integration often use 'title' or 'Name'
  const titleProp = props.title ?? props.Name;
  return titleProp?.title?.[0]?.plain_text ?? '';
}

function richTextToPlain(richText: NotionRichText[] | undefined): string {
  return (richText ?? []).map((rt) => rt.plain_text ?? '').join('');
}

function blocksToPlainText(blocks: NotionBlock[]): string {
  return blocks
    .map((block) => {
      const type = block.type;
      if (!type) {
        return '';
      }
      const richText = (block as Record<string, { rich_text?: NotionRichText[] } | undefined>)[type]
        ?.rich_text;
      return richTextToPlain(richText);
    })
    .filter(Boolean)
    .join('\n');
}

// ---- provider ----

export class NotionKnowledgeBaseProvider implements KnowledgeBaseProvider {
  private readonly baseUrl = 'https://api.notion.com/v1';

  constructor(private readonly config: ResolvedKnowledgeBaseConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        Authorization: `Bearer ${this.config.apiToken ?? ''}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      method,
      // Fetched best-effort at submit time; a stalled upstream must not hold
      // the submission open. Same bound as the Linear client.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw Object.assign(new Error('Not found'), { status: 404 });
      }
      throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  async fetchPage(pageId: string, _opts?: SearchOptions): Promise<KnowledgePage | null> {
    try {
      const [page, blocksResp] = await Promise.all([
        this.request<NotionPage>('GET', `/pages/${encodeURIComponent(pageId)}`),
        this.request<NotionBlocksResponse>('GET', `/blocks/${encodeURIComponent(pageId)}/children`),
      ]);

      const title = extractTitle(page);
      const bodyText = blocksToPlainText(blocksResp.results ?? []);

      return {
        bodyText,
        id: page.id,
        title,
        url: page.url,
      };
    } catch {
      // Best-effort: any failure (network, 404, parse) yields null so a
      // knowledge-base miss never blocks the caller.
      return null;
    }
  }

  async searchPages(
    query: string,
    spaces: string[],
    opts?: SearchOptions
  ): Promise<KnowledgePage[]> {
    const limit = opts?.maxPages ?? this.config.maxPages ?? 10;
    try {
      const resp = await this.request<NotionSearchResponse>('POST', '/search', {
        filter: { property: 'object', value: 'page' },
        page_size: limit,
        query,
      });

      let results = resp.results ?? [];

      // If spaces (Notion database IDs) are provided, filter to pages whose parent
      // is one of those databases.
      if (spaces.length > 0) {
        const spaceSet = new Set(spaces.map((s) => s.replace(/-/g, '')));
        results = results.filter((page) => {
          if (page.parent?.type !== 'database_id') {
            return false;
          }
          const dbId = (page.parent.database_id ?? '').replace(/-/g, '');
          return spaceSet.has(dbId);
        });
      }

      return results.slice(0, limit).map((page) => ({
        bodyText: '',
        id: page.id,
        title: extractTitle(page),
        url: page.url,
      }));
    } catch {
      return [];
    }
  }

  async fetchLinkedPages(linkedPageIds: string[], opts?: SearchOptions): Promise<KnowledgePage[]> {
    const limit = opts?.maxPages ?? this.config.maxPages ?? 10;
    const ids = linkedPageIds.slice(0, limit);
    const results = await Promise.allSettled(ids.map((id) => this.fetchPage(id, opts)));
    return results
      .filter((r): r is PromiseFulfilledResult<KnowledgePage | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((p): p is KnowledgePage => p !== null);
  }

  async createPage(fields: PageCreateFields, _opts?: SearchOptions): Promise<CreatedPage | null> {
    try {
      // Determine parent: prefer explicit parentPageId, then first space as database, else skip
      const parentPageId = fields.parentPageId;
      const firstSpace = this.config.spaces[0];

      let parent: Record<string, unknown>;
      if (parentPageId) {
        parent = { page_id: parentPageId, type: 'page_id' };
      } else if (firstSpace) {
        parent = { database_id: firstSpace, type: 'database_id' };
      } else {
        // No valid parent — cannot create without one
        return null;
      }

      const resp = await this.request<NotionCreatePageResponse>('POST', '/pages', {
        children: [
          {
            object: 'block',
            paragraph: {
              rich_text: [
                {
                  text: { content: fields.bodyText.slice(0, 2000) },
                  type: 'text',
                },
              ],
            },
            type: 'paragraph',
          },
        ],
        parent,
        properties: {
          // Notion databases use 'Name', standalone pages use 'title'
          Name: { title: [{ text: { content: fields.title }, type: 'text' }] },
          title: { title: [{ text: { content: fields.title }, type: 'text' }] },
        },
      });

      return {
        id: resp.id,
        url: resp.url,
      };
    } catch {
      return null;
    }
  }

  async updatePageWithPrLink(pageId: string, prUrl: string, prTitle: string): Promise<void> {
    try {
      await this.request('PATCH', `/blocks/${encodeURIComponent(pageId)}/children`, {
        children: [
          {
            object: 'block',
            paragraph: {
              rich_text: [
                {
                  annotations: { bold: true },
                  text: { content: `${prTitle}: ` },
                  type: 'text',
                },
                {
                  text: { content: prUrl, link: { url: prUrl } },
                  type: 'text',
                },
              ],
            },
            type: 'paragraph',
          },
        ],
      });
    } catch {
      // Advisory — do not throw to callers
    }
  }
}
