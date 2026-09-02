import { promises as fs } from 'node:fs';
import type { BundleManifest } from '@auto-swe/shared/bundle';
import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { parseFlags } from '../lib/flags.js';
import { pad } from '../lib/format.js';

/**
 * `auto-swe bundles` — gateway-backed bundle distribution (admin token required).
 * Authoring of bundles (init/validate/sign) lives in the token-free `bundle`
 * command; this one talks to `/api/v1/platform/bundles`.
 */
const SUB_HELP = `auto-swe bundles — distribute library bundles (admin)

  bundles list                              List installed bundles
  bundles export <name> <version> [--origin=TAG] [-o <path>]
                                            Export GLOBAL content to a bundle file (or stdout)
  bundles install <path>                    Install a bundle from a local file
  bundles install-from-url <url>            Fetch + install a bundle from an http(s) URL
`;

interface InstalledBundleRow {
  name: string;
  version: string;
  source: string | null;
  trustState: string;
  signedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InstallResult {
  counts: { agents: number; skills: number; scannerPatterns: number; templates: number };
  trustState: 'VERIFIED' | 'UNVERIFIED';
  signedBy: string | null;
  warnings: string[];
}

export async function runBundlesCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'list') {
      return await cmdList(env);
    }
    if (sub === 'export') {
      return await cmdExport(rest, env);
    }
    if (sub === 'install') {
      return await cmdInstall(rest, env);
    }
    if (sub === 'install-from-url') {
      return await cmdInstallFromUrl(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: bundles ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdList(env: CliEnv): Promise<number> {
  const rows = await apiRequest<InstalledBundleRow[]>(env, 'GET', '/api/v1/platform/bundles');
  if (rows.length === 0) {
    process.stdout.write('No bundles installed.\n');
    return 0;
  }
  process.stdout.write(
    `${pad('NAME', 28) + pad('VERSION', 12) + pad('TRUST', 12) + pad('SIGNED BY', 18)}SOURCE\n`
  );
  for (const r of rows) {
    process.stdout.write(
      pad(r.name, 28) +
        pad(r.version, 12) +
        pad(r.trustState, 12) +
        pad(r.signedBy ?? '-', 18) +
        `${r.source ?? '-'}\n`
    );
  }
  return 0;
}

async function cmdExport(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const [name, version] = positional;
  if (!name || !version) {
    process.stderr.write('Usage: bundles export <name> <version> [--origin=TAG] [-o <path>]\n');
    return 1;
  }
  const rawOutput = flags.o ?? flags.output;
  if (rawOutput === 'true') {
    process.stderr.write('-o/--output requires a file path\n');
    return 1;
  }
  const manifest = await apiRequest<BundleManifest>(
    env,
    'POST',
    '/api/v1/platform/bundles/export',
    {
      name,
      ...(flags.origin && flags.origin !== 'true' ? { origin: flags.origin } : {}),
      version,
    }
  );
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  if (rawOutput) {
    await fs.writeFile(rawOutput, payload);
    process.stderr.write(`Wrote bundle "${name}" v${version} → ${rawOutput}\n`);
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

async function cmdInstall(args: string[], env: CliEnv): Promise<number> {
  const { positional } = parseFlags(args);
  const path = positional[0];
  if (!path) {
    process.stderr.write('Usage: bundles install <path>\n');
    return 1;
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `${path}: cannot read/parse — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
  const result = await apiRequest<InstallResult>(env, 'POST', '/api/v1/platform/bundles/install', {
    bundle,
  });
  printInstall(result);
  return 0;
}

async function cmdInstallFromUrl(args: string[], env: CliEnv): Promise<number> {
  const { positional } = parseFlags(args);
  const url = positional[0];
  if (!url) {
    process.stderr.write('Usage: bundles install-from-url <url>\n');
    return 1;
  }
  const result = await apiRequest<InstallResult>(
    env,
    'POST',
    '/api/v1/platform/bundles/install-from-url',
    { url }
  );
  printInstall(result);
  return 0;
}

function printInstall(r: InstallResult): void {
  const { agents, skills, scannerPatterns, templates } = r.counts;
  process.stdout.write(
    `Installed [${r.trustState}${r.signedBy ? ` by ${r.signedBy}` : ''}]: ` +
      `${agents} agents, ${skills} skills, ${scannerPatterns} scanner patterns, ${templates} templates\n`
  );
  for (const w of r.warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }
}
