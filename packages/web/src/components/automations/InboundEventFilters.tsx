'use client';

import {
  extractInboundEvent,
  type InboundEventFilters,
  inboundEventFacts,
  inboundEventSource,
  type MATCH_OPS,
} from '@auto-swe/shared/automation';
import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { type EventEndpoint, useEventEndpoints } from '@/hooks/useEventEndpoints';
import { splitList } from './EventAutomationEditor';

type Op = (typeof MATCH_OPS)[number];

/** One rule as the form edits it: the value as typed. */
let rowSeq = 0;
/** A stable key for a row the form adds, so React keeps each row's inputs with it. */
function rowKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

/** One mapped field as the form edits it. */
interface FieldRow {
  key: string;
  input: string;
  pointer: string;
}

export interface RuleRow {
  key?: string;
  pointer: string;
  op: Op;
  value: string;
}

/** A typed value: JSON for a number, true/false or a quoted string; anything else is text. */
export function parseRuleScalar(text: string): string | number | boolean {
  const t = text.trim();
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return v;
    }
  } catch {
    // Plain text.
  }
  return t;
}

function showScalar(v: unknown): string {
  return typeof v === 'string' && parseRuleScalar(v) === v ? v : JSON.stringify(v);
}

/** The form's rows from stored rules. */
export function ruleRows(match: unknown): RuleRow[] {
  if (!Array.isArray(match)) {
    return [];
  }
  return match.map((r: { pointer?: string; op?: Op; value?: unknown }) => ({
    key: rowKey(),
    op: r.op ?? 'eq',
    pointer: r.pointer ?? '',
    value: Array.isArray(r.value)
      ? r.value.map(showScalar).join(', ')
      : r.value === undefined
        ? ''
        : showScalar(r.value),
  }));
}

/** Stored rules from the form's rows. */
export function rulesFrom(rows: RuleRow[]): Record<string, unknown>[] {
  return rows.map((r) => {
    if (r.op === 'exists') {
      return {
        op: r.op,
        pointer: r.pointer,
        ...(r.value.trim() === 'false' ? { value: false } : {}),
      };
    }
    if (r.op === 'in') {
      return { op: r.op, pointer: r.pointer, value: splitList(r.value).map(parseRuleScalar) };
    }
    if (r.op === 'glob') {
      return { op: r.op, pointer: r.pointer, value: r.value.trim() };
    }
    return { op: r.op, pointer: r.pointer, value: parseRuleScalar(r.value) };
  });
}

/**
 * "Would this event start a run?" — a sample payload read with the endpoint's own pointers and
 * answered with the source's `mismatch`, the code the receiver runs. A CloudEvents endpoint reads
 * the sample as a structured-mode event.
 */
function SampleTester({
  endpoint,
  filters,
}: {
  endpoint: EventEndpoint | undefined;
  filters: Record<string, unknown>;
}) {
  const [sample, setSample] = useState('{\n  "type": "alert.fired",\n  "id": "1"\n}');
  let answer: string | null;
  let document: unknown;
  try {
    document = JSON.parse(sample);
  } catch {
    document = undefined;
  }
  const parsed = inboundEventSource.filters.safeParse(filters);
  if (!endpoint) {
    answer = 'choose an endpoint';
  } else if (document === undefined) {
    answer = 'the sample is not JSON';
  } else if (!parsed.success) {
    answer = 'the filters are not complete yet';
  } else {
    const extracted = extractInboundEvent({
      bodyDigest: 'sample',
      document,
      endpointId: endpoint.id,
      // The tester never records anything; an id that would be hashed is shown as such.
      hash: () => 'hash',
      pointers: endpoint,
    });
    answer = extracted.ok
      ? inboundEventSource.mismatch(parsed.data, inboundEventFacts(extracted.event, parsed.data))
      : extracted.message.toLowerCase();
  }
  return (
    <div className="space-y-2 rounded-md border border-ink-600 px-3 py-2.5">
      <div className="font-medium text-paper-200 text-xs">Try it with a sample event</div>
      <Textarea
        className="font-mono text-xs"
        label="Sample payload (JSON)"
        onChange={(e) => setSample(e.target.value)}
        rows={5}
        value={sample}
      />
      <p aria-live="polite" className="text-xs">
        {answer === null ? (
          <span className="text-moss-400">
            Would start a run — unless a limit, an earlier run or the budget holds it back.
          </span>
        ) : (
          <span className="text-paper-400">Would not start a run: {answer}.</span>
        )}
      </p>
    </div>
  );
}

/**
 * The filters of an `inbound.event` automation: which endpoint, which event types, conditions
 * on the event's values (JSON Pointers), and which template inputs are filled from it — with a
 * tester over a sample payload.
 */
