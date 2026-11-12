import { describe, expect, it } from 'vitest';
import { AGENT_RUN_TEMPLATE_NAME } from '../../packages/shared/src/lib/agentRun.ts';
import {
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from '../../packages/shared/src/lib/channelTask.ts';
import {
  WORKFLOW_CATALOG,
  WORKFLOW_GROUPS,
  workflowPresentation,
} from '../../packages/shared/src/lib/workflowCatalog.ts';
import { BUILTIN_TEMPLATES } from '../../packages/shared/src/workflow/templates/index.ts';
import { USE_CASE_GROUPS, USE_CASES } from './useCases.mjs';

describe('workflow presentation catalog', () => {
  it('keeps public titles, groups and reading order in parity', () => {
    expect(WORKFLOW_GROUPS).toEqual(USE_CASE_GROUPS.map(({ id, label }) => ({ id, label })));
    expect(Object.keys(WORKFLOW_CATALOG).filter((name) => Object.hasOwn(USE_CASES, name))).toEqual(
      Object.keys(USE_CASES)
    );
    for (const [name, { title, group }] of Object.entries(USE_CASES)) {
      expect(WORKFLOW_CATALOG[name], name).toEqual({ group, title });
    }
  });

  it('covers every built-in, including system templates without public pages', () => {
    const names = [
      ...BUILTIN_TEMPLATES.map((template) => template.name),
      AGENT_RUN_TEMPLATE_NAME,
      CHANNEL_ASSISTANT_TEMPLATE_NAME,
      CHANNEL_TASK_TEMPLATE_NAME,
    ];
    expect(Object.keys(WORKFLOW_CATALOG).sort()).toEqual([...new Set(names)].sort());
    for (const entry of Object.values(WORKFLOW_CATALOG)) {
      expect(entry.title.trim()).not.toBe('');
      expect(WORKFLOW_GROUPS.some(({ id }) => id === entry.group)).toBe(true);
    }
  });

  it('uses literal custom names and ownership fallbacks', () => {
    expect(workflowPresentation({ name: 'Ship it', team: { id: 'team' } })).toEqual({
      group: 'team',
      title: 'Ship it',
    });
    expect(workflowPresentation({ name: '__proto__', team: null })).toEqual({
      group: 'other',
      title: '__proto__',
    });
  });
});
