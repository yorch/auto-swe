'use client';

import type { ReactNode } from 'react';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import type { SkillRefInput } from '@/hooks/useAgentLibrary';
import type { McpConnectionRow } from '@/hooks/useMcpConnections';
import type { ProviderCredentialRow } from '@/hooks/useModelConfig';
import type { SkillOption } from '@/hooks/useSkills';
import { SkillRefEditor, ToolKeysEditor } from './AgentEditorFields';

/** The editable fields of an Agent, shared by the create and edit forms. */
export interface AgentFormValue {
  key?: string;
  name: string;
  description?: string | null;
  modelSpec?: string | null;
  inheritsModelFrom?: string | null;
  systemPrompt?: string | null;
  toolKeys?: string[] | null;
  skillRefs?: SkillRefInput[] | null;
  mcpConnectionId?: string | null;
  credentialId?: string | null;
}

type FieldName =
  | 'key'
  | 'name'
  | 'description'
  | 'modelSpec'
  | 'inheritsModelFrom'
  | 'systemPrompt'
  | 'skills'
  | 'mcpConnection'
  | 'credential';

/** Per-field hint and placeholder copy — each caller explains the fields in its own terms. */
export type AgentFormCopy = Partial<Record<FieldName, { hint?: string; placeholder?: string }>>;

/**
 * The create / edit body of an Agent modal, shared by the GLOBAL agent library
 * and the per-team overrides section. `create` adds the key field, the
 * `scopeFields` slot and "(optional)" on the optional labels; `edit` puts name
 * and description side by side. The credential override renders only when
 * `credentials` is passed.
 */
export function AgentFormFields({
  copy = {},
  credentials,
  mcpConnections,
  mode,
  onChange,
  scopeFields,
  skillEditorLabel,
  skillEmptyHint,
  skills,
  toolKeysInheritHint,
  value,
}: {
  copy?: AgentFormCopy;
  credentials?: ProviderCredentialRow[];
  mcpConnections: McpConnectionRow[];
  mode: 'create' | 'edit';
  onChange: (patch: Partial<AgentFormValue>) => void;
  /** Create only: scope pickers rendered under the key / name row. */
  scopeFields?: ReactNode;
  /** Label on the add-skill Select while no skill is attached. */
  skillEditorLabel?: string;
  skillEmptyHint?: string;
  skills: SkillOption[];
  toolKeysInheritHint?: string;
  value: AgentFormValue;
}) {
  const optional = (label: string) => (mode === 'create' ? `${label} (optional)` : label);

  const nameInput = (
    <Input
      hint={copy.name?.hint}
      label="Name"
      onChange={(e) => onChange({ name: e.target.value })}
      placeholder={copy.name?.placeholder}
      value={value.name}
    />
  );
  const descriptionInput = (
    <Input
      hint={copy.description?.hint}
      label={optional('Description')}
      onChange={(e) => onChange({ description: e.target.value })}
      placeholder={copy.description?.placeholder}
      value={value.description ?? ''}
    />
  );

  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
      {mode === 'create' ? (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Input
              hint={copy.key?.hint}
              label="Key"
              onChange={(e) => onChange({ key: e.target.value })}
              placeholder={copy.key?.placeholder}
              value={value.key ?? ''}
            />
            {nameInput}
          </div>
          {scopeFields}
          {descriptionInput}
        </>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {nameInput}
          {descriptionInput}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Input
          hint={copy.modelSpec?.hint}
          label={optional('Model spec')}
          onChange={(e) => onChange({ modelSpec: e.target.value })}
          placeholder={copy.modelSpec?.placeholder}
          value={value.modelSpec ?? ''}
        />
        <Input
          hint={copy.inheritsModelFrom?.hint}
          label={optional('Inherits model from')}
          onChange={(e) => onChange({ inheritsModelFrom: e.target.value })}
          placeholder={copy.inheritsModelFrom?.placeholder}
          value={value.inheritsModelFrom ?? ''}
        />
      </div>
      <Textarea
        hint={copy.systemPrompt?.hint}
        label={optional('System prompt')}
        onChange={(e) => onChange({ systemPrompt: e.target.value })}
        placeholder={copy.systemPrompt?.placeholder}
        rows={mode === 'create' ? 8 : 10}
        value={value.systemPrompt ?? ''}
      />
      <ToolKeysEditor
        inheritHint={toolKeysInheritHint}
        onChange={(v) => onChange({ toolKeys: v })}
        value={value.toolKeys ?? null}
      />
      <FieldWrapper hint={copy.skills?.hint} label="Skills">
        <SkillRefEditor
          emptyHint={skillEmptyHint}
          label={skillEditorLabel}
          onChange={(refs) => onChange({ skillRefs: refs })}
          refs={value.skillRefs ?? []}
          skills={skills}
        />
      </FieldWrapper>
      <Select
        hint={copy.mcpConnection?.hint}
        label={optional('MCP connection')}
        onChange={(e) => onChange({ mcpConnectionId: e.target.value || null })}
        value={value.mcpConnectionId ?? ''}
      >
        <option value="">None</option>
        {mcpConnections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} — {c.config?.url}
          </option>
        ))}
      </Select>
      {credentials && (
        <Select
          hint={copy.credential?.hint}
          label={optional('Credential override')}
          onChange={(e) => onChange({ credentialId: e.target.value || null })}
          value={value.credentialId ?? ''}
        >
          <option value="">None (system default)</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.provider} ···{c.lastFour}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