export function InboundEventFiltersForm({
  teamId,
  filters,
  onChange,
  templateOptions,
}: {
  teamId: string;
  filters: Partial<InboundEventFilters> & Record<string, unknown>;
  onChange: (filters: Record<string, unknown>) => void;
  /** The chosen template's options: the inputs a field can fill. */
  templateOptions: InputSchema | undefined;
}) {
  const endpoints = useEventEndpoints(teamId);
  const [rows, setRows] = useState<RuleRow[]>(() => ruleRows(filters.match));
  const [types, setTypes] = useState(() => (filters.eventTypes ?? ['*']).join(', '));
  const [fields, setFields] = useState<FieldRow[]>(() =>
    Object.entries(filters.fields ?? {}).map(([input, pointer]) => ({
      input,
      key: rowKey(),
      pointer,
    }))
  );
  const list = endpoints.data?.endpoints ?? [];
  const endpointId = filters.endpointId || list[0]?.id || '';
  const emit = (next: {
    endpointId?: string;
    rows?: RuleRow[];
    types?: string;
    fields?: FieldRow[];
  }) => {
    const r = next.rows ?? rows;
    const f = next.fields ?? fields;
    onChange({
      endpointId: next.endpointId ?? endpointId,
      eventTypes: splitList(next.types ?? types),
      fields: Object.fromEntries(f.filter((x) => x.input !== '').map((x) => [x.input, x.pointer])),
      match: rulesFrom(r),
    });
  };
  const firstId = list[0]?.id;
  useEffect(() => {
    // The first endpoint, once loaded, so the filters are complete without a click.
    if (!filters.endpointId && firstId) {
      onChange({ ...filters, endpointId: firstId });
    }
  }, [filters, firstId, onChange]);
  const inputs = Object.keys(templateOptions?.properties ?? {});
  const current: Record<string, unknown> = {
    endpointId,
    eventTypes: splitList(types),
    fields: Object.fromEntries(
      fields.filter((x) => x.input !== '').map((x) => [x.input, x.pointer])
    ),
    match: rulesFrom(rows),
  };

  return (
    <div className="space-y-3">
      {endpoints.isSuccess && list.length === 0 && (
        <Alert>The team has no event endpoints yet: create one on the team’s page first.</Alert>
      )}
      <Select
        label="Endpoint"
        onChange={(v) => emit({ endpointId: v })}
        options={list.map((e) => ({
          label: e.enabled ? e.name : `${e.name} (disabled)`,
          value: e.id,
        }))}
        value={endpointId}
      />
      <Input
        hint="Patterns over the event type, comma-separated: * is any text, ? one character, !pattern excludes; the last match wins."
        label="Event types"
        onChange={(e) => {
          setTypes(e.target.value);
          emit({ types: e.target.value });
        }}
        value={types}
      />
      <div className="space-y-2">
        <span className="label-mono block">Conditions (all must hold)</span>
        {rows.map((r, i) => (
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_1fr_auto]" key={r.key}>
            <Input
              aria-label="Pointer"
              compact
              onChange={(e) => {
                const next = rows.map((x, j) => (j === i ? { ...x, pointer: e.target.value } : x));
                setRows(next);
                emit({ rows: next });
              }}
              placeholder="/alert/severity"
              value={r.pointer}
            />
            <Select
              aria-label="Condition"
              compact
              onChange={(v) => {
                const next = rows.map((x, j) => (j === i ? { ...x, op: v as Op } : x));
                setRows(next);
                emit({ rows: next });
              }}
              options={[
                { label: 'equals', value: 'eq' },
                { label: 'is one of', value: 'in' },
                { label: 'matches', value: 'glob' },
                { label: 'exists', value: 'exists' },
              ]}
              value={r.op}
            />
            <Input
              aria-label="Value"
              compact
              onChange={(e) => {
                const next = rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x));
                setRows(next);
                emit({ rows: next });
              }}
              placeholder={
                r.op === 'in' ? 'a, b, 3' : r.op === 'exists' ? '(or false)' : 'critical'
              }
              value={r.value}
            />
            <Button
              aria-label="Remove condition"
              onClick={() => {
                const next = rows.filter((_, j) => j !== i);
                setRows(next);
                emit({ rows: next });
              }}
              size="sm"
              variant="ghost"
            >
              <Icon name="trash" size={14} />
            </Button>
          </div>
        ))}
        <Button
          onClick={() => {
            const next = [...rows, { key: rowKey(), op: 'eq' as const, pointer: '', value: '' }];
            setRows(next);
          }}
          size="sm"
          variant="secondary"
        >
          <Icon name="plus" size={14} />
          Condition
        </Button>
      </div>
      <div className="space-y-2">
        <span className="label-mono block">Fields from the event</span>
        <p className="text-paper-500 text-xs">
          Each fills one of the template’s inputs with the value at a pointer. The value is the
          sender’s text: map it only into inputs that are safe to take from outside.
        </p>
        {fields.map((f, i) => (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" key={f.key}>
            <Select
              aria-label="Template input"
              compact
              onChange={(v) => {
                const next = fields.map((x, j) => (j === i ? { ...x, input: v } : x));
                setFields(next);
                emit({ fields: next });
              }}
              options={inputs.map((k) => ({ label: k, value: k }))}
              value={f.input}
            />
            <Input
              aria-label="Pointer"
              compact
              onChange={(e) => {
                const next = fields.map((x, j) =>
                  j === i ? { ...x, pointer: e.target.value } : x
                );
                setFields(next);
                emit({ fields: next });
              }}
              placeholder="/alert/summary"
              value={f.pointer}
            />
            <Button
              aria-label="Remove field"
              onClick={() => {
                const next = fields.filter((_, j) => j !== i);
                setFields(next);
                emit({ fields: next });
              }}
              size="sm"
              variant="ghost"
            >
              <Icon name="trash" size={14} />
            </Button>
          </div>
        ))}
        <Button
          disabled={inputs.length === 0}
          onClick={() => setFields([...fields, { input: '', key: rowKey(), pointer: '' }])}
          size="sm"
          variant="secondary"
        >
          <Icon name="plus" size={14} />
          Field
        </Button>
      </div>
      <SampleTester endpoint={list.find((e) => e.id === endpointId)} filters={current} />
    </div>
  );
}
