'use client';

/**
 * Per-node-type inspector sections for the TemplateEditor's right rail.
 * Each section edits the selected node's type-specific fields and emits the
 * whole patched node back through `onChange`. Extracted from
 * TemplateEditor.tsx.
 */

import type { Node as SpecNode, StepMetadata } from '@auto-swe/shared/workflow';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useHasRole } from '@/hooks/useHasRole';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { errMsg } from '@/lib/errors';
import { isRecord } from '@/lib/utils';
import { OnFailSection, SchemaAwareForm } from './inspectorFields';

export function StepConfigSection({
  node,
  stepMeta,
  stepRegistry,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'step' }>;
  stepMeta: StepMetadata | null;
  stepRegistry: StepMetadata[];
  onChange: (next: SpecNode) => void;
}) {
  return (
    <div className="space-y-4">
      <datalist id="step-registry-datalist">
        {stepRegistry.map((s) => (
          <option key={s.name} value={s.name}>
            {s.label}
          </option>
        ))}
      </datalist>
      <Input
        compact
        hint={stepMeta?.label ?? 'type or pick a step from the registry'}
        label="Step"
        list="step-registry-datalist"
        onChange={(e) => onChange({ ...node, step: e.target.value })}
        value={node.step}
      />
      {stepMeta?.description && (
        <p className="text-[11px] leading-relaxed text-paper-400">{stepMeta.description}</p>
      )}
      {stepMeta && stepMeta.configFields.length > 0 && (
        <SchemaAwareForm
          fields={stepMeta.configFields}
          onChange={(k, v) => {
            const cur = node.config ?? {};
            const next = { ...cur };
            if (v === undefined) {
              delete next[k];
            } else {
              next[k] = v;
            }
            onChange({ ...node, config: next });
          }}
          values={node.config ?? {}}
        />
      )}
      {stepMeta && stepMeta.configFields.length === 0 && (
        <EmptyState className="py-0 text-left text-xs" title="No configurable fields." />
      )}
      {node.step && !stepMeta && (
        <Alert className="text-xs" variant="warning">
          Step not in registry — config schema unknown
        </Alert>
      )}
      <OnFailSection onChange={(v) => onChange({ ...node, onFail: v })} value={node.onFail} />
    </div>
  );
}

export function CondSection({ expr, onChange }: { expr: string; onChange: (v: string) => void }) {
  return (
    <Input
      compact
      hint="JS-like expression evaluated against the workflow context"
      label="Expression"
      onChange={(e) => onChange(e.target.value)}
      placeholder="ctx.foo === 'bar'"
      value={expr}
    />
  );
}

export function SignalSection({
  name,
  timeout,
  onNameChange,
  onTimeoutChange,
}: {
  name: string;
  timeout: string;
  onNameChange: (v: string) => void;
  onTimeoutChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Input
        compact
        label="Signal name"
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="e.g. human.approval"
        value={name}
      />
      <Input
        compact
        hint="Duration string — fires onTimeout if exceeded"
        label="Timeout"
        onChange={(e) => onTimeoutChange(e.target.value)}
        placeholder="24h"
        value={timeout}
      />
    </div>
  );
}

export function FanOutSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'fanOut' }>;
  onChange: (next: SpecNode) => void;
}) {
  const overFrom = node.over && 'from' in node.over ? (node.over as { from: string }).from : '';
  const [exportsText, setExportsText] = useState<string>(() => (node.exports ?? []).join('\n'));
  // Re-seed only when the node's own exports actually change. Keyed on the
  // serialized value rather than the array identity, so a parent re-render that
  // hands back an equal-but-new array cannot wipe what the user is typing —
  // and so the effect has a real dependency instead of running every render.
  const serializedExports = (node.exports ?? []).join('\n');
  const seededExportsRef = useRef(serializedExports);
  useEffect(() => {
    if (seededExportsRef.current !== serializedExports) {
      seededExportsRef.current = serializedExports;
      setExportsText(serializedExports);
    }
  }, [serializedExports]);

  return (
    <div className="space-y-3">
      <Input
        compact
        hint="Context path that yields the parallel items (array)"
        label="Over (from path)"
        onChange={(e) => onChange({ ...node, over: { from: e.target.value } })}
        placeholder="ctx.targets"
        value={overFrom}
      />
      <Input
        compact
        hint="Name each element is bound under inside the per-branch context"
        label="Item key"
        onChange={(e) => onChange({ ...node, itemKey: e.target.value })}
        placeholder="subtask"
        value={node.itemKey ?? 'subtask'}
      />
      <Select
        compact
        id="fanout-branch-fail"
        label="On branch fail"
        onChange={(v) => {
          if (v === 'block' || v === 'continue') {
            onChange({ ...node, onBranchFail: v });
          }
        }}
        options={[
          { label: 'Block (default) — stop on first failure', value: 'block' },
          { label: 'Continue — collect all results', value: 'continue' },
        ]}
        value={node.onBranchFail ?? 'block'}
      />
      <Input
        compact
        id="fanout-concurrency"
        label="Max concurrency"
        max={20}
        min={1}
        onChange={(e) => {
          const v =
            e.target.value === '' ? undefined : Math.max(1, Math.min(20, Number(e.target.value)));
          onChange({ ...node, concurrency: v });
        }}
        placeholder="4 (default)"
        type="number"
        value={node.concurrency ?? ''}
      />
      <Input
        compact
        hint="Dot-path projected from each branch result into output.plucked — e.g. result.branch"
        label="Pluck path"
        onChange={(e) => onChange({ ...node, pluck: e.target.value || undefined })}
        placeholder="result.branch"
        value={node.pluck ?? ''}
      />
      <Textarea
        className="h-20"
        compact
        hint="Context paths that flow back to the parent scope after the fan-out joins."
        id="fanout-exports"
        label="Exports (one per line)"
        onBlur={() => {
          const exports = exportsText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          onChange({ ...node, exports: exports.length > 0 ? exports : undefined });
        }}
        onChange={(e) => setExportsText(e.target.value)}
        placeholder="ctx.result"
        spellCheck={false}
        value={exportsText}
      />
    </div>
  );
}

