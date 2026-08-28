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
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import { errMsg } from '@/lib/errors';
import { OnFailSection, SchemaAwareForm } from './inspectorFields';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
        <p className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
          — no configurable fields —
        </p>
      )}
      {node.step && !stepMeta && (
        <p className="font-mono text-[10px] uppercase tracking-wider text-amber-400">
          ! Step not in registry — config schema unknown
        </p>
      )}
      <OnFailSection onChange={(v) => onChange({ ...node, onFail: v })} value={node.onFail} />
    </div>
  );
}

export function CondSection({ expr, onChange }: { expr: string; onChange: (v: string) => void }) {
  return (
    <Input
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
        label="Signal name"
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="e.g. human.approval"
        value={name}
      />
      <Input
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
        hint="Context path that yields the parallel items (array)"
        label="Over (from path)"
        onChange={(e) => onChange({ ...node, over: { from: e.target.value } })}
        placeholder="ctx.targets"
        value={overFrom}
      />
      <Input
        hint="Name each element is bound under inside the per-branch context"
        label="Item key"
        onChange={(e) => onChange({ ...node, itemKey: e.target.value })}
        placeholder="subtask"
        value={node.itemKey ?? 'subtask'}
      />
      <Select
        className="h-9 px-2 font-mono text-xs"
        id="fanout-branch-fail"
        label="On branch fail"
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'block' || v === 'continue') {
            onChange({ ...node, onBranchFail: v });
          }
        }}
        value={node.onBranchFail ?? 'block'}
      >
        <option value="block">Block (default) — stop on first failure</option>
        <option value="continue">Continue — collect all results</option>
      </Select>
      <div>
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
          htmlFor="fanout-concurrency"
        >
          Max concurrency
        </label>
        <input
          className="mt-1.5 h-9 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400"
          id="fanout-concurrency"
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
      </div>
      <Input
        hint="Dot-path projected from each branch result into output.plucked — e.g. result.branch"
        label="Pluck path"
        onChange={(e) => onChange({ ...node, pluck: e.target.value || undefined })}
        placeholder="result.branch"
        value={node.pluck ?? ''}
      />
      <div>
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
          htmlFor="fanout-exports"
        >
          Exports <span className="normal-case text-paper-600">(one per line)</span>
        </label>
        <p className="mt-0.5 text-[10px] leading-snug text-paper-500">
          Context paths that flow back to the parent scope after the fan-out joins.
        </p>
        <textarea
          className="mt-1.5 h-20 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none placeholder:text-paper-600 focus:border-ember-400"
          id="fanout-exports"
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
      <div className="rounded-sm border border-brick-400/40 bg-brick-400/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-brick-400">
        ⚠ shell — elevated privileges · team-admin authoring only
      </div>
      <Input
        hint="Must be on the team's image allowlist"
        label="Container image"
        onChange={(e) => onChange({ ...node, image: e.target.value })}
        placeholder="node:24-alpine"
        value={node.image ?? ''}
      />
      <div>
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
          htmlFor="shell-command"
        >
          Command
        </label>
        <textarea
          className="mt-1.5 h-24 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none placeholder:text-paper-600 focus:border-ember-400"
          id="shell-command"
          onChange={(e) => onChange({ ...node, command: e.target.value })}
          placeholder="echo hello"
          spellCheck={false}
          value={node.command ?? ''}
        />
      </div>
      <Select
        className="h-9 px-2 font-mono text-xs"
        id="shell-network"
        label="Network"
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'none' || v === 'egress') {
            onChange({ ...node, network: v === 'none' ? undefined : v });
          }
        }}
        value={node.network ?? 'none'}
      >
        <option value="none">None (default) — no outbound access</option>
        <option value="egress">Egress — outbound via team allowlist</option>
      </Select>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
            htmlFor="shell-memory"
          >
            Memory limit
          </label>
          <input
            className="mt-1.5 h-9 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400"
            id="shell-memory"
            onChange={(e) => onChange({ ...node, memory: e.target.value || undefined })}
            placeholder="512m"
            value={node.memory ?? ''}
          />
        </div>
        <div>
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
            htmlFor="shell-cpus"
          >
            CPUs
          </label>
          <input
            className="mt-1.5 h-9 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400"
            id="shell-cpus"
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
      <div className="rounded-sm border border-brick-400/40 bg-brick-400/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-brick-400">
        ⚠ container step — coded capability · team-admin authoring only
      </div>
      <Input
        hint="Must be on the team's image allowlist"
        label="Container image"
        onChange={(e) => onChange({ ...node, image: e.target.value })}
        placeholder="ghcr.io/acme/my-capability:1.0"
        value={node.image ?? ''}
      />
      <div>
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
          htmlFor="container-command"
        >
          Command
          <span className="ml-2 text-paper-500">
            — reads JSON from $CONTAINER_STEP_INPUT, prints a JSON result to stdout
          </span>
        </label>
        <textarea
          className="mt-1.5 h-20 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none placeholder:text-paper-600 focus:border-ember-400"
          id="container-command"
          onChange={(e) => onChange({ ...node, command: e.target.value || undefined })}
          placeholder="node /app/run.js"
          spellCheck={false}
          value={node.command ?? ''}
        />
      </div>
      <Select
        className="h-9 px-2 font-mono text-xs"
        id="container-network"
        label="Network"
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'none' || v === 'egress') {
            onChange({ ...node, network: v === 'none' ? undefined : v });
          }
        }}
        value={node.network ?? 'none'}
      >
        <option value="none">None (default) — no outbound access</option>
        <option value="egress">Egress — outbound via team allowlist</option>
      </Select>
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
      id="terminate-status"
      label="Status"
      onChange={(e) => {
        const v = e.target.value;
        if ((TERMINATE_STATUSES as readonly string[]).includes(v)) {
          onChange(v as TerminateStatus);
        }
      }}
      value={status}
    >
      {TERMINATE_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </Select>
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
    <div>
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
        htmlFor="set-values"
      >
        Values (JSON)
      </label>
      <textarea
        className="mt-1.5 h-40 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none placeholder:text-paper-600 focus:border-ember-400"
        id="set-values"
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
      {err && (
        <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-brick-400">
          ! {err}
        </div>
      )}
    </div>
  );
}

