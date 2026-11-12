import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceBootstrapScript } from './docker.js';

describe('workspace tool bootstrap', () => {
  it.each(['installed', 'apk', 'apt', 'failed', 'unsupported'])(
    'handles %s tools with absolute package-manager paths',
    async (mode) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-tools-'));
      const git = path.join(dir, 'git');
      const bash = path.join(dir, 'bash');
      const apk = path.join(dir, 'apk');
      const apt = path.join(dir, 'apt-get');
      const marker = path.join(dir, 'calls');
      const script = workspaceBootstrapScript()
        .replaceAll('/usr/bin/git', git)
        .replaceAll('/bin/git', git)
        .replaceAll('/usr/bin/bash', bash)
        .replaceAll('/bin/bash', bash)
        .replaceAll('/sbin/apk', apk)
        .replaceAll('/usr/bin/apt-get', apt);
      try {
        if (mode === 'installed') {
          await fs.writeFile(git, '', { mode: 0o755 });
          await fs.writeFile(bash, '', { mode: 0o755 });
        }
        const manager = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\n${mode === 'failed' ? 'exit 1' : `: > '${git}'; : > '${bash}'; /bin/chmod +x '${git}' '${bash}'`}\n`;
        if (mode === 'apt') {
          await fs.writeFile(apt, manager, { mode: 0o755 });
        } else if (mode !== 'unsupported') {
          await fs.writeFile(apk, manager, { mode: 0o755 });
        }
        const run = () => execFileSync('/bin/sh', ['-ec', script], { stdio: 'pipe' });
        if (mode === 'failed' || mode === 'unsupported') {
          expect(run).toThrow('cannot install git/bash');
        } else {
          expect(run).not.toThrow();
          if (mode === 'installed') {
            await expect(fs.stat(marker)).rejects.toThrow();
          } else {
            expect(await fs.readFile(marker, 'utf8')).toContain('git bash');
          }
        }
      } finally {
        await fs.rm(dir, { force: true, recursive: true });
      }
    }
  );
});