export function ShellSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'shell' }>;
  onChange: (next: SpecNode) => void;
}) {
  return (
    <div className="space-y-3">
      <Alert className="text-xs" variant="warning">
        Shell — elevated privileges · team-admin authoring only
      </Alert>
      <Input
        compact
        hint="Must be on the team's image allowlist"
        id="shell-image"
        label="Container image"
        onChange={(e) => onChange({ ...node, image: e.target.value })}
        placeholder="node:24-alpine"
        value={node.image ?? ''}
      />
      <Textarea
        className="h-24"
        compact
        id="shell-command"
        label="Command"
        onChange={(e) => onChange({ ...node, command: e.target.value })}
        placeholder="echo hello"
        spellCheck={false}
        value={node.command ?? ''}
      />
      <Select
        compact
        id="shell-network"
        label="Network"
        onChange={(v) => {
          if (v === 'none' || v === 'egress') {
            onChange({ ...node, network: v === 'none' ? undefined : v });
          }
        }}
        options={[
          { label: 'None (default) — no outbound access', value: 'none' },
          { label: 'Egress — outbound via team allowlist', value: 'egress' },
        ]}
        value={node.network ?? 'none'}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          compact
          id="shell-memory"
          label="Memory limit"
          onChange={(e) => onChange({ ...node, memory: e.target.value || undefined })}
          placeholder="512m"
          value={node.memory ?? ''}
        />
        <Input
          compact
          id="shell-cpus"
          label="CPUs"
          max={8}
          min={0.1}
          onChange={(e) =>
            onChange({
              ...node,
              cpus: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
          placeholder="1"
          step={0.1}
          type="number"
          value={node.cpus ?? ''}
        />
      </div>
      <OnFailSection onChange={(v) => onChange({ ...node, onFail: v })} value={node.onFail} />
    </div>
  );
}

export function ContainerStepSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'containerStep' }>;
  onChange: (next: SpecNode) => void;
}) {
  return (
    <div className="space-y-3">
      <Alert className="text-xs" variant="warning">
        Container step — coded capability · team-admin authoring only
      </Alert>
      <Input
        compact
        hint="Must be on the team's image allowlist"
        id="container-image"
        label="Container image"
        onChange={(e) => onChange({ ...node, image: e.target.value })}
        placeholder="ghcr.io/acme/my-capability:1.0"
        value={node.image ?? ''}
      />
      <Textarea
        className="h-20"
        compact
        hint="Reads JSON from $CONTAINER_STEP_INPUT, prints a JSON result to stdout"
        id="container-command"
        label="Command"
        onChange={(e) => onChange({ ...node, command: e.target.value || undefined })}
        placeholder="node /app/run.js"
        spellCheck={false}
        value={node.command ?? ''}
      />
      <Select
        compact
        id="container-network"
        label="Network"
        onChange={(v) => {
          if (v === 'none' || v === 'egress') {
            onChange({ ...node, network: v === 'none' ? undefined : v });
          }
        }}
        options={[
          { label: 'None (default) — no outbound access', value: 'none' },
          { label: 'Egress — outbound via team allowlist', value: 'egress' },
        ]}
        value={node.network ?? 'none'}
      />
      <OnFailSection onChange={(v) => onChange({ ...node, onFail: v })} value={node.onFail} />
    </div>
  );
}

type TerminateStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED';

const TERMINATE_STATUSES = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED'] as const;

