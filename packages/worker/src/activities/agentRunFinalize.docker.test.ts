import { execFileSync, spawn } from 'node:child_process';
import { ApplicationFailure } from '@temporalio/activity';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('../agents/securityReviewProcessor.js', () => ({ scanDiffForSecurityIssues: vi.fn() }));
vi.mock('../lib/codeSecurityScanner.js', () => ({ scanDiffForCodeIssues: vi.fn(async () => []) }));
vi.mock('../lib/sensitiveFileScanner.js', () => ({
  checkSensitiveFilePath: vi.fn(async (p: string) => (/(^|\/)\.env$/.test(p) ? 'sensitive' : null)),
}));

import { AgentTracer } from '../lib/agentTracer.js';
import {
  commitTrustedTree,
  type GateDeps,
  gateTrustedCommit,
  importAgentTree,
  pushGatedCommit,
} from './agentRunFinalize.js';
import type { Workspace } from './workspace.js';

/**
 * Real-Docker check of the trusted finalize path. Opt in with
 * AGENT_RUN_DOCKER_TEST=1 (needs a Docker daemon and network for `apk add git`).
 * It runs the real shell the activity runs, against two throwaway containers, and
 * attacks the "agent" one: a lying `git`, `* -diff`, a planted symlink and a
 * secret file.
 */
const enabled = process.env.AGENT_RUN_DOCKER_TEST === '1';
const suffix = Math.random().toString(16).slice(2, 8);
const AGENT = `agent-run-it-agent-${suffix}`;
const TRUSTED = `agent-run-it-trusted-${suffix}`;

const sh = (cmd: string) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' });
const dexec = (name: string, cmd: string, cwd = '/workspace/target-repo') =>
  execFileSync('docker', ['exec', '-w', cwd, name, 'sh', '-c', cmd], { encoding: 'utf8' });

function adapter(name: string, pushTarget?: string): Workspace {
  const run = (cmd: string) => dexec(name, cmd);
  return {
    containerId: name,
    destroy: async () => {},
    exec: async (cmd: string) => run(cmd),
    execCapture: async (cmd: string) => {
      try {
        return { exitCode: 0, stderr: '', stdout: run(cmd) };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: err.status ?? 1, stderr: err.stderr ?? '', stdout: err.stdout ?? '' };
      }
    },
    execStdin: (cmd: string, stdin: string | Buffer) =>
      new Promise<string>((resolve, reject) => {
        const p = spawn('docker', [
          'exec',
          '-i',
          '-w',
          '/workspace/target-repo',
          name,
          'sh',
          '-c',
          cmd,
        ]);
        let out = '';
        p.stdout.on('data', (d) => {
          out += d;
        });
        p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
        p.stdin.end(stdin);
      }),
    gitAuthed: async (sub: string) => {
      // The real one injects a credential; the test pushes to a local bare repo.
      const rewritten = sub.replace(/^push origin/, `push --no-verify ${pushTarget}`);
      return run(`git ${rewritten}`);
    },
  } as unknown as Workspace;
}

const passDeps = (): GateDeps => ({
  checkSensitivePath: async (p) => (/(^|\/)\.env$/.test(p) ? 'sensitive' : null),
  scanDiffForCodeIssues: async () => [],
  scanDiffForSecurityIssues: vi.fn(async () => ({ findings: [], passed: true })),
});

