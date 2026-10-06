'use client';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Icon } from '@/components/ui/Icon';
import type { SkillRefInput } from '@/hooks/useAgentLibrary';
import type { SkillOption } from '@/hooks/useSkills';

/**
 * The Agent editor fields shared by the GLOBAL agent library page and the
 * per-team overrides section. Both edit the same entity through the same
 * schema, so the skill-ref list, the tool-key group, and the payload cleaner
 * have one reason to change — `Agent` — and live here rather than in two
 * copies that must be kept byte-identical by hand.
 */

/** Mirrors `AGENT_TOOL_KEYS`: the four implementer workspace tools plus the
 *  `mcp` pseudo-key that gates MCP tool loading. */
export const ALL_TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash', 'mcp'] as const;

/** Drops empty-string and undefined entries so an untouched optional field is
 *  omitted from the request body rather than sent as `''`. */
export function cleanAgentPayload<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)
  ) as Partial<T>;
}

export function SkillRefEditor({
  refs,
  skills,
  onChange,
  label,
  emptyHint,
}: {
  refs: SkillRefInput[];
  skills: SkillOption[];
  onChange: (refs: SkillRefInput[]) => void;
  /** Rendered on the add-skill Combobox while no skill is attached yet. */
  label?: string;
  /** Rendered when there is nothing attached and nothing left to attach. */
  emptyHint?: string;
}) {
  const attached = new Set(refs.map((r) => r.skillId));
  const available = skills.filter((s) => !attached.has(s.id));

  function add(skillId: string) {
    onChange([...refs, { skillId, sortOrder: refs.length }]);
  }

  function remove(i: number) {
    onChange(refs.filter((_, j) => j !== i).map((r, j) => ({ ...r, sortOrder: j })));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= refs.length) {
      return;
    }
    const next = [...refs];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next.map((r, k) => ({ ...r, sortOrder: k })));
  }

  function nameFor(skillId: string) {
    return skills.find((s) => s.id === skillId)?.name ?? skillId;
  }

  return (
    <div className="space-y-2">
      {refs.length > 0 && (
        <ul className="space-y-1">
          {refs.map((ref, i) => (
            <li
              className="flex items-center gap-1 rounded-md border border-ink-400 bg-ink-900/40 py-1 pr-1 pl-3 text-sm"
              key={ref.skillId}
            >
              <span className="w-5 shrink-0 text-xs text-paper-500 tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-paper-200">{nameFor(ref.skillId)}</span>
              <Button
                aria-label={`Move ${nameFor(ref.skillId)} up`}
                className="w-7 px-0"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                size="sm"
                variant="ghost"
              >
                <Icon className="rotate-180" name="chevronDown" size={14} />
              </Button>
              <Button
                aria-label={`Move ${nameFor(ref.skillId)} down`}
                className="w-7 px-0"
                disabled={i === refs.length - 1}
                onClick={() => move(i, 1)}
                size="sm"
                variant="ghost"
              >
                <Icon name="chevronDown" size={14} />
              </Button>
              <Button
                aria-label={`Remove ${nameFor(ref.skillId)}`}
                className="w-7 px-0 text-brick-400 hover:text-brick-400"
                onClick={() => remove(i)}
                size="sm"
                variant="ghost"
              >
                <Icon name="close" size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <Combobox
          aria-label={refs.length === 0 && label ? undefined : 'Add skill'}
          // Remount after each add so the typed filter text does not linger.
          key={refs.length}
          label={refs.length === 0 ? label : undefined}
          onChange={(v) => {
            if (v) {
              add(v);
            }
          }}
          options={available.map((s) => ({ label: s.name, value: s.id }))}
          placeholder="Add a skill…"
          value=""
        />
      )}
      {emptyHint && available.length === 0 && refs.length === 0 && (
        <p className="text-xs text-paper-500">{emptyHint}</p>
      )}
    </div>
  );
}

export function ToolKeysEditor({
  value,
  onChange,
  inheritHint = 'Inherits all available tools',
  mcpSelected = false,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  /** Hint shown while the agent inherits every tool (`toolKeys === null`). */
  inheritHint?: string;
  /** An MCP connection is bound to the agent, which only loads when `mcp` is ticked. */
  mcpSelected?: boolean;
}) {
  const isCustom = value !== null;

  function toggleKey(key: string, checked: boolean) {
    const current = value ?? [];
    onChange(checked ? [...current, key] : current.filter((k) => k !== key));
  }

  return (
    <FieldWrapper hint={isCustom ? undefined : inheritHint} label="Tools">
      <div className="space-y-2">
        <Checkbox
          checked={isCustom}
          label="Custom tool selection"
          onChange={(e) => onChange(e.target.checked ? [] : null)}
        />
        {isCustom && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 pl-1 sm:grid-cols-3">
            {ALL_TOOL_KEYS.map((key) => (
              <Checkbox
                checked={value?.includes(key) ?? false}
                key={key}
                label={<span className="font-mono text-xs">{key}</span>}
                onChange={(e) => toggleKey(key, e.target.checked)}
              />
            ))}
          </div>
        )}
        {isCustom && value.length === 0 && (
          <Alert variant="warning">
            No tools are ticked, so this agent cannot read files, edit code or run commands. Tick
            the tools it needs, or untick custom selection to give it all of them.
          </Alert>
        )}
        {isCustom && mcpSelected && !value.includes('mcp') && (
          <Alert variant="warning">
            An MCP connection is selected, but the mcp tool is not ticked, so its tools will not
            load.
          </Alert>
        )}
      </div>
    </FieldWrapper>
  );
}
