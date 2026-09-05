/**
 * Best-effort tracker write operations for the PRD decomposition workflow.
 * Delegates to the provider abstraction layer so adding a new tracker
 * requires only a new provider implementation, not changes here.
 *
 * Policy: functions return null on any error — tracker outages never block
 * the implementation queue.
 */

import type { ResolvedIssueTrackerConfig } from './integrations/registry.js';
import { createIssueTrackerProvider } from './integrations/registry.js';
import type { CreatedIssue } from './integrations/types.js';

export interface TrackerEpic {
  title: string;
  description: string;
}

export interface TrackerStory {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  storyPoints: number;
  repoHint?: string;
}

/** @deprecated Use `CreatedIssue` from `@auto-swe/shared`. */
export interface CreatedTrackerItem {
  id: string;
  url: string | null;
  type: 'epic' | 'story';
  title: string;
}

function toCreatedTrackerItem(issue: CreatedIssue, type: 'epic' | 'story'): CreatedTrackerItem {
  return {
    id: issue.id,
    title: issue.title,
    type,
    url: issue.url,
  };
}

/**
 * Create a tracker epic for the given provider. Returns null on any error.
 * The `projectKey` is the Jira project key or Linear team id; ignored for GitHub.
 */
export async function createTrackerEpic(
  config: ResolvedIssueTrackerConfig,
  epic: TrackerEpic,
  projectKey?: string | null
): Promise<CreatedTrackerItem | null> {
  if (!config.provider) {
    return null;
  }
  try {
    const provider = createIssueTrackerProvider(config);
    if (!provider) {
      return null;
    }
    const issue = await provider.createIssue({
      description: epic.description,
      issueType: config.epicIssueType ?? 'Epic',
      projectKey: projectKey ?? config.defaultProjectKey ?? 'BACKLOG',
      title: epic.title,
    });
    if (!issue) {
      return null;
    }
    return toCreatedTrackerItem(issue, 'epic');
  } catch {
    return null;
  }
}

/**
 * Create a tracker story/task under an optional parent epic. Returns null on any error.
 */
export async function createTrackerStory(
  config: ResolvedIssueTrackerConfig,
  story: TrackerStory,
  projectKey?: string | null,
  epicId?: string | null
): Promise<CreatedTrackerItem | null> {
  if (!config.provider) {
    return null;
  }
  const body = [
    story.description,
    '',
    '**Acceptance Criteria:**',
    ...story.acceptanceCriteria.map((c) => `- ${c}`),
  ].join('\n');

  try {
    const provider = createIssueTrackerProvider(config);
    if (!provider) {
      return null;
    }
    const issue = await provider.createIssue({
      description: body,
      issueType: config.storyIssueType ?? 'Story',
      ...(epicId ? { parentId: epicId } : {}),
      projectKey: projectKey ?? config.defaultProjectKey ?? 'BACKLOG',
      storyPoints: story.storyPoints,
      title: story.title,
    });
    if (!issue) {
      return null;
    }
    return toCreatedTrackerItem(issue, 'story');
  } catch {
    return null;
  }
}
