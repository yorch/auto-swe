import crypto from 'node:crypto';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { workspaceBackend } from '../lib/workspaceBackend/index.js';
import { agentWorkspaceSpec } from '../lib/workspaceBackend/spec.js';

/**
 * One line of the probe's report, emitted inside the container.
 */
export interface ImageProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed required check fails the image; optional and informational ones do not. */
  required: boolean;
}

export interface ExecutorImageProbeResult {
  image: string;
  /** True when every required check passed. */
  ok: boolean;
  checks: ImageProbeCheck[];
}

/**
 * `sh` script run inside the candidate container that reports whether the
 * image meets the executor image contract (docs/repositories.md): a `sh` (the
 * script running at all proves it), `git`, `tar`, a `/workspace` the exec user
 * can write, and a container still alive at the end — meaning `sleep infinity`
 * kept it up under `--init`. `rg` is reported optional: Pi's grep honours
 * `.gitignore` only through ripgrep, so its absence degrades rather than
 * breaks. The exec user is informational.
 *
 * Each line is `ASW|<name>|<ok|fail>|<detail>`; the script always exits 0 so a
 * partial environment reports everything it can rather than stopping early.
 */
export const IMAGE_CONTRACT_PROBE_SCRIPT = [
  'asw_emit() { printf \'ASW|%s|%s|%s\\n\' "$1" "$2" "$3"; }',
  'asw_emit sh ok "the probe is running under sh"',
  'if command -v git >/dev/null 2>&1; then',
  '  asw_emit git ok "$(git --version 2>/dev/null | head -1)"',
  'elif command -v apk >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then',
  '  asw_emit git fail "git is missing; the workspace can install it via apk/apt-get, but the image should ship it"',
  'else',
  '  asw_emit git fail "git is missing and neither apk nor apt-get can install it"',
  'fi',
  'if command -v tar >/dev/null 2>&1; then',
  '  asw_emit tar ok "$(tar --version 2>/dev/null | head -1 || echo tar)"',
  'else',
  '  asw_emit tar fail "tar is missing; the workspace copies files in and out through it"',
  'fi',
  'if command -v rg >/dev/null 2>&1; then',
  '  asw_emit rg ok "$(rg --version 2>/dev/null | head -1)"',
  'else',
  '  asw_emit rg fail "ripgrep is missing; grep tools will not honour .gitignore"',
  'fi',
  'asw_emit exec-user ok "$(id -un 2>/dev/null || echo unknown) (uid $(id -u 2>/dev/null || echo unknown))"',
  'if [ ! -d /workspace ]; then mkdir -p /workspace 2>/dev/null || true; fi',
  'if [ -d /workspace ] && touch /workspace/.asw-probe-write 2>/dev/null; then',
  '  rm -f /workspace/.asw-probe-write',
  '  asw_emit workspace ok "/workspace exists and is writable by the exec user"',
  'else',
  '  asw_emit workspace fail "/workspace does not exist, cannot be created, or is not writable by the exec user"',
  'fi',
].join('\n');

/** Which checks an executor image must pass; anything else is advisory. */
const REQUIRED_CHECKS = new Set(['sh', 'git', 'tar', 'workspace']);

const LINE_RE = /^ASW\|([^|]*)\|(ok|fail)\|(.*)$/;

/**
 * Parse the probe script's stdout into checks. A required check the script
 * never reported (it died early, or a mangled line) is synthesized as failed —
 * silence is not a pass.
 */
export function parseImageProbeOutput(stdout: string): { ok: boolean; checks: ImageProbeCheck[] } {
  const checks: ImageProbeCheck[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = LINE_RE.exec(line.trim());
    if (!m) {
      continue;
    }
    const name = m[1] ?? '';
    seen.add(name);
    checks.push({
      detail: m[3] ?? '',
      name,
      ok: m[2] === 'ok',
      required: REQUIRED_CHECKS.has(name),
    });
  }
  for (const name of REQUIRED_CHECKS) {
    if (!seen.has(name)) {
      checks.push({
        detail: 'the probe did not report this check',
        name,
        ok: false,
        required: true,
      });
    }
  }
  return { checks, ok: checks.every((c) => c.ok || !c.required) };
}

export interface ProbeExecutorImageInput {
  /**
   * Image ref to probe; defaults to the image a repository with `detectedStack` would run on
   * (the deployer's image for its stack), else the resolved workspace image.
   */
  image?: string;
  /** The repository's stored detection, used only when no `image` is named. */
  detectedStack?: unknown;
}

/**
 * Start a hardened container on the candidate image — the same spec and
 * hardening `createWorkspace` uses, so the probe answers "would a workspace
 * start here", not just "does the image exist" — run the contract probe in it,
 * and always remove it.
 *
 * Never throws for an image problem: a pull/start failure or a missing tool
 * comes back as `ok: false` checks. Throws only for a malformed `image`.
 */
export async function probeExecutorImage(
  input: ProbeExecutorImageInput
): Promise<ExecutorImageProbeResult> {
  const image =
    input.image ??
    executorImageFor({ detectedStack: input.detectedStack }) ??
    resolveWorkspaceInfra().image;
  if (!DOCKER_IMAGE_REF_RE.test(image)) {
    throw new Error(`Invalid Docker image name: ${image}`);
  }

  const backend = workspaceBackend();
  const name = `image-probe-${crypto.randomBytes(8).toString('hex')}`;
  try {
    const handle = await backend.create(agentWorkspaceSpec(name, image));
    const probe = await backend.exec(handle, ['sh', '-c', IMAGE_CONTRACT_PROBE_SCRIPT], {
      heartbeatLabel: 'image probe: checking the executor contract',
      timeoutMs: 60_000,
    });
    if (probe.exitCode !== 0) {
      return {
        checks: [
          {
            detail: `the probe exited ${probe.exitCode}: ${probe.stderr.trim() || 'no output'}`,
            name: 'sh',
            ok: false,
            required: true,
          },
        ],
        image,
        ok: false,
      };
    }
    // The keeper check is a real exec against the recorded keeper PID — the
    // script cannot assert its own container's keeper is alive, so this asks.
    const keeperAlive = await backend.exec(handle, ['sh', '-c', `kill -0 ${handle.keeperPid}`], {
      heartbeatLabel: 'image probe: checking the keeper',
      timeoutMs: 10_000,
    });
    const parsed = parseImageProbeOutput(probe.stdout);
    parsed.checks.push({
      detail:
        keeperAlive.exitCode === 0
          ? 'the keeper process is still running after the checks (sleep infinity under --init)'
          : `the keeper process is gone (kill -0 ${handle.keeperPid} exited ${keeperAlive.exitCode})`,
      name: 'keeper',
      ok: keeperAlive.exitCode === 0,
      required: true,
    });
    return { checks: parsed.checks, image, ok: parsed.ok && keeperAlive.exitCode === 0 };
  } catch (err) {
    return {
      checks: [
        {
          detail: `the image could not be pulled or started as a workspace container: ${
            err instanceof Error ? err.message : String(err)
          }`,
          name: 'container-start',
          ok: false,
          required: true,
        },
      ],
      image,
      ok: false,
    };
  } finally {
    await backend.remove(name);
  }
}
