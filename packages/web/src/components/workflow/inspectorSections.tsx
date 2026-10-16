'use client';

/**
 * Per-node-type inspector sections for the TemplateEditor's right rail.
 * Each section edits the selected node's type-specific fields and emits the
 * whole patched node back through `onChange`. Extracted from
 * TemplateEditor.tsx.
 */

import type { Node as SpecNode, StepMetadata } from '@auto-swe/shared/workflow';
import {
  BindingSchema,
  isAuthoredCommandNode,
  isValidWaitDuration,
} from '@auto-swe/shared/workflow';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useHasRole } from '@/hooks/useHasRole';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { errMsg } from '@/lib/errors';
import { AUTHORED_COMMAND_NOTE, CONTAINER_AUTHORING_RULE } from './containerNodes';
import {
  BindingField,
  BindingRow,
  bindingFitsForm,
  InputsBindingsSection,
  InspectorNote,
  InspectorSubsection,
  OnFailSection,
  SchemaAwareForm,
  useListKeys,
} from './inspectorFields';

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
        className="font-mono text-xs"
        compact
        hint={stepMeta?.label ?? 'Type or pick a step from the registry'}
        label="Step"
        list="step-registry-datalist"
        onChange={(e) => onChange({ ...node, step: e.target.value })}
        value={node.step}
      />
      {stepMeta?.description && (
        <p className="text-xs leading-relaxed text-paper-400">{stepMeta.description}</p>
      )}
      {isAuthoredCommandNode(node) && <AuthoredCommandAlert />}
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
        <InspectorNote>This step has no settings.</InspectorNote>
      )}
      {node.step && !stepMeta && (
        <Alert className="text-xs" variant="warning">
          This step is not in the registry, so its settings cannot be checked
        </Alert>
      )}
      <OnFailSection
        onChange={(v) => onChange({ ...node, onFail: v })}
        onError={node.onError}
        onOnErrorChange={(v) => onChange({ ...node, onError: v })}
        value={node.onFail}
      />
    </div>
  );
}

