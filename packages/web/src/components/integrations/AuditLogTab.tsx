'use client';

import { useConfigAuditLog } from '@/hooks/useAdminConfig';
import { formatDate } from '@/lib/utils';

const ACTION_COLORS = {
  CREATE: 'text-emerald-400',
  DELETE: 'text-brick-400',
  UPDATE: 'text-amber-400',
} as const;

const ENTITY_LABELS: Record<string, string> = {
  AgentSkillAssignment: 'Agent skill assignment',
  AgentToolConfig: 'Agent tool config',
  EmbeddingConfig: 'Embedding config',
  GitHubConfig: 'GitHub',
  GoogleOAuthConfig: 'Google OAuth',
  ModelRoleConfig: 'Model config',
  ProviderCredential: 'Provider credential',
  Skill: 'Skill',
  SlackConfig: 'Slack',
  StorageConfig: 'Storage',
};

function ChangedFields({ json }: { json: unknown }) {
  if (!json || typeof json !== 'object') {
    return null;
  }
  const obj = json as Record<string, unknown>;
  const fields = obj.changedFields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return null;
  }
  return <span className="text-paper-500">{(fields as string[]).join(', ')}</span>;
}

export function AuditLogTab() {
  const { data: entries, isLoading, error } = useConfigAuditLog(200);

  if (isLoading) {
    return <p className="text-sm text-paper-400">Loading…</p>;
  }

  if (error) {
    return <p className="text-sm text-brick-400">Failed to load audit log.</p>;
  }

  if (!entries || entries.length === 0) {
    return (
      <p className="text-sm text-paper-500">
        No config changes recorded yet. Changes to model config, credentials, and integration
        settings will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-paper-500">
        Showing the last {entries.length} config changes. Secret values are never recorded.
      </p>
      <div className="overflow-x-auto rounded-sm border border-ink-700">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-ink-700 bg-ink-900 text-left">
              <th className="px-3 py-2 font-mono uppercase tracking-wider text-paper-500">Time</th>
              <th className="px-3 py-2 font-mono uppercase tracking-wider text-paper-500">What</th>
              <th className="px-3 py-2 font-mono uppercase tracking-wider text-paper-500">
                Action
              </th>
              <th className="px-3 py-2 font-mono uppercase tracking-wider text-paper-500">By</th>
              <th className="px-3 py-2 font-mono uppercase tracking-wider text-paper-500">
                Fields
              </th>
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
                </td>
                <td
                  className={`px-3 py-2 font-mono font-semibold ${ACTION_COLORS[entry.action] ?? 'text-paper-300'}`}
                >
                  {entry.action}
                </td>
                <td className="px-3 py-2 text-paper-400">
                  {entry.actorEmail ?? (entry.actorId ? entry.actorId.slice(0, 8) : '—')}
                </td>
                <td className="px-3 py-2 font-mono">
                  <ChangedFields json={entry.afterJson} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
