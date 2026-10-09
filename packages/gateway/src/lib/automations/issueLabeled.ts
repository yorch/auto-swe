/**
 * The `github.issues.labeled` event source's webhook side: an `issues` delivery normalized into
 * an occurrence for the engine. Everything that is never acted on is ignored here, before any
 * query: another action, a closed issue, a pull request, a bot.
 */
import type { IssueLabeledFacts } from '@auto-swe/shared/automation';
import { z } from 'zod';
import type { Occurrence } from './engine.js';

const IssuesWebhookSchema = z.object({
  action: z.string(),
  issue: z.object({
    body: z.string().nullish(),
    html_url: z.string(),
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
    state: z.string(),
    title: z.string(),
    updated_at: z.string(),
  }),
  label: z.object({ name: z.string() }).optional(),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
  sender: z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() }),
});

export type IssueEvent =
  | ({ type: 'labeled' } & Occurrence<IssueLabeledFacts>)
  | { type: 'unrecognized' }
  | { type: 'ignored'; reason: string };

/** Pure mapping from an `issues` webhook body to the labelling an automation may act on. */
export function normalizeIssueLabeledEvent(body: unknown): IssueEvent {
  const parsed = IssuesWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const { action, issue, label, repository, sender } = parsed.data;
  if (action !== 'labeled' || !label) {
    return { reason: `action ${action}`, type: 'ignored' };
  }
  if (issue.state !== 'open') {
    return { reason: 'the issue is not open', type: 'ignored' };
  }
  if (issue.pull_request !== undefined) {
    return { reason: 'a pull request, not an issue', type: 'ignored' };
  }
  // A bot or an App (the platform's own included) is never a person who asked.
  if (sender.type !== 'User') {
    return { reason: `labelled by a ${sender.type}, not a person`, type: 'ignored' };
  }
  const name = label.name.trim();
  if (name.length === 0 || name.length > 50) {
    return { reason: 'the label name is not usable', type: 'ignored' };
  }
  const [org, repoName] = repository.full_name.split('/');
  if (!org || !repoName) {
    return { type: 'unrecognized' };
  }
  return {
    facts: {
      body: (issue.body ?? '').slice(0, 4_000),
      htmlUrl: issue.html_url.slice(0, 500),
      issueNumber: issue.number,
      label: name,
      senderId: String(sender.id),
      senderLogin: sender.login.slice(0, 100),
      title: issue.title.slice(0, 256),
      updatedAt: issue.updated_at.slice(0, 40),
    },
    org,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
    repoName,
    type: 'labeled',
  };
}