export function CondSection({ expr, onChange }: { expr: string; onChange: (v: string) => void }) {
  return (
    <Input
      className="font-mono text-xs"
      compact
      hint="A JavaScript-like expression evaluated against the workflow context"
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
  storeAs,
  onNameChange,
  onTimeoutChange,
  onStoreAsChange,
}: {
  name: string;
  timeout: string;
  storeAs: string;
  onNameChange: (v: string) => void;
  onTimeoutChange: (v: string) => void;
  onStoreAsChange: (v: string) => void;
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
      <TimeoutField
        hint="The timeout edge fires when this passes without a signal"
        onChange={onTimeoutChange}
        value={timeout}
      />
      <Input
        className="font-mono text-xs"
        compact
        hint="Optional. Context path the received payload is written to."
        label="Store payload at"
        onChange={(e) => onStoreAsChange(e.target.value)}
        placeholder="context.ciResult"
        value={storeAs}
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
      <BindingField
        binding={node.over}
        hint="The array of items to run in parallel: a context path, an expression, or a literal array"
        label="Items"
        onChange={(over) => {
          // Editing the path of a `{ from, default }` keeps its default.
          const prev = node.over as { default?: unknown } | undefined;
          const keep = prev && 'default' in prev && 'from' in over;
          onChange({ ...node, over: keep ? { ...over, default: prev.default } : over });
        }}
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
          { label: 'Stop on the first failure (default)', value: 'block' },
          { label: 'Continue and collect every result', value: 'continue' },
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
        hint="Dot path copied from each branch result into output.plucked"
        label="Pluck path"
        onChange={(e) => onChange({ ...node, pluck: e.target.value || undefined })}
        placeholder="result.branch"
        value={node.pluck ?? ''}
      />
      <Textarea
        className="h-20 font-mono text-xs"
        compact
        hint="Context paths that flow back to the parent once the branches join"
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

/** The warning on a node that carries a command its author wrote; who may save one. */
function AuthoredCommandAlert() {
  return (
    <Alert className="text-xs" title="Authored command" variant="warning">
      {AUTHORED_COMMAND_NOTE} {CONTAINER_AUTHORING_RULE}
    </Alert>
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
      <Alert className="text-xs" title="Elevated node" variant="warning">
        Runs a command in a container. {CONTAINER_AUTHORING_RULE}
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
        className="h-24 font-mono text-xs"
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
      <Input
        compact
        hint="Wall clock for the command. The worker caps it at 50 minutes."
        id="shell-timeout"
        label="Timeout (ms)"
        min={1000}
        onChange={(e) =>
          onChange({
            ...node,
            timeoutMs: e.target.value === '' ? undefined : Number(e.target.value),
          })
        }
        placeholder="600000"
        type="number"
        value={node.timeoutMs ?? ''}
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
      <OnFailSection
        onChange={(v) => onChange({ ...node, onFail: v })}
        onError={node.onError}
        onOnErrorChange={(v) => onChange({ ...node, onError: v })}
        value={node.onFail}
      />
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
      <Alert className="text-xs" title="Elevated node" variant="warning">
        Runs a coded capability in a container. {CONTAINER_AUTHORING_RULE}
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
        className="h-20 font-mono text-xs"
        compact
        hint="Reads JSON from $CONTAINER_STEP_INPUT and prints a JSON result to stdout"
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
      <Select
        compact
        hint="How the container returns its result. `stdout` prints one JSON object; `ndjson` streams events and takes the last result; `sidecar` runs the image as a local HTTP server."
        id="container-transport"
        label="Transport"
        onChange={(v) => {
          if (v === 'stdout' || v === 'ndjson' || v === 'sidecar') {
            onChange({ ...node, transport: v === 'stdout' ? undefined : v });
          }
        }}
        options={[
          { label: 'Single JSON object on stdout (default)', value: 'stdout' },
          { label: 'NDJSON event stream', value: 'ndjson' },
          { label: 'Sidecar HTTP server', value: 'sidecar' },
        ]}
        value={node.transport ?? 'stdout'}
      />
      {node.transport === 'sidecar' && (
        <Input
          compact
          hint="The port the image listens on. The worker posts the inputs and binds the JSON response."
          id="container-sidecar-port"
          label="Sidecar port"
          max={65535}
          min={1}
          onChange={(e) =>
            onChange({
              ...node,
              sidecar:
                e.target.value === ''
                  ? undefined
                  : { ...node.sidecar, port: Number(e.target.value) },
            })
          }
          placeholder="8080"
          type="number"
          value={node.sidecar?.port ?? ''}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        <Input
          compact
          id="container-memory"
          label="Memory limit"
          onChange={(e) => onChange({ ...node, memory: e.target.value || undefined })}
          placeholder="512m"
          value={node.memory ?? ''}
        />
        <Input
          compact
          id="container-cpus"
          label="CPUs"
          max={8}
          min={0.1}
          onChange={(e) =>
            onChange({ ...node, cpus: e.target.value === '' ? undefined : Number(e.target.value) })
          }
          placeholder="1"
          step={0.1}
          type="number"
          value={node.cpus ?? ''}
        />
      </div>
      <Input
        compact
        hint="Wall clock for the container. The worker caps it at 50 minutes."
        id="container-timeout"
        label="Timeout (ms)"
        min={1000}
        onChange={(e) =>
          onChange({
            ...node,
            timeoutMs: e.target.value === '' ? undefined : Number(e.target.value),
          })
        }
        placeholder="600000"
        type="number"
        value={node.timeoutMs ?? ''}
      />
      <OnFailSection
        onChange={(v) => onChange({ ...node, onFail: v })}
        onError={node.onError}
        onOnErrorChange={(v) => onChange({ ...node, onError: v })}
        value={node.onFail}
      />
    </div>
  );
}

type TerminateStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED';

const TERMINATE_STATUSES = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED'] as const;

const TERMINATE_LABEL: Record<TerminateStatus, string> = {
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  SUCCESS: 'Success',
  TIMED_OUT: 'Timed out',
};

export function TerminateSection({
  status,
  result,
  onChange,
  onResultChange,
}: {
  status: TerminateStatus;
  /** The run's final result map. Schema-valid but previously uneditable. */
  result: Record<string, unknown>;
  onChange: (v: TerminateStatus) => void;
  onResultChange: (v: Record<string, unknown> | undefined) => void;
}) {
  return (
    <div className="space-y-3">
      <Select
        compact
        hint="The status the run ends with when it reaches this node"
        id="terminate-status"
        label="End status"
        onChange={(v) => {
          if ((TERMINATE_STATUSES as readonly string[]).includes(v)) {
            onChange(v as TerminateStatus);
          }
        }}
        options={TERMINATE_STATUSES.map((s) => ({ label: TERMINATE_LABEL[s], value: s }))}
        value={status}
      />
      <InputsBindingsSection
        inputs={result as Record<string, never>}
        note="No result. Add one to expose a value on the run's final output."
        onChange={(v) => onResultChange(v)}
        title="Result"
      />
    </div>
  );
}

export function SetSection({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(values);
  // Positional keys: a rename must not remount the row the user is typing in.
  const rowKeys = useListKeys(entries.length);
  const [keyError, setKeyError] = useState<string | null>(null);

  const setValue = (key: string, next: unknown) => onChange({ ...values, [key]: next });
  const removeRow = (key: string) => {
    onChange(Object.fromEntries(entries.filter(([k]) => k !== key)));
  };
  const addRow = () => {
    let k = 'value';
    let n = 2;
    while (Object.hasOwn(values, k)) {
      k = `value_${n++}`;
    }
    onChange({ ...values, [k]: { from: '' } });
  };
  // Rebuilds the record so a renamed row keeps its position. False: not applied.
  const renameRow = (oldKey: string, rawKey: string) => {
    const newKey = rawKey.trim();
    if (!newKey || newKey === oldKey) {
      setKeyError(null);
      return false;
    }
    if (Object.hasOwn(values, newKey)) {
      setKeyError(`“${newKey}” is already set by another row`);
      return false;
    }
    setKeyError(null);
    onChange(Object.fromEntries(entries.map(([k, v]) => [k === oldKey ? newKey : k, v])));
    return true;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-paper-400">
          Each row writes a value to a context path.
        </p>
        <Button onClick={addRow} size="sm" variant="ghost">
          <Icon name="plus" size={13} />
          Add
        </Button>
      </div>
      {entries.length === 0 && (
        <InspectorNote>No values. Add a row to set a context path.</InspectorNote>
      )}
      {keyError && (
        <Alert className="text-xs" variant="warning">
          {keyError}
        </Alert>
      )}
      {entries.map(([key, val], i) => (
        <SetRow
          key={rowKeys[i]}
          keyName={key}
          onChange={(next) => setValue(key, next)}
          onRemove={() => removeRow(key)}
          onRename={(next) => renameRow(key, next)}
          value={val}
        />
      ))}
    </div>
  );
}

/** One `set` row: the binding form when it can hold the value exactly, else JSON. */
function SetRow({
  keyName,
  value,
  onChange,
  onRename,
  onRemove,
}: {
  keyName: string;
  value: unknown;
  onChange: (next: unknown) => void;
  onRename: (next: string) => boolean;
  onRemove: () => void;
}) {
  const keyControl = <RowKeyInput keyName={keyName} onCommit={onRename} />;
  return bindingFitsForm(value) ? (
    <BindingRow
      binding={value}
      keyControl={keyControl}
      onChange={onChange}
      onRemove={onRemove}
      removeLabel={`Remove ${keyName}`}
    />
  ) : (
    <RawJsonRow
      keyControl={keyControl}
      keyName={keyName}
      onChange={onChange}
      onRemove={onRemove}
      value={value}
    />
  );
}

/**
 * The context-path field of a `set` row. Holds its own draft and commits on
 * blur; `onCommit` returns false when the edit was refused, which restores the
 * stored name. Re-syncs when the stored name changes under it (a row removed
 * above this one shifts which key this positional row shows).
 */
function RowKeyInput({
  keyName,
  onCommit,
}: {
  keyName: string;
  onCommit: (next: string) => boolean;
}) {
  const [draft, setDraft] = useState(keyName);
  useEffect(() => {
    setDraft(keyName);
  }, [keyName]);
  return (
    <Input
      aria-label="Context path"
      className="font-mono text-xs"
      compact
      onBlur={() => {
        if (!onCommit(draft)) {
          setDraft(keyName);
        }
      }}
      onChange={(e) => setDraft(e.target.value)}
      placeholder="context path"
      value={draft}
    />
  );
}

/**
 * A `set` row whose value the path / expression / literal form cannot hold
 * exactly. Shown as the JSON it is, so opening the inspector never rewrites it.
 */
function RawJsonRow({
  keyControl,
  keyName,
  value,
  onChange,
  onRemove,
}: {
  keyControl: ReactNode;
  keyName: string;
  value: unknown;
  onChange: (next: unknown) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  const [draft, setDraft] = useState(serialized);
  const [err, setErr] = useState<string | null>(null);
  // Re-seed only when the stored value really changes, not on every parent render.
  const seededRef = useRef(serialized);
  useEffect(() => {
    if (seededRef.current !== serialized) {
      seededRef.current = serialized;
      setDraft(serialized);
      setErr(null);
    }
  }, [serialized]);

  const commit = () => {
    if (draft === serialized) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setErr(errMsg(e, 'invalid JSON'));
      return;
    }
    if (!BindingSchema.safeParse(parsed).success) {
      setErr('Must be { "from": … }, { "literal": … } or { "expr": … }');
      return;
    }
    setErr(null);
    onChange(parsed);
  };

  return (
    <div className="space-y-1.5 rounded-md border border-ink-600 bg-ink-900/40 p-2">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">{keyControl}</div>
        <Button
          aria-label={`Remove ${keyName}`}
          className="px-2 hover:text-brick-400"
          onClick={onRemove}
          size="sm"
          title="Remove row"
          variant="ghost"
        >
          <Icon name="close" size={14} />
        </Button>
      </div>
      <Textarea
        aria-label={`Value for ${keyName} (JSON)`}
        className="h-20 font-mono text-xs"
        compact
        error={err ?? undefined}
        hint="This binding has no form; edit it as JSON. Applied when you leave the field"
        id={id}
        onBlur={commit}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        value={draft}
      />
    </div>
  );
}

/** `spanName` of an agent node: labels its trace span and its usage and cost records. */
function SpanNameField({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'agent' }>;
  onChange: (next: SpecNode) => void;
}) {
  return (
    <Input
      compact
      hint="Optional. Labels this node’s trace span and usage records; defaults to llm.agent_node"
      id="agent-span-name"
      label="Span name"
      onChange={(e) => onChange({ ...node, spanName: e.target.value || undefined })}
      value={node.spanName ?? ''}
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
        className="font-mono text-xs"
        compact
        hint="A library agent key, optionally pinned as key@version"
        label="Agent"
        onChange={(e) => onChange({ ...node, agentRef: e.target.value })}
        value={node.agentRef}
      />
      <Textarea
        className="h-20"
        compact
        hint="Optional. Without it, the agent receives the node inputs as JSON"
        id="agent-user-message"
        label="User message"
        onChange={(e) => onChange({ ...node, userMessage: e.target.value || undefined })}
        spellCheck={false}
        value={node.userMessage ?? ''}
      />
      <Textarea
        className="h-20"
        compact
        hint="Optional. Overrides the agent’s prompt for this node only"
        id="agent-system-prompt"
        label="System prompt"
        onChange={(e) => onChange({ ...node, systemPrompt: e.target.value || undefined })}
        spellCheck={false}
        value={node.systemPrompt ?? ''}
      />
      <SpanNameField node={node} onChange={onChange} />
      <Checkbox
        checked={node.workspace === true}
        hint="Clones the run’s repository for the agent to read; nothing it changes is kept. Runs on the agent’s own runtime"
        label="Run in a checkout of the repository"
        onChange={(e) => onChange({ ...node, workspace: e.target.checked || undefined })}
      />
      <OnFailSection
        onChange={(v) => onChange({ ...node, onFail: v })}
        onError={node.onError}
        onOnErrorChange={(v) => onChange({ ...node, onError: v })}
        value={node.onFail}
      />
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
          className="font-mono text-xs"
          compact
          hint="The MCP connection ID. Ask a platform admin for it; connections live under Build → MCP connections"
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
            hint="An active MCP connection, managed under Build → MCP connections"
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
            <InspectorNote>No MCP connections are configured yet.</InspectorNote>
          )}
        </>
      )}
      <Input
        className="font-mono text-xs"
        compact
        hint="A tool the server exposes; its arguments come from the input bindings"
        label="Tool"
        onChange={(e) => onChange({ ...node, tool: e.target.value })}
        value={node.tool}
      />
      <OnFailSection
        onChange={(v) => onChange({ ...node, onFail: v })}
        onError={node.onError}
        onOnErrorChange={(v) => onChange({ ...node, onError: v })}
        value={node.onFail}
      />
    </div>
  );
}

