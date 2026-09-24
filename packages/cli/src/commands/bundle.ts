import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signBundle, validateBundle } from '@auto-swe/sdk';
import { parseFlags } from '../lib/flags.js';

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

  const sdkDir = locateSdk();
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await writeIfAbsent(path.join(dir, 'package.json'), scaffoldPackageJson(name, sdkDir));
  await writeIfAbsent(path.join(dir, 'tsconfig.json'), SCAFFOLD_TSCONFIG);
  await writeIfAbsent(path.join(dir, 'src', 'bundle.ts'), scaffoldBundleTs(name, version));
  await writeIfAbsent(path.join(dir, 'README.md'), scaffoldReadme(name));
  process.stdout.write(
    `Scaffolded bundle "${name}" in ${dir}/\n` +
      '  next: edit src/bundle.ts, then `tsx src/bundle.ts > my.bundle.json`\n' +
      '  validate: `auto-swe bundle validate my.bundle.json`\n'
  );
  if (!sdkDir) {
    process.stderr.write(
      'note: @auto-swe/sdk is not published to a registry and no auto-swe checkout was found\n' +
        '  next to this CLI, so package.json does not depend on it yet. Add it from a checkout:\n' +
        '    "@auto-swe/sdk": "link:<auto-swe checkout>/packages/sdk"\n'
    );
  }
  return 0;
}

/**
 * The `packages/sdk` directory of the auto-swe checkout this CLI runs from, or
 * null when the CLI is not running from one. The SDK is a private workspace
 * package that is never published, so a scaffold that named it by version
 * (`"*"`) would fail to install — or worse, resolve to whatever a stranger
 * published under that name. A `link:` to the checkout is the only source
 * that is certainly this SDK.
 */
export function locateSdk(): string | null {
  // src/commands/bundle.ts and dist/commands/bundle.js both sit three levels
  // below packages/.
  const candidate = fileURLToPath(new URL('../../../sdk/', import.meta.url));
  const manifest = path.join(candidate, 'package.json');
  if (!existsSync(manifest)) {
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    return pkg.name === '@auto-swe/sdk' ? path.resolve(candidate) : null;
  } catch {
    return null;
  }
}

/**
 * An agent key the starter bundle can install without colliding with a
 * built-in. Keys allow letters, digits, dot, dash and underscore; the bundle
 * name becomes the namespace.
 */
export function starterAgentKey(bundleName: string): string {
  const ns = bundleName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'bundle';
  return `${ns}.reviewer`;
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

function scaffoldPackageJson(name: string, sdkDir: string | null): string {
  return `${JSON.stringify(
    {
      dependencies: sdkDir ? { '@auto-swe/sdk': `link:${sdkDir}` } : {},
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

// Namespaced key: a bundle agent keyed like a built-in (\`reviewer\`,
// \`implementer\`, …) would replace the platform's own agent on install, so the
// gateway refuses that without --overwrite-protected.
const reviewer = defineAgent({
  key: '${starterAgentKey(name)}',
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

An auto-swe distribution bundle authored with [\`@auto-swe/sdk\`](https://github.com/yorch/auto-swe/blob/main/docs/bundles.md).

## Author

\`@auto-swe/sdk\` is not published to a registry. \`package.json\` links it from
an auto-swe checkout (\`link:<checkout>/packages/sdk\`), so build that checkout
once (\`yarn install && yarn build\` there) and install with Yarn or pnpm, which
understand the \`link:\` protocol.

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
