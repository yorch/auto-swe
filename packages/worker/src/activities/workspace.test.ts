import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/execUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/execUtils.js')>();
  return {
    ...actual,
    execShellAsync: vi.fn(async () => ''),
  };
});

// Mock the workflow-defaults resolver so `createWorkspace` doesn't hit a real
// DB — it now reads container caps + the default base image from here.
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({
    workspaceCpus: 2,
    workspaceImage: 'node:24-alpine',
    workspaceMemory: '4g',
    workspacePidsLimit: 512,
  })),
}));

import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { execShellAsync } from '../lib/execUtils.js';
import { buildMetadataBlockArgs, createWorkspace, shellQuote } from './workspace.js';

describe('shellQuote', () => {
  it('wraps a plain string', () => expect(shellQuote('abc')).toBe("'abc'"));
  it('escapes an embedded single quote', () => expect(shellQuote("it's")).toBe("'it'\\''s'"));
  it('escapes consecutive single quotes', () => expect(shellQuote("''")).toBe("''\\'''\\'''"));
  it('neutralizes command substitution', () =>
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'"));
  it('neutralizes backticks', () => expect(shellQuote('`id`')).toBe("'`id`'"));
  it('neutralizes separators and chaining', () =>
    expect(shellQuote('a; b && c | d')).toBe("'a; b && c | d'"));
  it('preserves newlines inside the quotes', () => expect(shellQuote('a\nb')).toBe("'a\nb'"));
  it('quotes the empty string', () => expect(shellQuote('')).toBe("''"));

  it.each([
    "it's a 'test'",
    '$(touch /tmp/pwned)',
    '`touch /tmp/pwned`',
    'a; rm -rf / && echo done',
    'line1\nline2',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${PATH} is intentional adversarial input
    '$HOME ${PATH} \\backslash',
  ])('round-trips %j through sh -c printf', (input) => {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(input)}`], {
      encoding: 'utf8',
    });
    expect(out).toBe(input);
  });
});

describe('buildMetadataBlockArgs', () => {
  it('targets the workspace container network namespace, adds NET_ADMIN, and is self-removing', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain('--rm');
    expect(cmd).toContain('--network container:workspace-abc123');
    expect(cmd).toContain('--cap-add=NET_ADMIN');
  });

  it('installs blackhole routes for all three cloud metadata addresses', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain('blackhole 169.254.169.254/32'); // AWS/GCP/Azure IMDS
    expect(cmd).toContain('blackhole 169.254.170.2/32'); // ECS task metadata
    expect(cmd).toContain('blackhole fd00:ec2::254/128'); // IPv6 IMDS
  });

  it('verifies a blackhole route actually landed and exits non-zero otherwise', () => {
    // Guards against a silent no-op: if the runtime's `ip` lacks blackhole
    // support the adds fail quietly, so the sidecar must fail loudly (non-zero
    // exit → caller logs a warning) rather than report false success.
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain('grep -q blackhole');
    expect(cmd).toContain('exit 1');
    // The IPv4 IMDS adds must NOT be individually `|| true`'d (that would mask
    // the failure the verify step is meant to catch).
    expect(cmd).not.toContain('169.254.169.254/32 2>/dev/null || true');
  });

  it('shell-quotes the sidecar image argument', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain(shellQuote('alpine:3.20'));
  });

  it('does not grant the sidecar capabilities beyond NET_ADMIN', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).not.toContain('--cap-drop');
  });
});

describe('createWorkspace metadata-IP egress block (execShellAsync mocked — no Docker daemon here)', () => {
  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(async () => '');
  });

  it('starts the workspace unprivileged (--cap-drop=ALL, no --cap-add) and runs a distinct metadata-block sidecar', async () => {
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);

    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    expect(startCmd).toBeDefined();
    expect(startCmd).toContain('--cap-drop=ALL');
    expect(startCmd).not.toContain('--cap-add');

    const metadataCmd = commands.find((c) => c.includes('--network container:'));
    expect(metadataCmd).toBeDefined();
    expect(metadataCmd).toContain('--cap-add=NET_ADMIN');
    expect(metadataCmd).not.toContain('--cap-drop=ALL');
    expect(metadataCmd).not.toBe(startCmd);

    // Both commands must reference the same container name — the sidecar
    // joins *this* workspace's netns, not some other container's.
    const nameMatch = startCmd?.match(/--name (\S+)/);
    expect(nameMatch?.[1]).toBeDefined();
    expect(metadataCmd).toContain(`--network container:${nameMatch?.[1]}`);

    await ws.destroy();
  });

  it('applies the resolved workspace caps + default image from workflow defaults', async () => {
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({
      workspaceCpus: 6,
      workspaceImage: 'custom/base:1.2',
      workspaceMemory: '9g',
      workspacePidsLimit: 999,
    } as never);

    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);

    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    // The memory string is shell-quoted (defense-in-depth); numeric caps are not.
    expect(startCmd).toContain(`--memory=${shellQuote('9g')}`);
    expect(startCmd).toContain('--cpus=6');
    expect(startCmd).toContain('--pids-limit=999');
    // No explicit image passed → the resolved config image is used.
    expect(startCmd).toContain(shellQuote('custom/base:1.2'));

    await ws.destroy();
  });

  it('honours an explicit image argument over the resolved default image', async () => {
    const ws = await createWorkspace(
      'https://github.com/acme/repo.git',
      'auto/TICKET-1',
      'main',
      'ghcr.io/acme/executor:9'
    );
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    expect(startCmd).toContain(shellQuote('ghcr.io/acme/executor:9'));
    expect(startCmd).not.toContain(shellQuote('node:24-alpine'));

    await ws.destroy();
  });

  it('is best-effort: a failed metadata-block sidecar does not fail workspace creation', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('--network container:')) {
        throw new Error('sidecar boom');
      }
      return '';
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');

    expect(ws.containerId).toMatch(/^workspace-/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('metadata-IP egress block failed')
    );

    warnSpy.mockRestore();
    await ws.destroy();
  });
});
