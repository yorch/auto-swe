import type { CreatedPage, KnowledgePage, PageCreateFields, SearchOptions } from './types.js';

/// Why a connectivity check failed, by class. The message is a fixed string chosen from the class,
/// never text copied from the remote service.
export type KnowledgeBaseConnectionFailure = 'credentials' | 'failed' | 'not_found' | 'unreachable';

export class KnowledgeBaseConnectionError extends Error {
  constructor(public readonly kind: KnowledgeBaseConnectionFailure) {
    super(KNOWLEDGE_BASE_FAILURE_MESSAGES[kind]);
    this.name = 'KnowledgeBaseConnectionError';
  }
}

export const KNOWLEDGE_BASE_FAILURE_MESSAGES: Record<KnowledgeBaseConnectionFailure, string> = {
  credentials: 'The service rejected the credentials. Check the API token (and email, if used).',
  failed: 'The service answered with an error. Try again, or check the service status.',
  not_found: 'Nothing was found at that address. Check the base URL.',
  unreachable: 'The service could not be reached. Check the base URL and your network.',
};

/// Maps an HTTP status to a failure class. `undefined` means no response arrived at all.
export function classifyConnectionStatus(
  status: number | undefined
): KnowledgeBaseConnectionFailure {
  if (status === undefined || status === 0) {
    return 'unreachable';
  }
  if (status === 401 || status === 403) {
    return 'credentials';
  }
  if (status === 404) {
    return 'not_found';
  }
  return 'failed';
}

export interface KnowledgeBaseProvider {
  /// Throws `KnowledgeBaseConnectionError` when the service cannot be reached or rejects the
  /// credentials. Unlike `searchPages`, which degrades to an empty result at run time, this
  /// surfaces the failure so a connection test cannot report success on a wrong token or URL.
  testConnection(spaces: string[]): Promise<void>;
  fetchPage(id: string, opts?: SearchOptions): Promise<KnowledgePage | null>;
  searchPages(query: string, spaces: string[], opts?: SearchOptions): Promise<KnowledgePage[]>;
  fetchLinkedPages(linkedPageIds: string[], opts?: SearchOptions): Promise<KnowledgePage[]>;
  createPage(fields: PageCreateFields, opts?: SearchOptions): Promise<CreatedPage | null>;
  updatePageWithPrLink(pageId: string, prUrl: string, prTitle: string): Promise<void>;
}
