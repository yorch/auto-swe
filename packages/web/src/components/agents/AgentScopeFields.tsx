'use client';

import { Combobox } from '@/components/ui/Combobox';
import { Select } from '@/components/ui/Select';
import type { AgentScope, CreateAgentBody } from '@/hooks/useAgentLibrary';
import { SCOPE_ORDER, scopeHint, scopeLabel } from '@/lib/agentDisplay';

interface Named {
  id: string;
  name: string;
}

/**
 * The scope picker for a new agent, with the one target the chosen scope needs: an organization,
 * team, Slack channel or workflow. Switching scope clears the other targets.
 */
export function AgentScopeFields({
  channels,
  form,
  onChange,
  orgs,
  teams,
  templates,
}: {
  channels: Named[];
  form: CreateAgentBody;
  onChange: (next: CreateAgentBody) => void;
  orgs: Named[];
  teams: Named[];
  templates: Named[];
}) {
  const setScope = (scope: AgentScope) =>
    onChange({
      ...form,
      channelId: scope === 'CHANNEL' ? form.channelId : undefined,
      orgId: scope === 'ORGANIZATION' ? form.orgId : undefined,
      scope,
      teamId: scope === 'TEAM' ? form.teamId : undefined,
      workflowTemplateId: scope === 'WORKFLOW_TEMPLATE' ? form.workflowTemplateId : undefined,
    });
  const options = (rows: Named[]) => rows.map((r) => ({ label: r.name, value: r.id }));
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Select
        hint={scopeHint(form.scope)}
        label="Where it applies"
        onChange={(v) => setScope(v as AgentScope)}
        options={SCOPE_ORDER.map((s) => ({ label: scopeLabel(s), value: s }))}
        value={form.scope}
      />
      {form.scope === 'ORGANIZATION' && (
        <Combobox
          label="Organization"
          onChange={(v) => onChange({ ...form, orgId: v || undefined })}
          options={options(orgs)}
          placeholder="Select an organization…"
          value={form.orgId ?? ''}
        />
      )}
      {form.scope === 'TEAM' && (
        <Combobox
          label="Team"
          onChange={(v) => onChange({ ...form, teamId: v || undefined })}
          options={options(teams)}
          placeholder="Select a team…"
          value={form.teamId ?? ''}
        />
      )}
      {form.scope === 'WORKFLOW_TEMPLATE' && (
        <Combobox
          label="Workflow"
          onChange={(v) => onChange({ ...form, workflowTemplateId: v || undefined })}
          options={options(templates)}
          placeholder="Select a workflow…"
          value={form.workflowTemplateId ?? ''}
        />
      )}
      {form.scope === 'CHANNEL' && (
        <Combobox
          label="Slack channel"
          onChange={(v) => onChange({ ...form, channelId: v || undefined })}
          options={options(channels)}
          placeholder="Select a channel…"
          value={form.channelId ?? ''}
        />
      )}
    </div>
  );
}
