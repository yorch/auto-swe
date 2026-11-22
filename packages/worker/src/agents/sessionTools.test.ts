import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { workerToolsFor } from './sessionTools.js';

const workspace = {
  containerId: 'workspace-1',
  installTools: vi.fn(async (tools: { key: string }[]) =>
    tools.map((tool) => ({ key: tool.key, version: '1.0.0' }))
  ),
} as unknown as Workspace;

const tracer = { addToolCall: vi.fn() } as unknown as AgentTracer;

function names(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

describe('workerToolsFor', () => {
  it('binds the lesson tools only when the session names a repository', () => {
    expect(names(workerToolsFor({ repoId: 'repo-1', toolKeys: null, workspace }))).toEqual([
      'searchLessons',
      'explainLesson',
    ]);
    expect(workerToolsFor({ toolKeys: null, workspace })).toEqual([]);
  });

  it('binds submitLearning and provisionTool only when the tool keys name them', () => {
    // `null` is "no opinion" over the workspace tools, and never implies either of these.
    expect(workerToolsFor({ toolKeys: null, workspace })).toEqual([]);
    expect(workerToolsFor({ toolKeys: [], workspace })).toEqual([]);
    expect(names(workerToolsFor({ toolKeys: ['submitLearning'], workspace }))).toEqual([
      'submitLearning',
    ]);
    expect(names(workerToolsFor({ toolKeys: ['provisionTool'], workspace }))).toEqual([
      'provisionTool',
    ]);
  });

  it('binds every grant together, in one list, for one Agent row', () => {
    expect(
      names(
        workerToolsFor({
          ctx: { orgId: 'org-1', teamId: 'team-1' },
          repoId: 'repo-1',
          toolKeys: ['readFile', 'submitLearning', 'provisionTool'],
          tracer,
          workspace,
        })
      )
    ).toEqual(['searchLessons', 'explainLesson', 'submitLearning', 'provisionTool']);
  });

  it('binds knowledge search nowhere: that tool is the harness binding, not this one', () => {
    expect(names(workerToolsFor({ toolKeys: ['searchKnowledge'], workspace }))).toEqual([]);
  });

  it('runs the same installer body the Mastra tool runs, and answers instead of throwing', async () => {
    const [provision] = workerToolsFor({ toolKeys: ['provisionTool'], workspace });
    const result = (await provision?.call({ key: 'just' })) as { error?: string; ok: boolean };
    // Whether the install is allowed is the settings' and the catalog's decision; what this
    // binding guarantees is the same body, the same refusals, and a structured result.
    expect(typeof result.ok).toBe('boolean');
    if (!result.ok) {
      expect(result.error).toContain("'just'");
    }
  });
});
