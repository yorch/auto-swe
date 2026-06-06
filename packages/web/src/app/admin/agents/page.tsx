'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ROLE_LABELS } from '@/lib/agentRoles';
import { api } from '@/lib/api';

interface AgentRoleSummary {
  role: string;
  globalSkillCount: number;
}

function useAgentRoles() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: AgentRoleSummary[] }>('/api/v1/admin/agents').then((r) => r.data),
    queryKey: ['admin-agents'],
  });
}

export default function AdminAgentsPage() {
  const { data: roles, isLoading } = useAgentRoles();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Agent Roles</h2>
        <p className="mt-1 text-sm text-paper-400">
          View and configure skill assignments for each agent role. Click a role to manage its
          skills and system prompt.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Roles</CardTitle>
        </CardHeader>
        {isLoading ? (
          <div className="py-8 text-center text-sm text-paper-400">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-600">
                <th className="py-2 text-left text-xs text-paper-500">Role</th>
                <th className="py-2 text-left text-xs text-paper-500">Global Skills</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {(roles ?? []).map((r) => (
                <tr className="border-b border-ink-600 last:border-0" key={r.role}>
                  <td className="py-3 pr-4">
                    <span className="font-medium text-paper-100">
                      {ROLE_LABELS[r.role] ?? r.role}
                    </span>
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-paper-500">
                      {r.role}
                    </span>
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-paper-400">{r.globalSkillCount}</td>
                  <td className="py-3 text-right">
                    <Link
                      className="font-mono text-[11px] uppercase tracking-wider text-ember-400 hover:text-ember-300"
                      href={`/admin/agents/${r.role}`}
                    >
                      Manage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
