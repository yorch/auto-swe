import type { CreatedPage, KnowledgePage, PageCreateFields, SearchOptions } from './types.js';

export interface KnowledgeBaseProvider {
  fetchPage(id: string, opts?: SearchOptions): Promise<KnowledgePage | null>;
  searchPages(query: string, spaces: string[], opts?: SearchOptions): Promise<KnowledgePage[]>;
  fetchLinkedPages(linkedPageIds: string[], opts?: SearchOptions): Promise<KnowledgePage[]>;
  createPage(fields: PageCreateFields, opts?: SearchOptions): Promise<CreatedPage | null>;
  updatePageWithPrLink(pageId: string, prUrl: string, prTitle: string): Promise<void>;
}
