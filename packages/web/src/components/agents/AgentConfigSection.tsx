'use client';

/**
 * Shared core for the per-scope "Agent Configuration" sections (team page and
 * template page). Owns the role accordion, the tool-access checkbox editor,
 * and the skill-assignment editor — including dirty-state tracking, the
 * save/override/reset flow, and inherited/built-in badges.
 *
 * Scope-specific bits (API endpoints, query keys, labels, DOM-id infix,
 * inherited dimming, built-in badge) are bound by the thin wrappers:
 *  - components/teams/TeamAgentSkillsSection.tsx
 *  - components/templates/TemplateAgentSkillsSection.tsx
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { AGENT_ROLES, type AgentRoleKey, ROLE_LABELS } from '@/lib/agentRoles';

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  isBuiltIn: boolean;
}

export interface Assignment {
  id: string;
  skillId: string;
  sortOrder: number;
  skill: Skill;
}

export interface ToolConfig {
  id: string;
  agentRole: string;
  scope: string;
  enabledTools: string[];
}

export const TOOL_KEYS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;

/** Labels and presentation flags that differ between the team and template scopes. */
interface ScopePresentation {
  /** DOM-id infix: ids render as `${role}-${idInfix}tool-${key}` / `${role}-${idInfix}skill-${id}`. */
  idInfix: string;
  /** Shown when no scope-level override is set, e.g. "inheriting global". */
  inheritingLabel: string;
  /** Reset CTA text, e.g. "Reset to Global". */
  resetButtonLabel: string;
  /** window.confirm prompt before resetting. */
  resetConfirm: string;
  /** Dim entries that are inherited from the global scope (team variant). */
  dimInherited: boolean;
}

interface SaveResetHandlers {
  onSave: (items: string[]) => Promise<unknown>;
  savePending: boolean;
  onReset: () => Promise<unknown>;
  resetPending: boolean;
}

/** Local editing state shared by both editors: pending selection, save error, saved flag. */
function useSelectionEditing(handlers: SaveResetHandlers, resetConfirm: string) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggle(base: Set<string>, key: string) {
    const next = new Set(selected ?? base);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelected(next);
    setSaved(false);
  }

  async function handleSave(effective: Set<string>) {
    setSaveError(null);
    setSaved(false);
    try {
      await handlers.onSave([...effective]);
      setSaved(true);
      setSelected(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  async function handleReset() {
    if (!window.confirm(resetConfirm)) {
      return;
    }
    await handlers.onReset();
    setSelected(null);
    setSaved(false);
  }

  return { handleReset, handleSave, saved, saveError, selected, toggle };
}

/** Footer row: inheriting label / reset CTA / saved indicator / save-or-override CTA. */
function EditorFooter({
  hasOverride,
  isDirty,
  saved,
  saveError,
  scope,
  handlers,
  onSave,
  onReset,
}: {
  hasOverride: boolean;
  isDirty: boolean;
  saved: boolean;
  saveError: string | null;
  scope: ScopePresentation;
  handlers: SaveResetHandlers;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <>
      {saveError && <p className="text-xs text-brick-400">{saveError}</p>}
      <div className="flex items-center gap-2">
        {!hasOverride && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
            {scope.inheritingLabel}
          </span>
        )}
        {hasOverride && (
          <Button disabled={handlers.resetPending} onClick={onReset} size="sm" variant="ghost">
            {scope.resetButtonLabel}
          </Button>
        )}
        {saved && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-green-400">
            Saved
          </span>
        )}
        <Button
          disabled={!isDirty || handlers.savePending}
          onClick={onSave}
          size="sm"
          variant="primary"
        >
          {handlers.savePending ? 'Saving…' : hasOverride ? 'Save' : 'Override'}
        </Button>
      </div>
    </>
  );
}

export interface ToolAccessEditorProps extends ScopePresentation, SaveResetHandlers {
  role: AgentRoleKey;
  /** When true, render a loading placeholder instead of the editor. */
  loading?: boolean;
  hasOverride: boolean;
  /** Scope-level override config (team/template), if any. */
  overrideConfig: ToolConfig | null;
  globalConfig: ToolConfig | null;
}