describe.skipIf(!enabled)('agent run finalize against real containers', () => {
  let base = '';
  beforeAll(() => {
    for (const n of [AGENT, TRUSTED]) {
      sh(`docker run -d --name ${n} alpine:3.22 sleep infinity`);
      sh(
        `docker exec ${n} sh -c "apk add --no-cache git >/dev/null && mkdir -p /workspace/target-repo"`
      );
    }
    dexec(
      TRUSTED,
      [
        'git init -q -b main .',
        'git config --global user.name t && git config --global user.email t@t',
        "echo hello > README.md && mkdir src && echo 'a' > src/a.txt",
        'git add -A && git commit -q -m base',
        'git init -q --bare /workspace/remote.git',
      ].join(' && ')
    );
    base = dexec(TRUSTED, 'git rev-parse HEAD').trim();
    // The agent starts from a copy of the same checkout.
    sh(`docker cp ${TRUSTED}:/workspace/target-repo - | docker cp - ${AGENT}:/workspace`);
    dexec(AGENT, 'git config --global user.name a && git config --global user.email a@a');
  }, 300_000);

  afterAll(() => {
    for (const n of [AGENT, TRUSTED]) {
      try {
        sh(`docker rm -f ${n}`);
      } catch {
        /* gone */
      }
    }
  });

  it('judges the real bytes even when the agent replaced git and hid files with -diff', async () => {
    // The agent sabotages its own container as hard as it can.
    dexec(
      AGENT,
      [
        "printf '#!/bin/sh\\necho lies\\nexit 0\\n' > /usr/bin/git && chmod +x /usr/bin/git",
        "echo '* -diff' > .gitattributes",
        "echo 'API_TOKEN=hunter2' > src/new.txt",
        'ln -s /etc/passwd link',
        'echo nothing > .env',
        "printf 'a\\000b' > bin.dat",
      ].join(' && ')
    );
    const agent = adapter(AGENT);
    const trusted = adapter(TRUSTED, '/workspace/remote.git');
    await importAgentTree(agent, trusted);
    const out = await commitTrustedTree(trusted, base, 'auto: it');
    expect(out.empty).toBe(false);
    if (out.empty) {
      return;
    }
    const tracer = new AgentTracer();
    const f = await gateTrustedCommit(
      trusted,
      { allowWorkflowChanges: false, baseSha: base, sha: out.sha, tracer },
      passDeps()
    ).catch((e) => e as ApplicationFailure);
    expect(f).toBeInstanceOf(ApplicationFailure);
    const msg = (f as ApplicationFailure).message;
    // Caught by deterministic rules in the trusted container, not by the agent's git.
    expect(msg).toContain('[symlink] link');
    expect(msg).toContain('[sensitive_file] .env');
    expect(msg).toContain('[binary] bin.dat');
    expect((f as ApplicationFailure).type).toBe('AGENT_RUN_PUSH_POLICY');
  }, 300_000);

  it('pushes exactly the gated SHA for a clean change, and the diff shows content despite -diff', async () => {
    // A fresh clean change on a fresh agent state.
    // The first import moved the agent's .git aside (to keep it out of the archive).
    dexec(
      AGENT,
      'mv ../.agent-git-moved .git; apk fix --reinstall git >/dev/null 2>&1; rm -f link .env bin.dat src/new.txt .gitattributes'
    );
    dexec(AGENT, 'git checkout -q -- . && git clean -fdq');
    dexec(
      AGENT,
      "echo '* -diff' > .gitattributes && echo 'new text line' > src/b.txt && echo 'changed' >> README.md"
    );
    const agent = adapter(AGENT);
    const trusted = adapter(TRUSTED, '/workspace/remote.git');
    // Reset the trusted checkout to the base for the second attempt.
    dexec(TRUSTED, `git reset -q --hard ${base} && git clean -fdq`);
    await importAgentTree(agent, trusted);
    const out = await commitTrustedTree(trusted, base, 'auto: clean');
    expect(out.empty).toBe(false);
    if (out.empty) {
      return;
    }
    const deps = passDeps();
    const gated = await gateTrustedCommit(
      trusted,
      { allowWorkflowChanges: false, baseSha: base, sha: out.sha, tracer: new AgentTracer() },
      deps
    );
    // `* -diff` would print "Binary files differ"; the hardened flags read the text.
    expect(gated.diff).toContain('+new text line');
    expect(deps.scanDiffForSecurityIssues).toHaveBeenCalledWith(
      expect.stringContaining('+new text line')
    );
    await pushGatedCommit(trusted, gated, 'auto/agent-test');
    const remote = dexec(
      TRUSTED,
      'git --git-dir=/workspace/remote.git rev-parse refs/heads/auto/agent-test'
    ).trim();
    expect(remote).toBe(gated.sha);
  }, 300_000);
});
