import { promises as fs } from 'node:fs';
import path from 'node:path';
import { signBundle, validateBundle } from '@auto-swe/sdk';
import { parseFlags } from './workflows.js';

/**
 * `auto-swe bundle` — token-free local authoring loop over `@auto-swe/sdk`:
 * scaffold a bundle project, validate a manifest (schema + content hash), and
 * attach an ed25519 signature. Distinct from `bundles` (plural), which performs
 * gateway-backed install/export and needs an admin token.
 */
const SUB_HELP = `auto-swe bundle — author bundles locally (no token needed)

  bundle init [dir] [--name=NAME] [--version=V]
                                   Scaffold a bundle authoring project
  bundle validate <path>           Validate a manifest (schema + content hash)
  bundle sign <path> --key=<pem-path> [--signed-by=ID] [-o <path>]
                                   Attach a detached ed25519 signature
`;

export async function runBundleCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  try {
    if (sub === 'init') {
      return await cmdInit(rest);
    }
    if (sub === 'validate') {
      return await cmdValidate(rest);
    }
    if (sub === 'sign') {
      return await cmdSign(rest);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write(`Unknown subcommand: bundle ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdValidate(args: string[]): Promise<number> {
  const { positional } = parseFlags(args);
  const file = positional[0];
  if (!file) {
    process.stderr.write('Usage: bundle validate <path>\n');
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `${file}: cannot read/parse — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
  const result = validateBundle(raw);
  if (!result.ok) {
    process.stderr.write(`INVALID:\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }
  const e = result.bundle.entities;
  process.stdout.write(
    `OK: "${result.bundle.metadata.name}" v${result.bundle.metadata.version} — ` +
      `${e.agents.length} agents, ${e.skills.length} skills, ` +
      `${e.scannerPatterns.length} scanner patterns, ${e.templates.length} templates` +
      `${result.bundle.metadata.signature ? ' (signed)' : ''}\n`
  );
  return 0;
}

async function cmdSign(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const file = positional[0];
  const keyPath = flags.key;
  if (!file || !keyPath || keyPath === 'true') {
    process.stderr.write(
      'Usage: bundle sign <path> --key=<pem-path> [--signed-by=ID] [-o <path>]\n'
    );
    return 1;
  }
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  // Re-validate before signing so we never sign a tampered/hash-mismatched manifest.
  const result = validateBundle(raw);
  if (!result.ok) {
    process.stderr.write(`refusing to sign an invalid bundle:\n${result.errors.join('\n')}\n`);
    return 1;
  }
  const privateKeyPem = await fs.readFile(keyPath, 'utf8');
  const signedBy =
    flags['signed-by'] && flags['signed-by'] !== 'true' ? flags['signed-by'] : undefined;
  const signed = signBundle(result.bundle, privateKeyPem, signedBy);
  const payload = `${JSON.stringify(signed, null, 2)}\n`;
  const out = flags.o ?? flags.output;
  if (out && out !== 'true') {
    await fs.writeFile(out, payload);
    process.stderr.write(`Signed → ${out}\n`);
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

async function cmdInit(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const dir = positional[0] ?? '.';
  const name = flags.name && flags.name !== 'true' ? flags.name : path.basename(path.resolve(dir));
  const version = flags.version && flags.version !== 'true' ? flags.version : '0.1.0';

  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await writeIfAbsent(path.join(dir, 'package.json'), scaffoldPackageJson(name));
  await writeIfAbsent(path.join(dir, 'tsconfig.json'), SCAFFOLD_TSCONFIG);
  await writeIfAbsent(path.join(dir, 'src', 'bundle.ts'), scaffoldBundleTs(name, version));
  await writeIfAbsent(path.join(dir, 'README.md'), scaffoldReadme(name));
  process.stdout.write(
    `Scaffolded bundle "${name}" in ${dir}/\n` +
      '  next: edit src/bundle.ts, then `tsx src/bundle.ts > my.bundle.json`\n' +
      '  validate: `auto-swe bundle validate my.bundle.json`\n'
  );
  return 0;
}

/** Write a file only if it doesn't already exist (never clobber author work). */
async function writeIfAbsent(file: string, contents: string): Promise<void> {
  try {
    await fs.writeFile(file, contents, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      process.stderr.write(`skip (exists): ${file}\n`);
      return;
    }
    throw err;
  }
}

function scaffoldPackageJson(name: string): string {
  return `${JSON.stringify(
    {
      dependencies: { '@auto-swe/sdk': '*' },
      devDependencies: { tsx: '*', typescript: '*' },
      name: `bundle-${name}`,
      private: true,
      scripts: { build: 'tsx src/bundle.ts > bundle.json' },
      type: 'module',
      version: '0.0.0',
    },
    null,
    2
  )}\n`;
}

const SCAFFOLD_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      lib: ['ES2022'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      target: 'ES2022',
      types: ['node'],
    },
    include: ['src/**/*'],
  },
  null,
  2
)}\n`;

function scaffoldBundleTs(name: string, version: string): string {
  return `import { defineAgent, defineBundle, defineSkill } from '@auto-swe/sdk';

// Author your library content here, then assemble + print the manifest.
// Run: tsx src/bundle.ts > bundle.json   (then: auto-swe bundle validate bundle.json)

const reviewer = defineAgent({
  key: 'reviewer',
  name: 'Reviewer',
  description: 'Reviews proposed changes.',
  modelSpec: 'anthropic/claude-opus-4-8',
  toolKeys: ['readFile', 'bash'],
});

const carefulReview = defineSkill({
  name: 'careful-review',
  promptText: 'Read the diff twice. Flag anything that changes behavior silently.',
});

const bundle = defineBundle({
  name: '${name}',
  version: '${version}',
  description: 'A starter bundle.',
  agents: [reviewer],
  skills: [carefulReview],
});

process.stdout.write(\`\${JSON.stringify(bundle, null, 2)}\\n\`);
`;
}

function scaffoldReadme(name: string): string {
  return `# bundle-${name}

An auto-swe distribution bundle authored with [\`@auto-swe/sdk\`](https://code.claude.com/docs).

## Author

\`\`\`bash
yarn install
tsx src/bundle.ts > bundle.json     # assemble the manifest
auto-swe bundle validate bundle.json
\`\`\`

## Sign (optional)

A bundle installs as \`UNVERIFIED\` unless the installing deployment trusts the
signing key (\`BUNDLE_TRUSTED_KEYS\`):

\`\`\`bash
auto-swe bundle sign bundle.json --key=ed25519-private.pem --signed-by=acme -o bundle.signed.json
\`\`\`

## Install

\`\`\`bash
export AUTO_SWE_TOKEN=...   # admin personal access token
auto-swe bundles install bundle.signed.json
\`\`\`
`;
}
