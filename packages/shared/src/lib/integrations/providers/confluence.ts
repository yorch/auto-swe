import { adfToPlainText } from '../adf.js';
import type { AtlassianClient } from '../atlassianClient.js';
import { AtlassianError } from '../atlassianClient.js';
import type { KnowledgeBaseProvider } from '../knowledgeBase.js';
import type { CreatedPage, KnowledgePage, PageCreateFields, SearchOptions } from '../types.js';

interface ConfluenceProviderConfig {
  maxPages?: number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

interface ConfluencePageV2Response {
  id: string;
  title: string;
  spaceId?: string;
  body?: {
    atlas_doc_format?: { value: string };
    storage?: { value: string };
  };
  version?: { number: number };
  _links?: { webui?: string };
}

interface ConfluenceSearchResult {
  results?: {
    id: string;
    title: string;
    space?: { key?: string };
    body?: { storage?: { value: string } };
    history?: { lastUpdated?: { when?: string } };
    _links?: { webui?: string };
  }[];
}

interface ConfluenceCreateResponse {
  id: string;
  _links?: { webui?: string };
}

export class ConfluenceProvider implements KnowledgeBaseProvider {
  private readonly maxPages: number;
  private readonly log: { warn: (obj: unknown, msg?: string) => void } | undefined;

  constructor(
    private readonly client: AtlassianClient,
    config: ConfluenceProviderConfig
  ) {
    this.maxPages = config.maxPages ?? 5;
    this.log = config.log;
  }

  private baseUrl(): string {
    return this.client.baseUrl;
  }

  async fetchPage(id: string, _opts?: SearchOptions): Promise<KnowledgePage | null> {
    try {
      const page = await this.client.get<ConfluencePageV2Response>(
        `/wiki/api/v2/pages/${encodeURIComponent(id)}?body-format=atlas_doc_format`
      );

      // Try ADF body first, then fall back to storage format plain text
      const adfValue = page.body?.atlas_doc_format?.value;
      let bodyText = '';
      if (adfValue) {
        try {
          bodyText = adfToPlainText(JSON.parse(adfValue)).trim();
        } catch {
          bodyText = adfValue;
        }
      }

      return {
        bodyText,
        id: page.id,
        lastModified: undefined,
        spaceKey: page.spaceId,
        title: page.title,
        url: page._links?.webui
          ? `${this.baseUrl()}${page._links.webui}`
          : `${this.baseUrl()}/wiki/spaces/-/pages/${id}`,
      };
    } catch (err) {
      if (err instanceof AtlassianError && err.code === 'not_found') {
        return null;
      }
      this.log?.warn({ err, pageId: id }, 'Confluence fetchPage failed');
      return null;
    }
  }

  async searchPages(
    query: string,
    spaces: string[],
    opts?: SearchOptions
  ): Promise<KnowledgePage[]> {
    const limit = opts?.maxPages ?? this.maxPages;
    try {
      // CQL string literal: escape the escape character first, then the quotes,
      // so a `\` in the input cannot un-escape the quote that follows it.
      const cqlString = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const spaceList = spaces.map(cqlString).join(',');
      const cql =
        spaces.length > 0
          ? `space in (${spaceList}) AND text~${cqlString(query)}`
          : `text~${cqlString(query)}`;
      const result = await this.client.get<ConfluenceSearchResult>(
        `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=body.storage,space,history.lastUpdated`
      );

      return (result.results ?? []).map((r) => {
        const storageValue = r.body?.storage?.value ?? '';
        // Strip HTML tags for plain text
        const bodyText = storageValue
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          bodyText,
          id: r.id,
          lastModified: r.history?.lastUpdated?.when,
          spaceKey: r.space?.key,
          title: r.title,
          url: r._links?.webui ? `${this.baseUrl()}${r._links.webui}` : '',
        };
      });
    } catch (err) {
      this.log?.warn({ err, query, spaces }, 'Confluence searchPages failed');
      return [];
    }
  }

  async fetchLinkedPages(linkedPageIds: string[], opts?: SearchOptions): Promise<KnowledgePage[]> {
    const limit = opts?.maxPages ?? this.maxPages;
    const ids = linkedPageIds.slice(0, limit);
    const results = await Promise.allSettled(ids.map((id) => this.fetchPage(id, opts)));
    return results
      .filter((r): r is PromiseFulfilledResult<KnowledgePage | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((p): p is KnowledgePage => p !== null);
  }

  async createPage(fields: PageCreateFields, _opts?: SearchOptions): Promise<CreatedPage | null> {
    try {
      // For Confluence Cloud API v2, spaceKey needs to be resolved to spaceId
      // Use legacy API for simplicity
      const body = {
        ancestors: fields.parentPageId ? [{ id: fields.parentPageId }] : undefined,
        body: {
          storage: {
            representation: 'storage',
            value: `<p>${fields.bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
          },
        },
        space: { key: fields.spaceKey },
        title: fields.title,
        type: 'page',
      };

      const created = await this.client.post<ConfluenceCreateResponse>(
        '/wiki/rest/api/content',
        body
      );

      return {
        id: created.id,
        url: created._links?.webui
          ? `${this.baseUrl()}${created._links.webui}`
          : `${this.baseUrl()}/wiki/spaces/${fields.spaceKey}/pages/${created.id}`,
      };
    } catch (err) {
      this.log?.warn({ err, fields }, 'Confluence createPage failed');
      return null;
    }
  }

  async updatePageWithPrLink(pageId: string, prUrl: string, prTitle: string): Promise<void> {
    try {
      // GET current page for version number
      const page = await this.client.get<ConfluencePageV2Response>(
        `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`
      );
      const currentVersion = page.version?.number ?? 1;

      // PATCH to append PR link
      const prSection = `<h3>Pull Request</h3><p><a href="${prUrl}">${prTitle}</a></p>`;
      await this.client.put(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
        body: {
          representation: 'storage',
          value: prSection,
        },
        id: pageId,
        status: 'current',
        title: page.title,
        version: { message: `Added PR link: ${prTitle}`, number: currentVersion + 1 },
      });
    } catch (err) {
      this.log?.warn({ err, pageId, prTitle, prUrl }, 'Confluence updatePageWithPrLink failed');
    }
  }
}
