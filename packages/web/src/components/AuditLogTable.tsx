'use client';

import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
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
  ModelSuggestion: 'Model suggestion',
  ProviderCredential: 'Provider credential',
  RevalidationConfig: 'Revalidation schedule',
  Skill: 'Skill',
  SlackConfig: 'Slack',
  StorageConfig: 'Storage',
  WorkflowDefaults: 'Workflow defaults',
};

const TH = 'px-3 py-2';
const TD = 'px-3 py-2';

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
          <div className="overflow-x-auto rounded-sm border border-ink-600">
            <Table className="text-xs">
              <THead className="bg-ink-900">
                <Th className={TH}>Time</Th>
                <Th className={TH}>What</Th>
                <Th className={TH}>Action</Th>
                <Th className={TH}>By</Th>
                <Th className={TH}>{summaryHeader}</Th>
              </THead>
              <tbody>
                {entries.map((entry) => (
                  <TRow hover key={entry.id}>
                    <Td className={`whitespace-nowrap font-mono text-paper-400 ${TD}`}>
                      {formatDate(entry.createdAt, { showSeconds: true })}
                    </Td>
                    <Td className={`text-paper-300 ${TD}`}>
                      {ENTITY_LABELS[entry.entityType] ?? entry.entityType}
                      {showEntityId && (
                        <span className="font-mono text-paper-500">
                          {' '}
                          · {entry.entityId.slice(0, 8)}…
                        </span>
                      )}
                    </Td>
                    <Td className={TD}>
                      <Badge
                        className="text-xs font-semibold"
                        tone={ACTION_TONES[entry.action] ?? 'neutral'}
                        variant="text"
                      >
                        {entry.action}
                      </Badge>
                    </Td>
                    <Td className={`text-paper-400 ${TD}`}>
                      {entry.actorEmail ?? (entry.actorId ? entry.actorId.slice(0, 8) : 'system')}
                    </Td>
                    <Td className={`font-mono ${TD}`}>{summary(entry)}</Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}