/**
 * The four human nodes and `eval` share the same shape of problem: their
 * settings live in nested structures (option and field lists, scorer lists) or
 * in fields the canvas never surfaced, so the only way to change them was JSON
 * mode. These sections are the form for that.
 *
 * `title` is not here: it is the approver's inbox heading and the node's name on
 * the canvas, so `NodeMetaFields` owns it for every node type.
 */

/** A `wait` field on a human node or a `signal`. */
function TimeoutField({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  hint: string;
}) {
  const valid = isValidWaitDuration(value);
  return (
    <Input
      compact
      hint={valid ? hint : "Not a duration Temporal can parse — try '30m', '24h' or '7d'."}
      id="hitl-timeout"
      label="Timeout"
      onChange={(e) => onChange(e.target.value)}
      placeholder="24h"
      value={value}
    />
  );
}

function DescriptionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Textarea
      className="h-20 text-xs"
      compact
      hint="Shown to whoever answers, under the title"
      id="hitl-description"
      label="Instructions"
      onChange={(e) => onChange(e.target.value)}
      placeholder="What should they check before answering?"
      value={value}
    />
  );
}

function StoreAsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      className="font-mono text-xs"
      compact
      hint="Context path the answer is written to, e.g. context.decision"
      id="hitl-store-as"
      label="Store answer at"
      onChange={(e) => onChange(e.target.value)}
      placeholder="context.decision"
      value={value}
    />
  );
}

