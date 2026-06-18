import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineBundle } from '@auto-swe/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBundleCommand } from './bundle.js';

describe('runBundleCommand (local authoring)', () => {
  let stderrWrites: string[];
  let stdoutWrites: string[];
  let originalErr: typeof process.stderr.write;
  let originalOut: typeof process.stdout.write;
  let dir: string;

  beforeEach(async () => {
    stderrWrites = [];
    stdoutWrites = [];
    originalErr = process.stderr.write;
    originalOut = process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    dir = await fs.mkdtemp(path.join(tmpdir(), 'bundle-cli-'));
  });

  afterEach(async () => {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('validate accepts a well-formed manifest', async () => {
    const file = path.join(dir, 'b.json');
    const bundle = defineBundle({
      name: 'demo',
      skills: [{ name: 's', promptText: 'p' }],
      version: '1.0.0',
    });
    await fs.writeFile(file, JSON.stringify(bundle));
    const code = await runBundleCommand(['validate', file]);
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('OK: "demo" v1.0.0');
  });

  it('validate rejects a content-hash mismatch with exit 1', async () => {
    const file = path.join(dir, 'b.json');
    const bundle = defineBundle({ name: 'demo', version: '1.0.0' });
    bundle.metadata.contentHash = 'tampered';
    await fs.writeFile(file, JSON.stringify(bundle));
    const code = await runBundleCommand(['validate', file]);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('content hash mismatch');
  });

  it('sign attaches a signature and the result still validates', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = path.join(dir, 'key.pem');
    await fs.writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    const file = path.join(dir, 'b.json');
    const out = path.join(dir, 'signed.json');
    await fs.writeFile(file, JSON.stringify(defineBundle({ name: 'demo', version: '1.0.0' })));

    const signCode = await runBundleCommand([
      'sign',
      file,
      `--key=${keyPath}`,
      '--signed-by=acme',
      '-o',
      out,
    ]);
    expect(signCode).toBe(0);
    const signed = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(signed.metadata.signature).toBeTruthy();
    expect(signed.metadata.signedBy).toBe('acme');

    const validateCode = await runBundleCommand(['validate', out]);
    expect(validateCode).toBe(0);
  });

  it('init scaffolds a project and refuses to clobber existing files', async () => {
    const code = await runBundleCommand(['init', dir, '--name=acme', '--version=2.0.0']);
    expect(code).toBe(0);
    const src = await fs.readFile(path.join(dir, 'src', 'bundle.ts'), 'utf8');
    expect(src).toContain("name: 'acme'");
    expect(src).toContain("version: '2.0.0'");
    // Second init must not overwrite the author's bundle.ts.
    await fs.writeFile(path.join(dir, 'src', 'bundle.ts'), '// mine');
    await runBundleCommand(['init', dir]);
    expect(await fs.readFile(path.join(dir, 'src', 'bundle.ts'), 'utf8')).toBe('// mine');
  });
});
