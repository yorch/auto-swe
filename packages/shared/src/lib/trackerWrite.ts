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
import type { TrackerRepoScope } from './trackerSync.js';
import { isGitHubTicketInScope } from './trackerSync.js';

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

/** The line a refused GitHub project key logs. Fixed: it never carries the key. */
export const TRACKER_PROJECT_OUT_OF_SCOPE =
  'Tracker issue not created: the project is not a repository this run targets';

export interface TrackerWriteOptions {
  /**
   * The repositories the run targets. On the GitHub tracker a caller-supplied `projectKey` is an
   * `owner/repo` the platform token would create issues in, so it is written only when it names
   * one of these; with no scope nothing is written. Unused for Jira and Linear.
   */
  scope?: TrackerRepoScope | null;
  /** Receives {@link TRACKER_PROJECT_OUT_OF_SCOPE}. Default: the console. */
  warn?: (message: string) => void;
}

/**
 * Whether a caller-supplied project key may be written to. Only the GitHub tracker is gated: its
 * key names a repository, checked as the synthetic ticket `<key>#1` against the run's repos and
 * the tracker's host. An absent key falls back to the admin-configured default and is not gated.
 */
function projectKeyAllowed(
  config: ResolvedIssueTrackerConfig,
  projectKey: string | null | undefined,
  opts: TrackerWriteOptions | undefined
): boolean {
  if (config.provider !== 'github' || !projectKey) {
    return true;
  }
  if (opts?.scope && isGitHubTicketInScope(`${projectKey}#1`, config.baseUrl, opts.scope)) {
    return true;
  }
  (opts?.warn ?? console.warn)(TRACKER_PROJECT_OUT_OF_SCOPE);
  return false;
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
  projectKey?: string | null,
  opts?: TrackerWriteOptions
): Promise<CreatedTrackerItem | null> {
  if (!config.provider || !projectKeyAllowed(config, projectKey, opts)) {
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
  epicId?: string | null,
  opts?: TrackerWriteOptions
): Promise<CreatedTrackerItem | null> {
  if (!config.provider || !projectKeyAllowed(config, projectKey, opts)) {
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
