import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kubernetesKeeperPidProbeScript } from './keeperPidProbe.js';

describe('kubernetesKeeperPidProbeScript', () => {
  const script = kubernetesKeeperPidProbeScript();

  it('selects top-level processes in the probe shell mount namespace, excluding the shell', () => {
    expect(script).toContain('readlink "/proc/$$/ns/mnt" 2>/dev/null');
    expect(script).toContain('readlink "$asw_d/ns/mnt" 2>/dev/null) || continue');
    expect(script).toContain('[ "$asw_mnt" = "$asw_self_mnt" ] || continue');
    expect(script).toContain('[ "$asw_p" = "$$" ] && continue');
    expect(script).toContain('if [ "$(asw_ppid "$asw_p")" = 0 ]; then echo "$asw_p"; fi');
  });

  describe.skipIf(process.platform !== 'linux')('Linux process behavior', () => {
    it('does not report the probe shell or its command-substitution processes', () => {
      const output = execFileSync(
        'sh',
        ['-c', `printf '__probe_shell=%s\\n' "$$"\n${kubernetesKeeperPidProbeScript()}`],
        { encoding: 'utf8', timeout: 10_000 }
      );
      const [shellLine, ...pids] = output.trimEnd().split('\n');
      expect(shellLine).toMatch(/^__probe_shell=\d+$/);
      const shellPid = shellLine?.slice('__probe_shell='.length);
      const ownMountNamespace = readlinkSync('/proc/self/ns/mnt');
      expect(pids).not.toContain(shellPid);
      for (const pid of pids) {
        expect(readlinkSync(`/proc/${pid}/ns/mnt`)).toBe(ownMountNamespace);
        expect(readFileSync(`/proc/${pid}/status`, 'utf8')).toMatch(/^PPid:\s+0$/m);
      }
    });
  });
});
