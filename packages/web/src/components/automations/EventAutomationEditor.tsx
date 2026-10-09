'use client';

import { type EventSource, eventSource, type FilterField } from '@auto-swe/shared/automation';
import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SchemaFieldInput, validatePayload } from '@/components/workflow/schemaForm';
import {
  type AutomationTemplate,
  type EventAutomation,
  type EventAutomationInput,
  useCreateEventAutomation,
  useUpdateEventAutomation,
} from '@/hooks/useAutomations';
import { errMsg } from '@/lib/errors';

/** A comma- or newline-separated list, trimmed, empties dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** The form's starting option values: the template defaults, then what the automation sets. */
export function startingOptions(options: InputSchema | undefined, inputs: Record<string, unknown>) {
  const values: Record<string, unknown> = {};
  for (const [k, prop] of Object.entries(options?.properties ?? {})) {
    if (prop.default !== undefined) {
      values[k] = Array.isArray(prop.default) ? [...prop.default] : prop.default;
    }
  }
  return { ...values, ...inputs };
}

/**
 * Only the options that differ from the template's default are saved: an option left at its
 * default follows the template, so a later change of default reaches the automation.
 */
export function changedOptions(options: InputSchema | undefined, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, prop] of Object.entries(options?.properties ?? {})) {
    const v = values[k];
    if (v === undefined || v === '') {
      continue;
    }
    if (JSON.stringify(v) !== JSON.stringify(prop.default)) {
      out[k] = v;
    }
  }
  return out;
}

/** One filter field's text (a list or a set of choices), as the form edits it. */
type FilterValue = string | string[];

function startingFilters(fields: FilterField[], filters: Record<string, unknown>) {
  const out: Record<string, FilterValue> = {};
  for (const f of fields) {
    const v = filters[f.key];
    const list = Array.isArray(v) ? v.map(String) : [];
    out[f.key] = f.kind === 'choices' ? list : list.join(', ');
  }
  return out;
}

function filtersFrom(fields: FilterField[], values: Record<string, FilterValue>) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key] ?? '';
    out[f.key] = f.kind === 'choices' ? v : splitList(typeof v === 'string' ? v : '');
  }
  return out;
}

/**
 * "Would this automation react to …?" — answered with the source's own `mismatch`, the one the
 * webhook path uses, so what it says is what an occurrence gets.
 */
function MatchTester({
  source,
  filters,
}: {
  source: EventSource<unknown, unknown>;
  filters: Record<string, unknown>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(source.tester.fields.map((f) => [f.key, f.initial]))
  );
  const parsed = source.filters.safeParse(filters);
  const mismatch = parsed.success
    ? source.mismatch(parsed.data, source.tester.facts(values))
    : 'the filters are not complete yet';
  return (
    <div className="space-y-2 rounded-md border border-ink-600 px-3 py-2.5">
      <div className="font-medium text-paper-200 text-xs">Try it</div>
      <div className="grid gap-2 sm:grid-cols-3">
        {source.tester.fields.map((f) =>
          f.options ? (
            <Select
              compact
              key={f.key}
              label={f.label}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              options={f.options}
              value={values[f.key] ?? ''}
            />
          ) : (
            <Input
              compact
              key={f.key}
              label={f.label}
              onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
              value={values[f.key] ?? ''}
            />
          )
        )}
      </div>
      <p aria-live="polite" className="text-xs">
        {mismatch === null ? (
          <span className="text-moss-400">
            Would start a run — unless a limit, an earlier run or the budget holds it back.
          </span>
        ) : (
          <span className="text-paper-400">Would not start a run: {mismatch}.</span>
        )}
      </p>
    </div>
  );
}

/**
 * Create an event automation of `source` on a repository, or — given `automation` — edit one:
 * WHEN (the source's filters, rendered from its descriptor, with a tester), WHAT (a template and
 * that template's own options, rendered from its declared input schema) and LIMITS.
 */
