'use client';

import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { formatDate, formatRelativeTime } from '@/lib/utils';

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
  Connection: 'Connection',
  ConsolidationConfig: 'Consolidation schedule',
  EmbeddingConfig: 'Embedding config',
  EvalScheduleConfig: 'Eval schedule',
  FigmaConfig: 'Figma',
  GitHubConfig: 'GitHub',
  GoogleOAuthConfig: 'Google OAuth',
  IssueTrackerConfig: 'Issue tracker',
  KnowledgeBaseConfig: 'Knowledge base',
  ModelCatalogEntry: 'Model catalog',
  ModelRoleConfig: 'Model config',
  ModelSuggestion: 'Model suggestion',
  OktaOAuthConfig: 'Okta OAuth',
  ProviderCredential: 'Provider credential',
  RevalidationConfig: 'Revalidation schedule',
  Skill: 'Skill',
  SlackConfig: 'Slack',
  StorageConfig: 'Storage',
  WorkflowDefaults: 'Workflow defaults',
};

const ACTION_LABELS: Record<string, string> = {
  CREATE: 'Created',
  DELETE: 'Deleted',
  UPDATE: 'Changed',
};

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
  isFetching,
  isLoading,
  onRetry,
  showEntityId = false,
  summary,
  summaryHeader,
}: {
  caption?: ReactNode;
  emptyMessage: ReactNode;
  entries: T[] | undefined;
  error?: unknown;
  isError?: boolean;
  isFetching?: boolean;
  isLoading: boolean;
  /** Re-runs the failed query; shows a Retry button on the error alert. */
  onRetry?: () => void;
  /** Append a short entity id after the entity label. */
  showEntityId?: boolean;
  summary: (entry: T) => ReactNode;
  summaryHeader: string;
}) {
  return (
    <QueryBoundary
      error={error}
      isError={isError}
      isFetching={isFetching}
      isLoading={isLoading}
      label="audit log"
      onRetry={onRetry}
    >
      {!entries || entries.length === 0 ? (
        <EmptyState icon="list" title={emptyMessage} />
      ) : (
        <div className="space-y-3">
          {caption && <p className="text-xs text-paper-500">{caption}</p>}
          <Table stacked>
            <THead>
              <Th className="pl-0" variant="plain">
                What
              </Th>
              <Th variant="plain">Action</Th>
              <Th variant="plain">By</Th>
              <Th variant="plain">{summaryHeader}</Th>
              <Th className="pr-0" variant="plain">
                When
              </Th>
            </THead>
            <tbody>
              {entries.map((entry) => (
                <TRow hover key={entry.id}>
                  <Td className="py-2.5 pr-4" primary>
                    <span className="text-[13px] font-medium text-paper-100">
                      {ENTITY_LABELS[entry.entityType] ?? entry.entityType}
                    </span>
                    {showEntityId && (
                      <span
                        className="block font-mono text-xs font-normal text-paper-500"
                        title={entry.entityId}
                      >
                        {entry.entityId.slice(0, 8)}…
                      </span>
                    )}
                  </Td>
                  <Td className="px-4 py-2.5" label="Action">
                    <Badge tone={ACTION_TONES[entry.action] ?? 'neutral'} variant="outline">
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </Badge>
                  </Td>
                  <Td className="px-4 py-2.5 text-[13px] text-paper-300" label="By">
                    {entry.actorEmail ??
                      (entry.actorId ? (
                        <span className="font-mono text-xs" title={entry.actorId}>
                          {entry.actorId.slice(0, 8)}
                        </span>
                      ) : (
                        <span className="text-paper-500">System</span>
                      ))}
                  </Td>
                  <Td
                    className="px-4 py-2.5 font-mono text-xs break-words text-paper-300"
                    label={summaryHeader}
                  >
                    {summary(entry)}
                  </Td>
                  <Td className="py-2.5 pl-4 text-[13px] text-paper-400" label="When">
                    <time
                      className="whitespace-nowrap tabular-nums"
                      dateTime={entry.createdAt}
                      title={formatDate(entry.createdAt, { showSeconds: true })}
                    >
                      {formatRelativeTime(entry.createdAt)}
                    </time>
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </QueryBoundary>
  );
}
