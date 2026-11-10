'use client';

/**
 * Flow-control fields every node can carry beyond its type's own settings:
 * `storeAs` (output path), `onFailure` / `onExhausted` (a node to route to, or
 * the stop-the-run shorthand), `status` and `maxVisits`. All optional; clearing
 * a field removes the key so a spec that does not use them is unchanged.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { useEffect, useId, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { InspectorSection } from './inspectorFields';

/** Types whose result can be stored and whose final failure can be routed. */
const OUTPUT_TYPES = new Set<SpecNode['type']>([
  'step',
  'agent',
  'mcp',
  'eval',
  'shell',
  'containerStep',
]);

export const hasOutputFlow = (node: SpecNode): boolean => OUTPUT_TYPES.has(node.type);

const STOP = '::stop';
type TerminalStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED';
/** A node id, or the shorthand that ends the run with a status. */
export type RouteTarget = string | { status: TerminalStatus; message?: string };

const STATUS_OPTIONS: Array<{ label: string; value: TerminalStatus }> = [
  { label: 'Failed', value: 'FAILED' },
  { label: 'Succeeded', value: 'SUCCESS' },
  { label: 'Timed out', value: 'TIMED_OUT' },
  { label: 'Skipped', value: 'SKIPPED' },
];

/** Set or remove one optional key, returning a new node. */
export function withField(node: SpecNode, key: string, value: unknown): SpecNode {
  const next = { ...(node as unknown as Record<string, unknown>) };
  if (value === undefined || value === '') {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next as unknown as SpecNode;
}

/** Parse a max-visits draft: a whole number from 1 to 10000, else undefined. */
export function parseMaxVisits(raw: string): number | undefined {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : undefined;
}

function RouteField({
  label,
  hint,
  value,
  otherIds,
  onChange,
}: {
  label: string;
  hint: string;
  value: RouteTarget | undefined;
  otherIds: string[];
  onChange: (next: RouteTarget | undefined) => void;
}) {
  const stopping = typeof value === 'object' && value !== null;
  const [message, setMessage] = useState(stopping ? (value.message ?? '') : '');
  useEffect(() => {
    setMessage(typeof value === 'object' && value !== null ? (value.message ?? '') : '');
  }, [value]);
  const current = stopping ? STOP : (value ?? '');
  const commitMessage = () => {
    if (stopping && (value.message ?? '') !== message.trim()) {
      const { message: _drop, ...rest } = value;
      onChange(message.trim() ? { ...rest, message: message.trim() } : rest);
    }
  };
  return (
    <div className="space-y-2">
      <Select
        compact
        hint={hint}
        id={`flow-${label}`}
        label={label}
        onChange={(v) => {
          if (v === STOP) {
            onChange({ status: 'FAILED' });
          } else {
            onChange(v || undefined);
          }
        }}
        options={[
          { label: 'Not set', value: '' },
          { label: 'Stop the run', value: STOP },
          ...otherIds.map((id) => ({ label: id, value: id })),
        ]}
        value={current}
      />
      {stopping && (
        <>
          <Select
            compact
            id={`flow-${label}-status`}
            label="Stop with status"
            onChange={(v) => onChange({ ...value, status: v as TerminalStatus })}
            options={STATUS_OPTIONS}
            value={value.status}
          />
          <Input
            compact
            label="Stop message"
            maxLength={2000}
            onBlur={commitMessage}
            onChange={(e) => setMessage(e.target.value)}
            value={message}
          />
        </>
      )}
    </div>
  );
}

export function FlowFieldsSection({
  node,
  nodeId,
  allNodeIds,
  knownStatuses,
  onChange,
}: {
  node: SpecNode;
  nodeId: string;
  allNodeIds: string[];
  knownStatuses?: string[];
  onChange: (next: SpecNode) => void;
}) {
  const listId = useId();
  const record = node as unknown as Record<string, unknown>;
  const otherIds = allNodeIds.filter((id) => id !== nodeId);
  const output = hasOutputFlow(node);
  // A terminate node's `status` is its terminal status, edited in its own section.
  const hasStatus = node.type !== 'terminate';
  const [status, setStatus] = useState(typeof record.status === 'string' ? record.status : '');
  const [visits, setVisits] = useState(
    typeof record.maxVisits === 'number' ? String(record.maxVisits) : ''
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: resync when another node is selected or the value changes underneath
  useEffect(() => {
    setStatus(typeof record.status === 'string' ? record.status : '');
    setVisits(typeof record.maxVisits === 'number' ? String(record.maxVisits) : '');
  }, [nodeId, record.status, record.maxVisits]);

  return (
    <InspectorSection title="Flow control">
      {hasStatus && (
        <>
          <Input
            compact
            hint="Status shown for the run while it is on this step"
            label="Status"
            list={listId}
            maxLength={64}
            onBlur={() => {
              const v = status.trim();
              if (v !== (record.status ?? '')) {
                onChange(withField(node, 'status', v));
              }
            }}
            onChange={(e) => setStatus(e.target.value)}
            value={status}
          />
          <datalist id={listId}>
            {(knownStatuses ?? []).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
      {output && (
        <Input
          className="font-mono text-xs"
          compact
          hint="Context path the result is written to, e.g. context.review"
          label="Store result at"
          onChange={(e) => onChange(withField(node, 'storeAs', e.target.value))}
          placeholder="context.result"
          value={typeof record.storeAs === 'string' ? record.storeAs : ''}
        />
      )}
      {output && (
        <RouteField
          hint="Where the run goes once this step has failed for good"
          label="On failure"
          onChange={(v) => onChange(withField(node, 'onFailure', v))}
          otherIds={otherIds}
          value={record.onFailure as RouteTarget | undefined}
        />
      )}
      <Input
        compact
        hint="How many times the run may enter this step"
        inputMode="numeric"
        label="Max visits"
        onBlur={() => {
          const n = parseMaxVisits(visits);
          if (n !== record.maxVisits) {
            onChange(withField(node, 'maxVisits', n));
          }
          setVisits(n === undefined ? '' : String(n));
        }}
        onChange={(e) => setVisits(e.target.value)}
        value={visits}
      />
      <RouteField
        hint="Where the run goes when the visit limit is reached"
        label="Out of attempts"
        onChange={(v) => onChange(withField(node, 'onExhausted', v))}
        otherIds={otherIds}
        value={record.onExhausted as RouteTarget | undefined}
      />
    </InspectorSection>
  );
}
