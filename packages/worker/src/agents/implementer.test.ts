import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';

/**
 * Exercises the built-in workspace tools directly. Mastra's `createTool`,
 * `Agent` and `Mastra` are replaced with thin fakes so the tool definitions
 * (and the security checks wrapped around them) run without a model.
 */

vi.mock('@mastra/core/tools', () => ({
  createTool: (def: unknown) => def,
}));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    tools: Record<string, unknown>;
    constructor(cfg: { tools: Record<string, unknown> }) {
      this.tools = cfg.tools;
    }
  },
}));
vi.mock('@mastra/core', () => ({
  Mastra: class {
    agents: Record<string, unknown>;
    constructor(cfg: { agents: Record<string, unknown> }) {
      this.agents = cfg.agents;
    }
    getAgent(id: string) {
      return this.agents[id];
    }
  },
}));

vi.mock('../lib/models.js', () => ({ getModel: vi.fn(async () => ({})) }));
vi.mock('../lib/config/agentSkills.js', () => ({
  loadAgentSkills: vi.fn(async () => []),
  loadAgentToolConfig: vi.fn(async () => null),
}));
vi.mock('../lib/config/mcpConnection.js', () => ({ resolveAgentMcpUrl: vi.fn(async () => null) }));
vi.mock('./mcpTools.js', () => ({
  isMcpToolEnabled: () => false,
  loadMcpTools: vi.fn(),
}));

const sensitiveMock = vi.fn(async (_path: string): Promise<string | null> => null);
vi.mock('../lib/sensitiveFileScanner.js', () => ({
  checkSensitiveFilePath: (p: string) => sensitiveMock(p),
}));
vi.mock('../lib/shellCommandScanner.js', () => ({
  scanShellCommand: vi.fn(async () => null),
}));

import { createImplementerAgent } from './implementer.js';

type ToolDef<I, O> = { execute: (input: I) => Promise<O> };
type WriteTool = ToolDef<{ path: string; content: string }, { result: string }>;

const workspace = {
  containerId: 'workspace-test',
  destroy: vi.fn(async () => {}),
  exec: vi.fn(async () => ''),
  execCapture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
  execStdin: vi.fn(async () => ''),
  gitAuthed: vi.fn(async () => ''),
} satisfies Workspace;

async function writeTool(): Promise<WriteTool> {
  const { agent } = await createImplementerAgent(
    workspace,
    undefined,
    null,
    [],
    undefined,
    {} as never
  );
  return (agent as unknown as { tools: { writeFile: WriteTool } }).tools.writeFile;
}

beforeEach(() => {
  vi.clearAllMocks();
  sensitiveMock.mockResolvedValue(null);
});

describe('implementer writeFile tool', () => {
  it('streams the content over stdin so files past the argv limit can be written', async () => {
    const tool = await writeTool();
    const content = `export const blob = '${'x'.repeat(300 * 1024)}';\n`;

    const out = await tool.execute({ content, path: 'src/generated/blob.ts' });

    expect(out.result).toBe('File written: src/generated/blob.ts');
    expect(workspace.execStdin).toHaveBeenCalledWith("cat > 'src/generated/blob.ts'", content);
    // The content never rides on a command line.
    for (const call of workspace.exec.mock.calls) {
      expect((call as unknown as [string])[0].length).toBeLessThan(1024);
    }
  });

  it('runs the sensitive-file policy against the normalised path, not the raw spelling', async () => {
    const tool = await writeTool();
    await tool.execute({ content: 'SECRET=1', path: './config/../.env' });
    expect(sensitiveMock).toHaveBeenCalledWith('.env');
  });

  it('returns the block message and skips the write when the policy hits', async () => {
    sensitiveMock.mockResolvedValue("Write blocked: '.env' matches sensitive file pattern");
    const tool = await writeTool();
    const out = await tool.execute({ content: 'SECRET=1', path: '.env' });
    expect(out.result).toContain('Write blocked');
    expect(workspace.execStdin).not.toHaveBeenCalled();
  });

  it('rejects path traversal before touching the workspace', async () => {
    const tool = await writeTool();
    const out = await tool.execute({ content: 'x', path: '../../etc/passwd' });
    expect(out.result).toContain('Path traversal rejected');
    expect(sensitiveMock).not.toHaveBeenCalled();
    expect(workspace.execStdin).not.toHaveBeenCalled();
  });
});
