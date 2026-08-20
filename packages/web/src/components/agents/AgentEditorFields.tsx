'use client';

import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Select } from '@/components/ui/Select';
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
export function cleanAgentPayload(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));
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
  /** Rendered on the add-skill Select while no skill is attached yet. */
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
              className="flex items-center gap-2 rounded-[9px] border border-ink-400 bg-ink-900/40 px-3 py-2 text-sm"
              key={ref.skillId}
            >
              <span className="flex-1 text-paper-200">{nameFor(ref.skillId)}</span>
              <button
                className="text-paper-500 hover:text-paper-200 disabled:opacity-30"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                type="button"
              >
                ↑
              </button>
              <button
                className="text-paper-500 hover:text-paper-200 disabled:opacity-30"
                disabled={i === refs.length - 1}
                onClick={() => move(i, 1)}
                type="button"
              >
                ↓
              </button>
              <button
                className="text-brick-400 hover:text-brick-300"
                onClick={() => remove(i)}
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <Select
          label={refs.length === 0 ? label : undefined}
          onChange={(e) => {
            if (e.target.value) {
              add(e.target.value);
            }
          }}
          value=""
        >
          <option value="">+ Add skill…</option>
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
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
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  /** Hint shown while the agent inherits every tool (`toolKeys === null`). */
  inheritHint?: string;
}) {
  const isCustom = value !== null;

  function toggleKey(key: string, checked: boolean) {
    const current = value ?? [];
    onChange(checked ? [...current, key] : current.filter((k) => k !== key));
  }

  return (
    <FieldWrapper hint={isCustom ? undefined : inheritHint} label="Tools">
      <div className="space-y-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-paper-300">
          <input
            checked={isCustom}
            className="accent-ember-400"
            onChange={(e) => onChange(e.target.checked ? [] : null)}
            type="checkbox"
          />
          Custom tool selection
        </label>
        {isCustom && (
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 pl-1">
            {ALL_TOOL_KEYS.map((key) => (
              <label
                className="flex cursor-pointer items-center gap-2 text-sm text-paper-300"
                key={key}
              >
                <input
                  checked={value?.includes(key) ?? false}
                  className="accent-ember-400"
                  onChange={(e) => toggleKey(key, e.target.checked)}
                  type="checkbox"
                />
                <span className="font-mono text-xs">{key}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </FieldWrapper>
  );
}
