import { AtlassianClient } from './atlassianClient.js';
import type { FigmaDesignProvider } from './figmaDesign.js';
import type { IssueTrackerProvider } from './issueTracker.js';
import type { KnowledgeBaseProvider } from './knowledgeBase.js';
import { ConfluenceProvider } from './providers/confluence.js';
import { FigmaProvider } from './providers/figma.js';
import { GitHubIssuesProvider } from './providers/githubIssues.js';
import { JiraProvider } from './providers/jira.js';
import { LinearProvider } from './providers/linear.js';
import { NotionKnowledgeBaseProvider } from './providers/notion.js';

export interface ResolvedIssueTrackerConfig {
  provider: 'jira' | 'linear' | 'github' | null;
  instanceType?: string;
  baseUrl: string | null;
  email: string | null;
  apiToken: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  storyPointsFieldId?: string;
  epicIssueType?: string;
  storyIssueType?: string;
  defaultProjectKey?: string;
  webhookSecret?: string;
  webhookTriggerStatus?: string;
}

export interface ResolvedKnowledgeBaseConfig {
  provider: 'confluence' | 'notion' | null;
  enabled: boolean;
  baseUrl: string | null;
  email: string | null;
  apiToken: string | null;
  spaces: string[];
  maxPages?: number;
}

export interface ResolvedFigmaConfig {
  enabled: boolean;
  apiToken: string | null;
  maxNodes?: number;
}

export function createIssueTrackerProvider(
  config: ResolvedIssueTrackerConfig,
  opts?: { log?: { warn: (obj: unknown, msg?: string) => void } }
): IssueTrackerProvider | null {
  if (!config.provider || !config.apiToken) {
    return null;
  }
  switch (config.provider) {
    case 'jira': {
      if (!config.baseUrl || !config.email) {
        return null;
      }
      const client = new AtlassianClient({
        apiToken: config.apiToken,
        baseUrl: config.baseUrl,
        email: config.email,
        maxRetries: config.maxRetries,
        timeoutMs: config.timeoutMs,
      });
      return new JiraProvider(client, {
        defaultProjectKey: config.defaultProjectKey,
        epicIssueType: config.epicIssueType,
        log: opts?.log,
        storyIssueType: config.storyIssueType,
        storyPointsFieldId: config.storyPointsFieldId,
      });
    }
    case 'linear': {
      return new LinearProvider(config.apiToken, { log: opts?.log });
    }
    case 'github': {
      return new GitHubIssuesProvider({
        apiToken: config.apiToken,
        baseUrl: config.baseUrl ?? undefined,
        log: opts?.log,
      });
    }
    default:
      return null;
  }
}

export function createKnowledgeBaseProvider(
  config: ResolvedKnowledgeBaseConfig,
  opts?: { log?: { warn: (obj: unknown, msg?: string) => void } }
): KnowledgeBaseProvider | null {
  if (!config.provider || !config.enabled || !config.apiToken) {
    return null;
  }
  switch (config.provider) {
    case 'confluence': {
      if (!config.baseUrl || !config.email) {
        return null;
      }
      const client = new AtlassianClient({
        apiToken: config.apiToken,
        baseUrl: config.baseUrl,
        email: config.email,
      });
      return new ConfluenceProvider(client, { log: opts?.log, maxPages: config.maxPages });
    }
    case 'notion': {
      return new NotionKnowledgeBaseProvider(config);
    }
    default:
      return null;
  }
}

export function createFigmaDesignProvider(config: ResolvedFigmaConfig): FigmaDesignProvider | null {
  if (!config.enabled || !config.apiToken) {
    return null;
  }
  return new FigmaProvider(config);
}
