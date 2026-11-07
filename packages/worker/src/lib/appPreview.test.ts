import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import {
  APP_PREVIEW_LAUNCHER,
  PreviewNotReadyError,
  previewStopScript,
  startAppPreview,
} from './appPreview.js';

const loadSetupSecrets = vi.fn();
vi.mock('./repoSetupRun.js', () => ({
  loadSetupSecrets: (...args: unknown[]) => loadSetupSecrets(...args),
}));

const config = {
  env: { GREETING: "hello ' preview" },
  readyUrl: 'http://localhost:4173/health',
  start: 'npm run dev',
};

describe('startAppPreview', () => {
  let exec: ReturnType<typeof vi.fn>;
  let workspace: Workspace;

  beforeEach(() => {
    exec = vi.fn(async (command: string) => {
      if (command.includes('fetch(url')) {
        return '';
      }
      if (command.includes('const maxBytes')) {
        return 'password=secret-value\n';
      }
      return '';
    });
    workspace = { exec } as unknown as Workspace;
  });

  it('runs setup with a bounded timeout, starts a process group and returns helpers', async () => {
    const preview = await startAppPreview(
      workspace,
      { ...config, setup: 'npm ci' },
      { timeoutMs: 12_000 }
    );

    expect(preview.baseUrl).toBe('http://localhost:4173');
    expect(exec.mock.calls[0]?.[0]).toBe("sh -c 'npm ci'");
    expect(exec.mock.calls[0]?.[1]).toEqual({
      secretEnv: config.env,
      timeoutMs: 1_080_000,
    });
    expect(exec.mock.calls[1]?.[0]).toContain('detached: true');
    // `--` keeps a start command that begins with a dash out of Node's own flag
    // parsing.
    expect(exec.mock.calls[1]?.[0]).toContain(' -- ');
    expect(exec.mock.calls[1]?.[0]).toContain('["-s", "--", "sh", "-c", wrapper, "sh", command]');
    expect(exec.mock.calls[1]?.[0]).not.toContain('"tini" : "sh", hasTini ? ["-s", "-g"');
    expect(exec.mock.calls[1]?.[0]).toContain('while :; do sleep 3600; done');
    expect(exec.mock.calls[1]?.[0]).toContain('/tmp/.asw/preview.log');
    expect(exec.mock.calls[1]?.[0]).toContain('/tmp/.asw/preview.pgid.mark');
    expect(exec.mock.calls[1]?.[0]).not.toContain(config.env.GREETING);
    expect(exec.mock.calls[1]?.[1]).toEqual({ secretEnv: config.env, timeoutMs: 10_000 });
    expect(exec.mock.calls[2]?.[0]).toContain('fetch(url');
    await expect(preview.logTail(32)).resolves.toBe('password=***\n');
    await preview.stop();
    expect(exec.mock.calls.at(-1)?.[0]).toContain('process.kill(-pgid');
  });

  it('adds the named setup secrets to the env and masks them in the log tail', async () => {
    loadSetupSecrets.mockResolvedValueOnce({ API_KEY: 'secret-value' });
    const preview = await startAppPreview(
      workspace,
      { ...config, secrets: ['API_KEY'], setup: 'npm run seed' },
      { connectionId: 'repo-1' }
    );
    expect(loadSetupSecrets).toHaveBeenCalledWith('repo-1', ['API_KEY']);
    const secretEnv = { ...config.env, API_KEY: 'secret-value' };
    expect(exec.mock.calls[0]?.[1]).toMatchObject({ secretEnv });
    expect(exec.mock.calls[1]?.[1]).toMatchObject({ secretEnv });
    for (const [command] of exec.mock.calls) {
      expect(command).not.toContain('secret-value');
    }
    await expect(preview.logTail(32)).resolves.toBe('password=***\n');
  });

  it('refuses to start a recipe whose env still holds a secret-looking value', async () => {
    const started = startAppPreview(workspace, {
      ...config,
      env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', PORT: '3000' },
    });
    await expect(started).rejects.toThrow(/PREVIEW_ENV_LOOKS_SECRET.*GITHUB_TOKEN/);
    await expect(started).rejects.not.toThrow(/ghp_|PORT/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails before running anything when a named secret has no value', async () => {
    loadSetupSecrets.mockRejectedValueOnce(
      new Error('workspace setup: setup secret API_KEY has no value')
    );
    await expect(
      startAppPreview(workspace, { ...config, secrets: ['API_KEY'] }, { connectionId: 'repo-1' })
    ).rejects.toThrow('App preview: setup secret API_KEY has no value');
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws PreviewNotReadyError with a redacted log tail and stops the app on timeout', async () => {
    exec.mockImplementation(async (command: string) => {
      if (command.includes('fetch(url')) {
        throw new Error('workspace command timed out');
      }
      if (command.includes('const maxBytes')) {
        return 'ghp_123456789012345678901234567890123456\n';
      }
      return '';
    });

    await expect(startAppPreview(workspace, config, { timeoutMs: 1000 })).rejects.toMatchObject({
      logTail: '***\n',
      name: 'PreviewNotReadyError',
    });
    expect(exec.mock.calls.at(-1)?.[0]).toContain('process.kill(-pgid');
  });

  it('runs the app in its own process group, so stop() kills the whole tree', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-preview-'));
    const pgidFile = path.join(dir, 'preview.pgid');
    const markFile = `${pgidFile}.mark`;
    const sinceFile = `${pgidFile}.since`;
    const logFile = path.join(dir, 'preview.log');
    let group = 0;
    try {
      execFileSync(process.execPath, [
        '-e',
        APP_PREVIEW_LAUNCHER,
        'sleep 30',
        pgidFile,
        logFile,
        markFile,
        sinceFile,
      ]);
      group = Number(await fs.readFile(pgidFile, 'utf8'));

      expect(Number.isInteger(group) && group > 1).toBe(true);
      expect(Number(await fs.readFile(sinceFile, 'utf8'))).toBeGreaterThan(0);
      expect(groupAlive(group)).toBe(true);
      // Older launchers have no mark file and still get process-group cleanup.
      await fs.unlink(markFile);
      await fs.unlink(sinceFile);
      // The whole tree: `sh -c` and the command it started share the group.
      execFileSync(process.execPath, ['-e', previewStopScript(pgidFile)]);

      expect(await waitForGone(group)).toBe(true);
      await expect(fs.access(pgidFile)).rejects.toThrow();
      await expect(fs.access(markFile)).rejects.toThrow();
      await expect(fs.access(sinceFile)).rejects.toThrow();
    } finally {
      if (group > 1 && groupAlive(group)) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('uses tini as the process-group leader when it is executable on PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-preview-tini-launcher-'));
    const bin = path.join(dir, 'bin');
    const pgidFile = path.join(dir, 'preview.pgid');
    const logFile = path.join(dir, 'preview.log');
    const argsFile = path.join(dir, 'tini.args');
    const markFile = `${pgidFile}.mark`;
    const sinceFile = `${pgidFile}.since`;
    let group = 0;
    try {
      await fs.mkdir(bin);
      await fs.symlink('/bin/sh', path.join(bin, 'sh'));
      await fs.symlink('/bin/sleep', path.join(bin, 'sleep'));
      await fs.writeFile(
        path.join(bin, 'tini'),
        '#!/bin/sh\nprintf "%s\\n" "$@" >"$TINI_ARGS_FILE"\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
        { mode: 0o755 }
      );
      execFileSync(
        process.execPath,
        ['-e', APP_PREVIEW_LAUNCHER, 'sleep 30', pgidFile, logFile, markFile, sinceFile],
        { env: { ...process.env, PATH: bin, TINI_ARGS_FILE: argsFile } }
      );
      group = Number(await fs.readFile(pgidFile, 'utf8'));

      expect(group).toBeGreaterThan(1);
      expect(await fs.readFile(`${pgidFile}.reaper`, 'utf8')).toBe('1');
      const tiniArgs = (await waitForFile(argsFile)).trim().split('\n');
      expect(tiniArgs.slice(0, 4)).toEqual(['-s', '--', 'sh', '-c']);
      expect(tiniArgs[4]).toContain('sh -c "$1"');
      expect(tiniArgs[4]).toContain('while :; do sleep 3600; done');
      expect(tiniArgs[5]).toBe('sh');
      expect(tiniArgs[6]).toBe('sleep 30');
      expect(groupAlive(group)).toBe(true);
      execFileSync(process.execPath, ['-e', previewStopScript(pgidFile)]);
      expect(await waitForGone(group)).toBe(true);
      await expect(fs.access(`${pgidFile}.reaper`)).rejects.toThrow();
    } finally {
      if (group > 1 && groupAlive(group)) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('keeps the original shell launcher when tini is absent from PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-preview-no-tini-launcher-'));
    const bin = path.join(dir, 'bin');
    const pgidFile = path.join(dir, 'preview.pgid');
    const logFile = path.join(dir, 'preview.log');
    const markFile = `${pgidFile}.mark`;
    const sinceFile = `${pgidFile}.since`;
    let group = 0;
    try {
      await fs.mkdir(bin);
      await fs.symlink('/bin/sh', path.join(bin, 'sh'));
      await fs.symlink('/bin/sleep', path.join(bin, 'sleep'));
      execFileSync(
        process.execPath,
        ['-e', APP_PREVIEW_LAUNCHER, 'sleep 30', pgidFile, logFile, markFile, sinceFile],
        { env: { ...process.env, PATH: bin } }
      );
      group = Number(await fs.readFile(pgidFile, 'utf8'));

      expect(group).toBeGreaterThan(1);
      await expect(fs.access(`${pgidFile}.reaper`)).rejects.toThrow();
      expect(groupAlive(group)).toBe(true);
      execFileSync(process.execPath, ['-e', previewStopScript(pgidFile)]);
      expect(await waitForGone(group)).toBe(true);
    } finally {
      if (group > 1 && groupAlive(group)) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('orders reaper TERM and KILL passes without signalling tini or its child on TERM', () => {
    const script = previewStopScript();
    const operations = [
      'signalGroup("SIGTERM")',
      'signalReaperDescendants("SIGTERM", 2)',
      'signalMarked("SIGTERM")',
      'setTimeout(resolve, 1500)',
      'signalReaperDescendants("SIGKILL", 2)',
      'signalReaperChildren("SIGKILL")',
      'process.kill(pgid, "SIGKILL")',
    ];
    let previous = -1;
    for (const operation of operations) {
      const index = script.indexOf(operation);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(script).toContain('reaperInfo?.comm === "tini"');
    expect(script).toContain('info.ppid !== pgid');
    expect(script).toContain('parseStat(pid)?.ppid === pgid');
    expect(script).not.toContain('process.kill(pgid, "SIGTERM")');
  });

  it.skipIf(process.platform !== 'linux')(
    'stops a daemonized preview child by its inherited environment mark',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-preview-mark-'));
      const pgidFile = path.join(dir, 'preview.pgid');
      const markFile = `${pgidFile}.mark`;
      const sinceFile = `${pgidFile}.since`;
      const daemonPidFile = path.join(dir, 'daemon.pid');
      const logFile = path.join(dir, 'preview.log');
      let group = 0;
      let mark = '';
      try {
        const command = `setsid sh -c 'echo $$ >${daemonPidFile}; exec sleep 300' >/dev/null 2>&1 & sleep 300`;
        execFileSync(process.execPath, [
          '-e',
          APP_PREVIEW_LAUNCHER,
          command,
          pgidFile,
          logFile,
          markFile,
          sinceFile,
        ]);
        group = Number(await fs.readFile(pgidFile, 'utf8'));
        mark = await fs.readFile(markFile, 'utf8');
        const daemonPid = Number(await waitForFile(daemonPidFile));

        expect(mark).toMatch(/^[a-f0-9]{32}$/);
        expect(await waitForMarkedProcess(mark)).toBe(true);
        execFileSync(process.execPath, ['-e', previewStopScript(pgidFile)]);

        expect(await waitForProcessGone(daemonPid)).toBe(true);
        expect(await waitForMarkedProcessesGone(mark)).toBe(true);
        await expect(fs.access(pgidFile)).rejects.toThrow();
        await expect(fs.access(markFile)).rejects.toThrow();
        await expect(fs.access(sinceFile)).rejects.toThrow();
      } finally {
        if (group > 1 && groupAlive(group)) {
          try {
            process.kill(-group, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        for (const pid of markedProcesses(mark)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await fs.rm(dir, { force: true, recursive: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'leaves an unrelated host orphan started after the preview alive',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-preview-host-sweep-'));
      const pgidFile = path.join(dir, 'preview.pgid');
      const markFile = `${pgidFile}.mark`;
      const sinceFile = `${pgidFile}.since`;
      const daemonPidFile = path.join(dir, 'unrelated.pid');
      const logFile = path.join(dir, 'preview.log');
      let group = 0;
      let daemonPid = 0;
      let mark = '';
      try {
        execFileSync(process.execPath, [
          '-e',
          APP_PREVIEW_LAUNCHER,
          'sleep 300',
          pgidFile,
          logFile,
          markFile,
          sinceFile,
        ]);
        group = Number(await fs.readFile(pgidFile, 'utf8'));
        mark = await fs.readFile(markFile, 'utf8');
        const command = `setsid sh -c 'echo $$ >${daemonPidFile}; exec sleep 300' >/dev/null 2>&1 &`;
        execFileSync('sh', ['-c', command]);
        daemonPid = Number(await waitForFile(daemonPidFile));

        const since = Number(await fs.readFile(sinceFile, 'utf8'));
        const daemon = processStat(daemonPid);
        expect(daemon).toMatchObject({ ppid: 1 });
        expect(daemon?.pgrp).not.toBe(group);
        expect(daemon?.startTime).toBeGreaterThanOrEqual(since);
        expect(markedProcesses(mark)).not.toContain(daemonPid);

        execFileSync(process.execPath, ['-e', previewStopScript(pgidFile, markFile, sinceFile)]);

        expect(processStat(daemonPid)?.state).not.toBeUndefined();
        expect(processStat(daemonPid)?.state).not.toBe('Z');
      } finally {
        if (daemonPid > 1) {
          try {
            process.kill(daemonPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
          await waitForProcessGone(daemonPid);
        }
        if (group > 1 && groupAlive(group)) {
          try {
            process.kill(-group, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await fs.rm(dir, { force: true, recursive: true });
      }
    }
  );

  it('exposes the typed readiness error', () => {
    expect(new PreviewNotReadyError('not ready', 'log')).toMatchObject({
      logTail: 'log',
      name: 'PreviewNotReadyError',
    });
  });
});

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function processStat(pid: number): {
  pgrp: number;
  ppid: number;
  startTime: number;
  state: string;
} | null {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return {
      pgrp: Number(fields[2]),
      ppid: Number(fields[1]),
      startTime: Number(fields[19]),
      state: fields[0] ?? '',
    };
  } catch {
    return null;
  }
}

function markedProcesses(mark: string): number[] {
  if (!mark) {
    return [];
  }
  const expected = Buffer.from(`AUTO_SWE_PREVIEW_MARK=${mark}\0`);
  return fsSync
    .readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        return fsSync.readFileSync(`/proc/${entry}/environ`).includes(expected);
      } catch {
        return false;
      }
    })
    .map(Number);
}

async function waitForMarkedProcess(mark: string): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (markedProcesses(mark).length > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return markedProcesses(mark).length > 0;
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForProcessGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitForMarkedProcessesGone(mark: string): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (markedProcesses(mark).length === 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return markedProcesses(mark).length === 0;
}

async function waitForGone(pgid: number): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !groupAlive(pgid);
}