export function ToolAccessEditor(props: ToolAccessEditorProps) {
  const editing = useSelectionEditing(props, props.resetConfirm);

  if (props.loading) {
    return <div className="py-2 text-center text-xs text-paper-400">Loading…</div>;
  }

  const { hasOverride, overrideConfig, globalConfig } = props;
  const baseTools = hasOverride
    ? new Set<string>(overrideConfig?.enabledTools ?? TOOL_KEYS)
    : new Set<string>(globalConfig?.enabledTools ?? TOOL_KEYS);
  const effectiveTools = editing.selected ?? baseTools;
  const isDirty = editing.selected !== null;

  return (
    <div className="mt-2 rounded-sm border border-ink-600 p-3 space-y-2">
      <p className="text-xs text-paper-500">Tool Access</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {TOOL_KEYS.map((key) => {
          const checked = effectiveTools.has(key);
          const isGlobal = globalConfig?.enabledTools.includes(key) ?? true;
          const isInherited = props.dimInherited && !hasOverride && isGlobal;
          const inputId = `${props.role}-${props.idInfix}tool-${key}`;
          return (
            <label
              className={`flex cursor-pointer items-center gap-1.5 rounded-sm border p-1.5 text-xs transition-colors ${
                isInherited ? 'border-ink-600 opacity-60' : 'border-ink-600 hover:border-ink-500'
              }`}
              htmlFor={inputId}
              key={key}
            >
              <input
                checked={checked}
                className="accent-ember-400"
                id={inputId}
                onChange={() => editing.toggle(baseTools, key)}
                type="checkbox"
              />
              <span className="font-mono text-paper-100">{key}</span>
            </label>
          );
        })}
      </div>
      <EditorFooter
        handlers={props}
        hasOverride={hasOverride}
        isDirty={isDirty}
        onReset={editing.handleReset}
        onSave={() => editing.handleSave(effectiveTools)}
        saved={editing.saved}
        saveError={editing.saveError}
        scope={props}
      />
    </div>
  );
}

export interface SkillAssignmentEditorProps extends ScopePresentation, SaveResetHandlers {
  role: AgentRoleKey;
  /** When true, render a loading placeholder instead of the editor. */
  loading?: boolean;
  hasOverride: boolean;
  /** Effective assignments for this scope (override when set, else global). */
  baseAssignments: Assignment[];
  globalAssignments: Assignment[];
  /** Full skill library to offer; undefined while loading. */
  skills: Skill[] | undefined;
  /** Show the "built-in" badge next to built-in skills (template variant). */
  showBuiltInBadge: boolean;
}

export function SkillAssignmentEditor(props: SkillAssignmentEditorProps) {
  const editing = useSelectionEditing(props, props.resetConfirm);

  if (props.loading) {
    return <div className="py-4 text-center text-xs text-paper-400">Loading…</div>;
  }

  const { hasOverride, baseAssignments, globalAssignments, skills } = props;
  const assignedIds = new Set(baseAssignments.map((a) => a.skillId));
  const effectiveIds = editing.selected ?? assignedIds;
  const isDirty = editing.selected !== null;

  return (
    <div className="mt-2 rounded-sm border border-ink-600 p-3 space-y-2">
      <p className="text-xs text-paper-500">Skills (Prompt Fragments)</p>
      {!skills?.length ? (
        <p className="text-xs text-paper-400">No skills in library.</p>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {skills.map((skill) => {
            const checked = effectiveIds.has(skill.id);
            const isGlobal = globalAssignments.some((a) => a.skillId === skill.id);
            const isInherited = props.dimInherited && !hasOverride && isGlobal;
            const inputId = `${props.role}-${props.idInfix}skill-${skill.id}`;
            return (
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-sm border p-2 text-xs transition-colors ${
                  isInherited ? 'border-ink-600 opacity-60' : 'border-ink-600 hover:border-ink-500'
                }`}
                htmlFor={inputId}
                key={skill.id}
              >
                <input
                  checked={checked}
                  className="mt-0.5 accent-ember-400"
                  id={inputId}
                  onChange={() => editing.toggle(assignedIds, skill.id)}
                  type="checkbox"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-paper-100">{skill.name}</span>
                    {isGlobal && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-paper-500">
                        global
                      </span>
                    )}
                    {props.showBuiltInBadge && skill.isBuiltIn && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-ember-400/70">
                        built-in
                      </span>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
      <EditorFooter
        handlers={props}
        hasOverride={hasOverride}
        isDirty={isDirty}
        onReset={editing.handleReset}
        onSave={() => editing.handleSave(effectiveIds)}
        saved={editing.saved}
        saveError={editing.saveError}
        scope={props}
      />
    </div>
  );
}

function RoleAccordion({
  role,
  renderRole,
}: {
  role: AgentRoleKey;
  renderRole: (role: AgentRoleKey) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        className="flex w-full items-center justify-between px-2 py-2 text-sm text-paper-300 transition-colors hover:text-paper-100"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <span>{ROLE_LABELS[role]}</span>
        <span className="font-mono text-[11px]">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && <div className="space-y-2 pb-2">{renderRole(role)}</div>}
    </div>
  );
}

export function AgentConfigSection({
  eyebrow,
  description,
  renderRole,
}: {
  eyebrow: string;
  description: React.ReactNode;
  /** Per-role editor body — only rendered (and thus only fetching) when the role is expanded. */
  renderRole: (role: AgentRoleKey) => React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow={eyebrow}>Agent Configuration</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-400">{description}</p>
      <div className="space-y-1">
        {AGENT_ROLES.map((role) => (
          <RoleAccordion key={role} renderRole={renderRole} role={role} />
        ))}
      </div>
    </Card>
  );
}
