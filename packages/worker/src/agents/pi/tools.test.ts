import type { AgentTool } from '@mariozechner/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../activities/workspace.js';
import type { HarnessExec, HarnessExecResult, HarnessTurn } from '../harness/adapter.js';
import { matchFiles, piGrepTool, trimGrepOutput } from './tools.js';

const ROOT = '/workspace/target-repo';
const LISTING = [
  './package.json',
  './src/a.ts',
  './src/deep/b.spec.ts',
  './src/deep/c.json',
  './.github/ci.yml',
  '',
].join('\n');

describe('matchFiles', () => {
  it('matches a name at any depth when the pattern has no slash, as fd does', () => {
    expect(matchFiles(LISTING, '*.ts', ROOT, 100)).toEqual([
      `${ROOT}/src/a.ts`,
      `${ROOT}/src/deep/b.spec.ts`,
    ]);
    expect(matchFiles(LISTING, 'package.json', ROOT, 100)).toEqual([`${ROOT}/package.json`]);
  });

  it('matches the path from the root when the pattern has a slash', () => {
    expect(matchFiles(LISTING, 'src/**/*.spec.ts', ROOT, 100)).toEqual([
      `${ROOT}/src/deep/b.spec.ts`,
    ]);
    expect(matchFiles(LISTING, 'src/*.json', ROOT, 100)).toEqual([]);
  });

  it('stops at the limit, and leaves dot-directories to an explicit pattern', () => {
    expect(matchFiles(LISTING, '*', ROOT, 2)).toHaveLength(2);
    expect(matchFiles(LISTING, '**/*.yml', ROOT, 100)).toEqual([]);
    expect(matchFiles(LISTING, '.github/*.yml', ROOT, 100)).toEqual([`${ROOT}/.github/ci.yml`]);
  });
});

describe('trimGrepOutput', () => {
  const OUTPUT = [
    'src/a.ts:3:const token = 1;',
    'src/a.ts-4-// next',
    '--',
    'node_modules/x/index.js:9:token',
    'src/b.json:1:{"token": 2}',
    'src/c.ts:7:token()',
  ].join('\n');

  it('keeps ripgrep output as it is, up to the limit of matches', () => {
    expect(trimGrepOutput(OUTPUT, { filter: false, limit: 2 })).toEqual({
      text: 'src/a.ts:3:const token = 1;\nsrc/a.ts-4-// next\n--\nnode_modules/x/index.js:9:token',
      truncated: true,
    });
  });

  it('drops the ./ prefix grep -r puts on every path', () => {
    expect(
      trimGrepOutput('./src/a.ts:1:x\n./.git/config:2:x', { filter: true, limit: 100 })
    ).toEqual({ text: 'src/a.ts:1:x', truncated: false });
  });

  it("filters grep's output by glob and drops node_modules and .git", () => {
    expect(trimGrepOutput(OUTPUT, { filter: true, glob: '*.ts', limit: 100 })).toEqual({
      text: 'src/a.ts:3:const token = 1;\nsrc/a.ts-4-// next\n--\nsrc/c.ts:7:token()',
      truncated: false,
    });
  });
});

describe('piGrepTool', () => {
  function grepWith(hasRipgrep: boolean) {
    const calls: HarnessExec[] = [];
    const exec = vi.fn(async (call: HarnessExec): Promise<HarnessExecResult> => {
      calls.push(call);
      const exitCode = call.script.startsWith('command -v rg') ? (hasRipgrep ? 0 : 1) : 0;
      return {
        droppedBytes: 0,
        exitCode,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from('src/a.ts:1:hit'),
        timedOut: false,
      };
    });
    const tool = piGrepTool({
      holder: { current: { exec } as unknown as HarnessTurn },
      maxToolOutputChars: 20_000,
      parameters: {} as AgentTool['parameters'],
      workspace: {} as Workspace,
    });
    return { calls, tool };
  }

  const params = {
    context: 2,
    glob: '*.ts',
    ignoreCase: true,
    literal: true,
    path: `${ROOT}/src`,
    pattern: '-rf; $(boom)',
  };

  it('runs ripgrep, with every argument as its own argv entry, when the image has it', async () => {
    const { calls, tool } = grepWith(true);
    await expect(tool.execute('c1', params)).resolves.toEqual({
      content: [{ text: 'src/a.ts:1:hit', type: 'text' }],
      details: undefined,
    });
    expect(calls[1]).toMatchObject({
      args: [
        'rg',
        '--line-number',
        '--no-heading',
        '--color',
        'never',
        '-F',
        '-i',
        '-C',
        '2',
        '-g',
        '*.ts',
        '-e',
        '-rf; $(boom)',
        '--',
        'src',
      ],
      script: 'exec "$@"',
    });
  });

  it('falls back to grep -rn, and probes for ripgrep once', async () => {
    const { calls, tool } = grepWith(false);
    await tool.execute('c1', params);
    await tool.execute('c2', { pattern: 'x' });
    expect(calls.filter((c) => c.script.startsWith('command -v rg'))).toHaveLength(1);
    expect(calls[1]?.args).toEqual([
      'grep',
      '-rn',
      '-F',
      '-i',
      '-C',
      '2',
      '-e',
      '-rf; $(boom)',
      '--',
      'src',
    ]);
    expect(calls[2]?.args).toEqual(['grep', '-rn', '-E', '-e', 'x', '--', '.']);
  });

  it('refuses a search root outside the workspace', async () => {
    const { tool } = grepWith(true);
    await expect(tool.execute('c1', { path: '/etc', pattern: 'x' })).rejects.toThrow(
      'Path rejected'
    );
  });
});