export function EventAutomationEditor({
  connectionId,
  sourceKey,
  automation,
  templates,
  onDone,
}: {
  connectionId: string;
  sourceKey: string;
  automation?: EventAutomation;
  templates: AutomationTemplate[];
  onDone: () => void;
}) {
  const create = useCreateEventAutomation(connectionId);
  const update = useUpdateEventAutomation(connectionId);
  const source = eventSource(sourceKey);
  const builtIn = templates.find((t) => t.builtIn);
  const templateFor = (id: string | null) =>
    id === null ? builtIn : templates.find((t) => t.id === id);
  const [name, setName] = useState(automation?.name ?? '');
  const [filterValues, setFilterValues] = useState(() =>
    source
      ? startingFilters(
          source.filterFields,
          automation?.filters ?? (source.defaultFilters as Record<string, unknown>)
        )
      : {}
  );
  const [templateId, setTemplateId] = useState<string | null>(automation?.templateId ?? null);
  const [options, setOptions] = useState<Record<string, unknown>>(() =>
    startingOptions(templateFor(automation?.templateId ?? null)?.options, automation?.inputs ?? {})
  );
  const [cooldown, setCooldown] = useState(String(automation?.cooldownMinutes ?? 30));
  const [dailyCap, setDailyCap] = useState(String(automation?.maxRunsPerDay ?? 10));

  if (!source) {
    return <Alert>This automation names an event source this dashboard does not know.</Alert>;
  }
  const template = templateFor(templateId);
  const optionErrors = template ? validatePayload(template.options, options) : {};
  const filters = filtersFrom(source.filterFields, filterValues);
  const filtersOk = source.filters.safeParse(filters).success;
  const body: EventAutomationInput = {
    cooldownMinutes: Number(cooldown),
    enabled: true,
    filters,
    inputs: changedOptions(template?.options, options),
    maxRunsPerDay: Number(dailyCap),
    name: name.trim(),
    templateId,
  };
  const valid =
    template !== undefined &&
    body.name !== '' &&
    filtersOk &&
    Number.isInteger(body.cooldownMinutes) &&
    body.cooldownMinutes >= 0 &&
    Number.isInteger(body.maxRunsPerDay) &&
    body.maxRunsPerDay >= 1 &&
    Object.keys(optionErrors).length === 0;
  const saving = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const save = () => {
    if (automation) {
      // The on/off switch is the row's: a save never sends it, so switching the automation
      // while the editor is open is not undone by the editor's stale copy.
      const { enabled: _enabled, ...changes } = body;
      update.mutate({ id: automation.id, ...changes }, { onSuccess: onDone });
    } else {
      create.mutate({ ...body, source: source.key }, { onSuccess: onDone });
    }
  };
  // The source can only describe its own default template's options.
  const describedInputs = templateId === null ? (source.describeInputs?.(options) ?? '') : '';

  return (
    <section className="space-y-4 border-ink-600 border-t pt-4">
      <h4 className="font-semibold text-paper-100 text-sm">
        {automation ? `Edit “${automation.name}”` : `New: ${source.label}`}
      </h4>
      <Input label="Name" onChange={(e) => setName(e.target.value)} value={name} />

      <fieldset className="space-y-3">
        <legend className="label-mono mb-1 block">When</legend>
        {source.filterFields.map((f) =>
          f.kind === 'choices' ? (
            <div className="space-y-1.5" key={f.key}>
              <span className="label-mono block">{f.label}</span>
              <div className="flex flex-wrap gap-4">
                {f.options.map((o) => {
                  const picked = (filterValues[f.key] as string[] | undefined) ?? [];
                  return (
                    <Checkbox
                      checked={picked.includes(o.value)}
                      key={o.value}
                      label={o.label}
                      onChange={(e) =>
                        setFilterValues((s) => ({
                          ...s,
                          [f.key]: e.target.checked
                            ? f.options
                                .map((x) => x.value)
                                .filter((v) => v === o.value || picked.includes(v))
                            : picked.filter((v) => v !== o.value),
                        }))
                      }
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <Input
              hint={f.hint}
              key={f.key}
              label={f.label}
              onChange={(e) => setFilterValues((s) => ({ ...s, [f.key]: e.target.value }))}
              value={(filterValues[f.key] as string | undefined) ?? ''}
            />
          )
        )}
        <MatchTester filters={filters} source={source} />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="label-mono mb-1 block">What it starts</legend>
        <Select
          hint={template?.description || undefined}
          label="Template"
          onChange={(v) => {
            const id = v === '' ? null : v;
            // The options are the new template's own: start from its defaults.
            setOptions(startingOptions(templateFor(id)?.options, {}));
            setTemplateId(id);
          }}
          options={[
            { label: `${builtIn?.name ?? source.defaultTemplate.name} (default)`, value: '' },
            ...templates.filter((t) => !t.builtIn).map((t) => ({ label: t.name, value: t.id })),
          ]}
          value={templateId ?? ''}
        />
        {template === undefined && (
          <Alert>
            {templateId === null
              ? `The default template (${source.defaultTemplate.name}) is not installed.`
              : 'This template can no longer be started by this automation; choose another.'}
          </Alert>
        )}
        {template &&
          Object.entries(template.options.properties).map(([k, prop]) => (
            <SchemaFieldInput
              error={optionErrors[k]}
              key={`${templateId ?? 'default'}:${k}`}
              name={k}
              onChange={(v) => setOptions((o) => ({ ...o, [k]: v }))}
              prop={prop}
              required={template.options.required?.includes(k)}
              value={options[k]}
            />
          ))}
        {describedInputs && <p className="text-paper-500 text-xs">{describedInputs}.</p>}
        {(source.gatedOptions ?? []).some((g) => g.values.includes(options[g.key])) && (
          <Alert variant="warning">
            This option applies only where an admin allows it, and only with the default template;
            where it does not apply the run falls back to the safer behaviour.
          </Alert>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="label-mono mb-1 block">Limits</legend>
        <div className="flex flex-wrap gap-3">
          <Input
            hint="No new run for the same branch (or other scope) within this long of the last."
            label="Cooldown (minutes)"
            min={0}
            onChange={(e) => setCooldown(e.target.value)}
            type="number"
            value={cooldown}
          />
          <Input
            label="Runs per day"
            min={1}
            onChange={(e) => setDailyCap(e.target.value)}
            type="number"
            value={dailyCap}
          />
        </div>
      </fieldset>

      {error && <Alert>{errMsg(error, 'Could not save the automation.')}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone} variant="ghost">
          Cancel
        </Button>
        <Button disabled={!valid || saving} onClick={save} variant="primary">
          <Icon name={automation ? 'check' : 'plus'} size={14} />
          {automation ? 'Save' : 'Add'}
        </Button>
      </div>
    </section>
  );
}
