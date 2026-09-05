'use client';

import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { formatDate } from '@/lib/utils';

/** The columns every config audit row carries, whichever endpoint it came from. */
export interface AuditLogEntry {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  actorEmail?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
}

const ACTION_TONES: Record<string, BadgeTone> = {
  CREATE: 'moss',
  DELETE: 'brick',
  UPDATE: 'amber',
};

const ENTITY_LABELS: Record<string, string> = {
  Agent: 'Agent',
  AgentSkillAssignment: 'Agent skill assignment',
  AgentToolConfig: 'Agent tool config',
  CanaryConfig: 'Canary routing',
  ConfigSetting: 'Setting',
  ConsolidationConfig: 'Consolidation schedule',
  EmbeddingConfig: 'Embedding config',
  EvalScheduleConfig: 'Eval schedule',
  FigmaConfig: 'Figma',
  GitHubConfig: 'GitHub',
  GoogleOAuthConfig: 'Google OAuth',
  IssueTrackerConfig: 'Issue tracker',
  KnowledgeBaseConfig: 'Knowledge base',
  ModelRoleConfig: 'Model config',
  ProviderCredential: 'Provider credential',
  RevalidationConfig: 'Revalidation schedule',
  Skill: 'Skill',
  SlackConfig: 'Slack',
  StorageConfig: 'Storage',
  WorkflowDefaults: 'Workflow defaults',
};

const TH = 'px-3 py-2 font-mono uppercase tracking-wider text-paper-500';

/**
 * Config audit log table shared by the integrations and model-config admin
 * tabs. Loading / error / empty are handled here; the last column is a render
 * prop because the two feeds summarise a change differently.
 */
export function AuditLogTable<T extends AuditLogEntry>({
  caption,
  emptyMessage,
  entries,
  error,
  isError,
  isLoading,
  showEntityId = false,
  summary,
  summaryHeader,
}: {
  caption?: ReactNode;
  emptyMessage: ReactNode;
  entries: T[] | undefined;
  error?: unknown;
  isError?: boolean;
  isLoading: boolean;
  /** Append a short entity id after the entity label. */
  showEntityId?: boolean;
  summary: (entry: T) => ReactNode;
  summaryHeader: string;
}) {
  return (
    <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="audit log">
      {!entries || entries.length === 0 ? (
        <EmptyState className="py-0 text-left text-paper-500" title={emptyMessage} />
      ) : (
        <div className="space-y-2">
          {caption && <p className="text-xs text-paper-500">{caption}</p>}
          <div className="overflow-x-auto rounded-sm border border-ink-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-ink-700 bg-ink-900 text-left">
                  <th className={TH}>Time</th>
                  <th className={TH}>What</th>
                  <th className={TH}>Action</th>
                  <th className={TH}>By</th>
                  <th className={TH}>{summaryHeader}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr className="border-b border-ink-800 hover:bg-ink-800/50" key={entry.id}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-paper-400">
                      {formatDate(entry.createdAt, { showSeconds: true })}
                    </td>
                    <td className="px-3 py-2 text-paper-300">
                      {ENTITY_LABELS[entry.entityType] ?? entry.entityType}
                      {showEntityId && (
                        <span className="font-mono text-paper-500">
                          {' '}
                          · {entry.entityId.slice(0, 8)}…
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        className="text-xs font-semibold"
                        tone={ACTION_TONES[entry.action] ?? 'neutral'}
                        variant="text"
                      >
                        {entry.action}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-paper-400">
                      {entry.actorEmail ?? (entry.actorId ? entry.actorId.slice(0, 8) : 'system')}
                    </td>
                    <td className="px-3 py-2 font-mono">{summary(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}
