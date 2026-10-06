'use client';

import type { ImplementerRuntimeKind } from '@auto-swe/shared/types/api';
import { type ReactNode, useState } from 'react';
import { ModelSpecPicker } from '@/components/modelConfig/ModelSpecPicker';
import { Combobox } from '@/components/ui/Combobox';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { RadioGroup } from '@/components/ui/RadioGroup';
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
  runtime?: ImplementerRuntimeKind | null;
}

const RUNTIME_OPTIONS: { label: string; value: '' | ImplementerRuntimeKind }[] = [
  { label: 'Default (the workspace.implementerRuntime setting; Mastra for agent runs)', value: '' },
  { label: 'Mastra tool loop', value: 'mastra' },
  { label: 'Claude Code harness (Anthropic models only)', value: 'claude-code' },
];

type FieldName =
  | 'key'
  | 'name'
  | 'description'
  | 'modelSpec'
  | 'inheritsModelFrom'
  | 'systemPrompt'
  | 'skills'
  | 'mcpConnection'
  | 'credential'
  | 'runtime';

/** Per-field hint and placeholder copy — each caller explains the fields in its own terms. */
export type AgentFormCopy = Partial<Record<FieldName, { hint?: string; placeholder?: string }>>;

/** An agent a sub-role can inherit its model from. */
export interface ParentAgentOption {
  key: string;
  name: string;
  modelSpec: string | null;
}

function providerOf(spec: string | null | undefined): string | null {
  const provider = spec?.split('/')[0]?.trim().toLowerCase();
  return provider ? provider : null;
}

/**
 * The create / edit body of an Agent modal, shared by the GLOBAL agent library
 * and the per-team overrides section. `create` adds the key field, the
 * `scopeFields` slot and "(optional)" on the optional labels; `edit` puts name
 * and description side by side. The credential override renders only when
 * `credentials` is passed, and the runtime only with `showRuntime` (changing it
 * takes a platform admin).
 */
export function AgentFormFields({
  copy = {},
  credentials,
  mcpConnections,
  mode,
  onChange,
  parentAgents,
  scopeFields,
  showRuntime = false,
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
  /**
   * Agents whose model a sub-role may inherit. Without it (a caller that cannot read the
   * platform library) the parent is typed as a key.
   */
  parentAgents?: ParentAgentOption[];
  /** Create only: scope pickers rendered under the key / name row. */
  scopeFields?: ReactNode;
  /** Render the runtime picker. Only the platform-admin library may change it. */
  showRuntime?: boolean;
  /** Label on the add-skill Combobox while no skill is attached. */
  skillEditorLabel?: string;
  skillEmptyHint?: string;
  skills: SkillOption[];
  toolKeysInheritHint?: string;
  value: AgentFormValue;
}) {
  const optional = (label: string) => (mode === 'create' ? `${label} (optional)` : label);
  // An own model wins over an inherited one, so a row carrying both starts as "own".
  const [modelMode, setModelMode] = useState<'own' | 'inherit'>(
    !value.modelSpec && value.inheritsModelFrom ? 'inherit' : 'own'
  );
  const parentSpec = parentAgents?.find((a) => a.key === value.inheritsModelFrom)?.modelSpec;
  const modelProvider = providerOf(modelMode === 'own' ? value.modelSpec : parentSpec);
  // A credential only works for its own provider, so offer just the matching ones — plus the
  // one already chosen, so a stale pick stays visible instead of silently vanishing.
  const credentialOptions = (credentials ?? []).filter(
    (c) =>
      !modelProvider || c.provider.toLowerCase() === modelProvider || c.id === value.credentialId
  );
  const toolKeys = value.toolKeys ?? null;

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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {nameInput}
          {descriptionInput}
        </div>
      )}
      <RadioGroup
        legend="Model"
        name="agent-model-mode"
        onChange={(next) => {
          setModelMode(next);
          // The two bindings are alternatives: choosing one clears the other.
          onChange(
            next === 'own' ? { inheritsModelFrom: '' } : { credentialId: null, modelSpec: '' }
          );
        }}
        options={[
          {
            description: 'Pick the exact model this agent calls.',
            label: 'Own model',
            value: 'own',
          },
          {
            description: "Use another agent's model, so changing it there changes it here.",
            label: 'Inherit from another agent',
            value: 'inherit',
          },
        ]}
        value={modelMode}
      />
      {modelMode === 'own' ? (
        <ModelSpecPicker
          hint={copy.modelSpec?.hint}
          kind="CHAT"
          label={optional('Model spec')}
          onChange={(modelSpec) => onChange({ modelSpec })}
          placeholder={copy.modelSpec?.placeholder}
          value={value.modelSpec ?? ''}
        />
      ) : parentAgents ? (
        <Combobox
          hint={copy.inheritsModelFrom?.hint}
          label="Inherit model from"
          onChange={(v) => onChange({ inheritsModelFrom: v })}
          options={parentAgents
            .filter((a) => a.key !== value.key)
            .map((a) => ({
              label: `${a.name} (${a.key})${a.modelSpec ? ` — ${a.modelSpec}` : ''}`,
              textValue: `${a.name} ${a.key}`,
              value: a.key,
            }))}
          placeholder="Choose an agent…"
          value={value.inheritsModelFrom ?? ''}
        />
      ) : (
        <Input
          hint={copy.inheritsModelFrom?.hint}
          label="Inherit model from (agent key)"
          onChange={(e) => onChange({ inheritsModelFrom: e.target.value })}
          placeholder={copy.inheritsModelFrom?.placeholder}
          value={value.inheritsModelFrom ?? ''}
        />
      )}
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
        mcpSelected={Boolean(value.mcpConnectionId)}
        onChange={(v) => onChange({ toolKeys: v })}
        value={toolKeys}
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
      <Combobox
        hint={copy.mcpConnection?.hint}
        label={optional('MCP connection')}
        onChange={(v) => {
          // A custom tool list without `mcp` never loads the server's tools, so tick it for them.
          const needsMcpTool = v && toolKeys !== null && !toolKeys.includes('mcp');
          onChange({
            mcpConnectionId: v || null,
            ...(needsMcpTool ? { toolKeys: [...toolKeys, 'mcp'] } : {}),
          });
        }}
        options={[
          { label: 'None', value: '' },
          ...mcpConnections.map((c) => ({
            label: `${c.name} — ${c.config?.url}`,
            value: c.id,
          })),
        ]}
        value={value.mcpConnectionId ?? ''}
      />
      {showRuntime && (
        <Combobox
          hint={
            copy.runtime?.hint ??
            'The loop that drives this agent where it works in a workspace. Pinned per run the first time the run uses the agent.'
          }
          label={optional('Runtime')}
          onChange={(v) => onChange({ runtime: (v || null) as ImplementerRuntimeKind | null })}
          options={RUNTIME_OPTIONS}
          value={value.runtime ?? ''}
        />
      )}
      {credentials && (
        <Combobox
          hint={copy.credential?.hint}
          label={optional('Credential override')}
          onChange={(v) => onChange({ credentialId: v || null })}
          options={[
            { label: 'None (system default)', value: '' },
            ...credentialOptions.map((c) => ({
              label: `${c.provider} ···${c.lastFour}`,
              value: c.id,
            })),
          ]}
          value={value.credentialId ?? ''}
        />
      )}
    </div>
  );
}