export function TerminateSection({
  status,
  onChange,
}: {
  status: TerminateStatus;
  onChange: (v: TerminateStatus) => void;
}) {
  return (
    <Select
      compact
      id="terminate-status"
      label="Status"
      onChange={(v) => {
        if ((TERMINATE_STATUSES as readonly string[]).includes(v)) {
          onChange(v as TerminateStatus);
        }
      }}
      options={TERMINATE_STATUSES.map((s) => ({ label: s, value: s }))}
      value={status}
    />
  );
}

export function SetSection({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const serialized = JSON.stringify(values, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [err, setErr] = useState<string | null>(null);

  // `values` is a fresh object on every parent render, so re-seeding on its
  // identity reset the JSON the user was mid-way through typing. Key on the
  // serialized value instead: it only changes when the node's values really do.
  const seededRef = useRef(serialized);
  useEffect(() => {
    if (seededRef.current !== serialized) {
      seededRef.current = serialized;
      setDraft(serialized);
    }
  }, [serialized]);

  return (
    <Textarea
      className="h-40"
      compact
      error={err ?? undefined}
      id="set-values"
      label="Values (JSON)"
      onBlur={() => {
        try {
          const parsed: unknown = JSON.parse(draft);
          if (isRecord(parsed)) {
            setErr(null);
            onChange(parsed);
          } else {
            setErr('Must be a JSON object');
          }
        } catch (e) {
          setErr(errMsg(e, 'invalid JSON'));
        }
      }}
      onChange={(e) => setDraft(e.target.value)}
      spellCheck={false}
      value={draft}
    />
  );
}

export function AgentSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'agent' }>;
  onChange: (next: SpecNode) => void;
}) {
  return (
    <div className="space-y-4">
      <Input
        compact
        hint="library agent: <key> or <key>@<version>"
        label="Agent reference"
        onChange={(e) => onChange({ ...node, agentRef: e.target.value })}
        value={node.agentRef}
      />
      <Textarea
        className="h-20"
        compact
        hint="Literal prompt (else node inputs as JSON)"
        id="agent-user-message"
        label="userMessage"
        onChange={(e) => onChange({ ...node, userMessage: e.target.value || undefined })}
        spellCheck={false}
        value={node.userMessage ?? ''}
      />
      <Textarea
        className="h-20"
        compact
        hint="Per-node prompt override (optional)"
        id="agent-system-prompt"
        label="systemPrompt"
        onChange={(e) => onChange({ ...node, systemPrompt: e.target.value || undefined })}
        spellCheck={false}
        value={node.systemPrompt ?? ''}
      />
      <OnFailSection onChange={(v) => onChange({ ...node, onFail: v })} value={node.onFail} />
    </div>
  );
}

export function McpSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'mcp' }>;
  onChange: (next: SpecNode) => void;
}) {
  // The connection list is an ADMIN-only route. A team LEAD authoring their
  // team's template cannot read it, so they get the id as a plain field
  // (keeping whatever the node already holds) instead of a picker that 403s
  // and hides the current value behind an empty placeholder.
  const isPlatformAdmin = useHasRole('ADMIN');
  const {
    data: connections,
    error: connectionsError,
    isLoading: connectionsLoading,
  } = useMcpConnections({ enabled: isPlatformAdmin });
  return (
    <div className="space-y-4">
      {!isPlatformAdmin ? (
        <Input
          compact
          hint="MCP connection id — ask a platform admin for it (connections are managed at /studio/mcp)"
          label="Connection"
          onChange={(e) => onChange({ ...node, connectionRef: e.target.value })}
          value={node.connectionRef}
        />
      ) : (
        <>
          {connectionsError && (
            <Alert>{errMsg(connectionsError, 'Failed to load MCP connections')}</Alert>
          )}
          <Combobox
            compact
            emptyMessage="No connections match"
            hint="Choose an active MCP connection (managed at /studio/mcp)"
            label="Connection"
            onChange={(v) => onChange({ ...node, connectionRef: v })}
            options={(connections ?? []).map((c) => ({
              label: `${c.name} (${c.team?.name ?? c.teamId})`,
              value: c.id,
            }))}
            placeholder={connectionsLoading ? 'Loading connections…' : 'Select an MCP connection…'}
            value={node.connectionRef}
          />
          {!connectionsLoading && !connectionsError && (connections ?? []).length === 0 && (
            <EmptyState className="py-0 text-left text-xs" title="No MCP connections configured." />
          )}
        </>
      )}
      <Input
        compact
        hint="tool name exposed by the MCP server; its args come from Inputs below"
        label="Tool"
        onChange={(e) => onChange({ ...node, tool: e.target.value })}
        value={node.tool}
      />
      <OnFailSection onChange={(v) => onChange({ ...node, onFail: v })} value={node.onFail} />
    </div>
  );
}