export function AgentSection({
  node,
  onChange,
}: {
  node: Extract<SpecNode, { type: 'agent' }>;
  onChange: (next: SpecNode) => void;
}) {
  const textarea =
    'h-20 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 py-1 font-mono text-[11px] text-paper-100 outline-none focus:border-ember-400';
  return (
    <div className="space-y-4">
      <Input
        hint="library agent: <key> or <key>@<version>"
        label="Agent reference"
        onChange={(e) => onChange({ ...node, agentRef: e.target.value })}
        value={node.agentRef}
      />
      <div className="space-y-1">
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
          htmlFor="agent-user-message"
        >
          <span className="text-paper-200">userMessage</span>
          <span className="ml-2 text-paper-500">— literal prompt (else node inputs as JSON)</span>
        </label>
        <textarea
          className={textarea}
          id="agent-user-message"
          onChange={(e) => onChange({ ...node, userMessage: e.target.value || undefined })}
          spellCheck={false}
          value={node.userMessage ?? ''}
        />
      </div>
      <div className="space-y-1">
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500"
          htmlFor="agent-system-prompt"
        >
          <span className="text-paper-200">systemPrompt</span>
          <span className="ml-2 text-paper-500">— per-node prompt override (optional)</span>
        </label>
        <textarea
          className={textarea}
          id="agent-system-prompt"
          onChange={(e) => onChange({ ...node, systemPrompt: e.target.value || undefined })}
          spellCheck={false}
          value={node.systemPrompt ?? ''}
        />
      </div>
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
  const {
    data: connections,
    error: connectionsError,
    isLoading: connectionsLoading,
  } = useMcpConnections();
  return (
    <div className="space-y-4">
      {connectionsError && (
        <Alert>{errMsg(connectionsError, 'Failed to load MCP connections')}</Alert>
      )}
      <Select
        hint="Choose an active MCP connection (managed at /admin/mcp-connections)"
        label="Connection"
        onChange={(e) => onChange({ ...node, connectionRef: e.target.value })}
        value={node.connectionRef}
      >
        <option disabled value="">
          {connectionsLoading ? 'Loading connections…' : 'Select an MCP connection…'}
        </option>
        {(connections ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.team?.name ?? c.teamId})
          </option>
        ))}
      </Select>
      {!connectionsLoading && !connectionsError && (connections ?? []).length === 0 && (
        <p className="text-sm text-paper-500">No MCP connections configured.</p>
      )}
      <Input
        hint="tool name exposed by the MCP server; its args come from Inputs below"
        label="Tool"
        onChange={(e) => onChange({ ...node, tool: e.target.value })}
        value={node.tool}
      />
      <OnFailSection onChange={(v) => onChange({ ...node, onFail: v })} value={node.onFail} />
    </div>
  );
}