export function HumanApprovalSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'humanApproval' }>;
  onChange: (next: SpecNode) => void;
}) {
  return (
    <div className="space-y-3">
      <DescriptionField
        onChange={(description) => onChange({ ...node, description: description || undefined })}
        value={node.description ?? ''}
      />
      <Input
        compact
        hint="Context path whose value is shown to the approver, e.g. nodes.dryRun.output.summary"
        id="approval-context-from"
        label="Context to show"
        onChange={(e) => onChange({ ...node, contextFrom: e.target.value || undefined })}
        placeholder="context.summary"
        value={node.contextFrom ?? ''}
      />
      <BindingField
        allowExpr={false}
        binding={node.approverCount}
        hint="How many distinct people must approve. Leave empty for one. A binding that resolves to anything but a positive integer means one approver."
        label="Distinct approvers"
        onChange={(approverCount) => onChange({ ...node, approverCount })}
      />
      <TimeoutField
        hint="How long the run waits before taking the timeout edge"
        onChange={(timeout) => onChange({ ...node, timeout })}
        value={node.timeout}
      />
    </div>
  );
}

export function HumanDecisionSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'humanDecision' }>;
  onChange: (next: SpecNode) => void;
}) {
  const options = node.options;
  const rowKeys = useListKeys(options.length);
  const setOption = (i: number, patch: Partial<(typeof options)[number]>) => {
    onChange({ ...node, options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  };
  const addOption = () => {
    if (options.length >= 10) {
      return;
    }
    // A new option needs somewhere to go; the parallel edge dropdowns retarget it.
    const target = options[0]?.next ?? node.onTimeout;
    let value = 'option';
    let n = 2;
    while (options.some((o) => o.value === value)) {
      value = `option_${n++}`;
    }
    onChange({
      ...node,
      options: [...options, { label: `Option ${options.length + 1}`, next: target, value }],
    });
  };
  const removeOption = (i: number) => {
    if (options.length <= 2) {
      return;
    }
    onChange({ ...node, options: options.filter((_, j) => j !== i) });
  };

  return (
    <div className="space-y-3">
      <DescriptionField
        onChange={(description) => onChange({ ...node, description: description || undefined })}
        value={node.description ?? ''}
      />
      <InspectorSubsection title={`Options (${options.length} of 2–10)`}>
        {options.map((option, i) => (
          <div
            className="space-y-1.5 rounded-md border border-ink-600 bg-ink-900/40 p-2"
            key={rowKeys[i]}
          >
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label={`Option ${i + 1} value`}
                  className="font-mono text-xs"
                  compact
                  onChange={(e) => setOption(i, { value: e.target.value })}
                  placeholder="value"
                  value={option.value}
                />
              </div>
              <Button
                aria-label={`Remove option ${i + 1}`}
                className="px-2 hover:text-brick-400"
                disabled={options.length <= 2}
                onClick={() => removeOption(i)}
                size="sm"
                title={options.length <= 2 ? 'A decision needs at least two options' : 'Remove'}
                variant="ghost"
              >
                <Icon name="close" size={14} />
              </Button>
            </div>
            <Input
              aria-label={`Option ${i + 1} label`}
              compact
              onChange={(e) => setOption(i, { label: e.target.value })}
              placeholder="What the person sees"
              value={option.label}
            />
          </div>
        ))}
        <Button disabled={options.length >= 10} onClick={addOption} size="sm" variant="ghost">
          <Icon name="plus" size={13} />
          Add option
        </Button>
      </InspectorSubsection>
      <StoreAsField
        onChange={(storeAs) => onChange({ ...node, storeAs: storeAs || undefined })}
        value={node.storeAs ?? ''}
      />
      <TimeoutField
        hint="How long the run waits before taking the timeout edge"
        onChange={(timeout) => onChange({ ...node, timeout })}
        value={node.timeout}
      />
    </div>
  );
}

type HumanFieldType = 'text' | 'number' | 'boolean' | 'select';

export function HumanInputSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'humanInput' }>;
  onChange: (next: SpecNode) => void;
}) {
  const fields = node.fields;
  const rowKeys = useListKeys(fields.length);
  const setField = (i: number, patch: Partial<(typeof fields)[number]>) => {
    onChange({ ...node, fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  };
  const addField = () => {
    if (fields.length >= 20) {
      return;
    }
    let key = 'field';
    let n = 2;
    while (fields.some((f) => f.key === key)) {
      key = `field_${n++}`;
    }
    onChange({
      ...node,
      fields: [...fields, { key, label: `Field ${fields.length + 1}`, type: 'text' }],
    });
  };
  const removeField = (i: number) => {
    if (fields.length <= 1) {
      return;
    }
    onChange({ ...node, fields: fields.filter((_, j) => j !== i) });
  };

  return (
    <div className="space-y-3">
      <DescriptionField
        onChange={(description) => onChange({ ...node, description: description || undefined })}
        value={node.description ?? ''}
      />
      <InspectorSubsection title={`Fields (${fields.length} of 1–20)`}>
        {fields.map((field, i) => (
          <div
            className="space-y-1.5 rounded-md border border-ink-600 bg-ink-900/40 p-2"
            key={rowKeys[i]}
          >
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label={`Field ${i + 1} key`}
                  className="font-mono text-xs"
                  compact
                  onChange={(e) => setField(i, { key: e.target.value })}
                  placeholder="key"
                  value={field.key}
                />
              </div>
              <Select
                aria-label={`Field ${i + 1} type`}
                className="w-auto"
                compact
                onChange={(v) => setField(i, { type: v as HumanFieldType })}
                options={[
                  { label: 'Text', value: 'text' },
                  { label: 'Number', value: 'number' },
                  { label: 'Boolean', value: 'boolean' },
                  { label: 'Select', value: 'select' },
                ]}
                value={field.type}
              />
              <Button
                aria-label={`Remove field ${i + 1}`}
                className="px-2 hover:text-brick-400"
                disabled={fields.length <= 1}
                onClick={() => removeField(i)}
                size="sm"
                title={fields.length <= 1 ? 'A form needs at least one field' : 'Remove'}
                variant="ghost"
              >
                <Icon name="close" size={14} />
              </Button>
            </div>
            <Input
              aria-label={`Field ${i + 1} label`}
              compact
              onChange={(e) => setField(i, { label: e.target.value })}
              placeholder="What the person sees"
              value={field.label}
            />
            {field.type === 'select' && (
              <Input
                aria-label={`Field ${i + 1} options`}
                compact
                hint="Comma-separated choices"
                onChange={(e) =>
                  setField(i, {
                    options: e.target.value
                      .split(',')
                      .map((o) => o.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="yes, no, maybe"
                value={(field.options ?? []).join(', ')}
              />
            )}
            <Checkbox
              checked={field.required === true}
              label="Required"
              onChange={(e) => setField(i, { required: e.target.checked || undefined })}
            />
          </div>
        ))}
        <Button disabled={fields.length >= 20} onClick={addField} size="sm" variant="ghost">
          <Icon name="plus" size={13} />
          Add field
        </Button>
      </InspectorSubsection>
      <StoreAsField
        onChange={(storeAs) => onChange({ ...node, storeAs: storeAs || undefined })}
        value={node.storeAs ?? ''}
      />
      <TimeoutField
        hint="How long the run waits before taking the timeout edge"
        onChange={(timeout) => onChange({ ...node, timeout })}
        value={node.timeout}
      />
    </div>
  );
}

export function HumanReviewSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'humanReview' }>;
  onChange: (next: SpecNode) => void;
}) {
  return (
    <div className="space-y-3">
      <DescriptionField
        onChange={(description) => onChange({ ...node, description: description || undefined })}
        value={node.description ?? ''}
      />
      <Input
        compact
        hint="Context path of the content to review, e.g. nodes.implement.output.diff"
        id="review-content-from"
        label="Content to review"
        onChange={(e) => onChange({ ...node, contentFrom: e.target.value })}
        placeholder="context.currentCodeResult.diff"
        value={node.contentFrom}
      />
      <StoreAsField
        onChange={(storeAs) => onChange({ ...node, storeAs: storeAs || undefined })}
        value={node.storeAs ?? ''}
      />
      <TimeoutField
        hint="How long the run waits before taking the timeout edge"
        onChange={(timeout) => onChange({ ...node, timeout })}
        value={node.timeout}
      />
    </div>
  );
}

/** The quality gates a `gate` scorer may run (`GateName` in the worker). */
const GATE_NAMES = [
  'runLint',
  'runTypecheck',
  'runTests',
  'runBuild',
  'runVulnScan',
  'runPerfBench',
] as const;

/** The scorer kinds `EvalScorerSchema` accepts, and what each needs. */
const SCORER_KINDS = ['gate', 'assert', 'trajectory', 'judge', 'policy', 'pii'] as const;
type ScorerKind = (typeof SCORER_KINDS)[number];
type Scorer = Extract<SpecNode, { type: 'eval' }>['scorers'][number];

const SCORER_LABEL: Record<ScorerKind, string> = {
  assert: 'Assert — an expression over the target',
  gate: 'Gate — a quality gate against the candidate branch',
  judge: 'Judge — an LLM call against a rubric',
  pii: 'PII — scan the target for personal data',
  policy: 'Policy — evaluate an autonomy risk class',
  trajectory: 'Trajectory — score the run’s trace',
};

/** The fields a scorer of each kind actually reads, so switching kind cannot leave a stale one. */
function scorerFor(kind: ScorerKind, previous: Scorer): Scorer {
  switch (kind) {
    case 'assert':
      return { expr: 'expr' in previous ? previous.expr : '', kind };
    case 'gate':
      return {
        ...('command' in previous && previous.command ? { command: previous.command } : {}),
        gate: 'gate' in previous ? previous.gate : 'runTests',
        kind,
      };
    case 'judge':
      return { kind, rubricRef: 'rubricRef' in previous ? previous.rubricRef : '' };
    case 'pii':
      return { kind };
    case 'policy':
      return { kind, riskClass: 'riskClass' in previous ? previous.riskClass : 'external_write' };
    case 'trajectory':
      return { kind };
  }
}

export function EvalSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'eval' }>;
  onChange: (next: SpecNode) => void;
}) {
  const scorers = node.scorers;
  const rowKeys = useListKeys(scorers.length);
  const setScorer = (i: number, next: Scorer) =>
    onChange({ ...node, scorers: scorers.map((s, j) => (j === i ? next : s)) });
  const addScorer = () => {
    if (scorers.length >= 20) {
      return;
    }
    const first = scorers[0];
    onChange({
      ...node,
      scorers: [...scorers, scorerFor('assert', first ?? { expr: '', kind: 'assert' })],
    });
  };
  const removeScorer = (i: number) => {
    if (scorers.length <= 1) {
      return;
    }
    onChange({ ...node, scorers: scorers.filter((_, j) => j !== i) });
  };
  const canSkip = scorers.some((s) => s.kind === 'gate' || s.kind === 'assert');

  return (
    <div className="space-y-3">
      <BindingField
        binding={node.target}
        hint="The value being scored. Usually a previous node's output or diff."
        label="Target"
        onChange={(target) => onChange({ ...node, target })}
      />
      <BindingField
        allowExpr={false}
        binding={node.candidateRef}
        hint="Branch holding the candidate's code, for a `gate` scorer. Defaults to the run's own work branch — name it whenever the code is somewhere else, such as a fan-out subtask's branch."
        label="Candidate branch"
        onChange={(candidateRef) => onChange({ ...node, candidateRef })}
      />
      {isAuthoredCommandNode(node) && <AuthoredCommandAlert />}
      <InspectorSubsection title={`Scorers (${scorers.length})`}>
        {scorers.map((scorer, i) => (
          <div
            className="space-y-1.5 rounded-md border border-ink-600 bg-ink-900/40 p-2"
            key={rowKeys[i]}
          >
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <Select
                  aria-label={`Scorer ${i + 1} kind`}
                  compact
                  onChange={(v) => setScorer(i, scorerFor(v as ScorerKind, scorer))}
                  options={SCORER_KINDS.map((k) => ({
                    label: k,
                    value: k,
                  }))}
                  value={scorer.kind}
                />
              </div>
              <Button
                aria-label={`Remove scorer ${i + 1}`}
                className="px-2 hover:text-brick-400"
                disabled={scorers.length <= 1}
                onClick={() => removeScorer(i)}
                size="sm"
                title={scorers.length <= 1 ? 'An eval node needs at least one scorer' : 'Remove'}
                variant="ghost"
              >
                <Icon name="close" size={14} />
              </Button>
            </div>
            <p className="text-xs text-paper-500">{SCORER_LABEL[scorer.kind]}</p>
            {scorer.kind === 'gate' && (
              <>
                <Select
                  aria-label={`Scorer ${i + 1} gate`}
                  compact
                  hint="Runs against the candidate branch on the repository's executor image."
                  onChange={(v) => setScorer(i, { ...scorer, gate: v })}
                  options={GATE_NAMES.map((g) => ({ label: g, value: g }))}
                  value={scorer.gate}
                />
                <Input
                  aria-label={`Scorer ${i + 1} command`}
                  compact
                  hint="Optional. Overrides the repository's gate command."
                  onChange={(e) =>
                    setScorer(i, {
                      ...scorer,
                      ...(e.target.value ? { command: e.target.value } : {}),
                    })
                  }
                  placeholder="yarn test"
                  value={scorer.command ?? ''}
                />
              </>
            )}
            {scorer.kind === 'assert' && (
              <Input
                aria-label={`Scorer ${i + 1} expression`}
                className="font-mono text-xs"
                compact
                hint="Expression over the target, e.g. $.linesChanged < 500"
                onChange={(e) => setScorer(i, { ...scorer, expr: e.target.value })}
                placeholder="$.linesChanged < 500"
                value={scorer.expr}
              />
            )}
            {scorer.kind === 'judge' && (
              <Input
                aria-label={`Scorer ${i + 1} rubric`}
                compact
                hint="Name of an EvalRubric, e.g. code-review-quality"
                onChange={(e) => setScorer(i, { ...scorer, rubricRef: e.target.value })}
                placeholder="code-review-quality"
                value={scorer.rubricRef}
              />
            )}
            {scorer.kind === 'policy' && (
              <Input
                aria-label={`Scorer ${i + 1} risk class`}
                compact
                hint="Autonomy risk class to evaluate, e.g. external_write"
                onChange={(e) => setScorer(i, { ...scorer, riskClass: e.target.value })}
                placeholder="external_write"
                value={scorer.riskClass}
              />
            )}
          </div>
        ))}
        <Button disabled={scorers.length >= 20} onClick={addScorer} size="sm" variant="ghost">
          <Icon name="plus" size={13} />
          Add scorer
        </Button>
      </InspectorSubsection>
      <Checkbox
        checked={node.judgeAdvisory !== false}
        hint={
          canSkip
            ? 'A judge axis may block the gate when this is off. Floor scorers still short-circuit it.'
            : 'A judge axis may block the gate when this is off. There is no floor scorer here to short-circuit it.'
        }
        label="Judge is advisory"
        onChange={(e) => onChange({ ...node, judgeAdvisory: e.target.checked ? undefined : false })}
      />
      <OnFailSection
        onChange={(v) => onChange({ ...node, onFail: v })}
        onError={node.onError}
        onOnErrorChange={(v) => onChange({ ...node, onError: v })}
        value={node.onFail}
      />
      <InspectorNote>
        Floor scorers (gate, assert, policy, pii) run first and short-circuit the judge when one
        fails, so a broken diff never costs a judge call.
      </InspectorNote>
    </div>
  );
}
