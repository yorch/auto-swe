import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePrPolicy } from '@auto-swe/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSensitiveDirs, policyTemplate, runPrPolicyCommand } from './prPolicy.js';

const ENV = { apiUrl: 'http://gw', token: 't' };
const loadEnv = async () => ENV;
const REPO_ID = '7d3f1c2a-1111-4222-8333-944455556666';
const POLICY = path.join('.auto-swe', 'pr-policy.yml');

describe('pr-policy', () => {
  let out: string[];
  let err: string[];
  let calls: Array<{ method: string; url: string; body: unknown }>;
  let dir: string;
  const originals = {
    cwd: process.cwd(),
    err: process.stderr.write,
    fetch: globalThis.fetch,
    out: process.stdout.write,
  };

  beforeEach(async () => {
    out = [];
    err = [];
    calls = [];
    dir = await fs.mkdtemp(path.join(tmpdir(), 'pr-policy-'));
    process.stdout.write = ((s: string) => {
      out.push(s);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => {
      err.push(s);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
    globalThis.fetch = originals.fetch;
    process.chdir(originals.cwd);
    await fs.rm(dir, { force: true, recursive: true });
  });

  function respond(status: number, body: unknown) {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method ?? 'GET',
        url,
      });
      return {
        ok: status < 300,
        status,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  async function touch(rel: string): Promise<void> {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), 'x');
  }

  describe('help and dispatch', () => {
    it('prints help with no subcommand and exits 0', async () => {
      expect(await runPrPolicyCommand([], loadEnv)).toBe(0);
      expect(out.join('')).toMatch(/pr-policy init/);
      expect(out.join('')).toMatch(/pr-policy mode/);
    });

    it('rejects an unknown subcommand with exit 1', async () => {
      expect(await runPrPolicyCommand(['nope'], loadEnv)).toBe(1);
      expect(err.join('')).toMatch(/Unknown subcommand: pr-policy nope/);
    });
  });

  describe('init', () => {
    it('writes a template with only the sensitive directories that exist, sorted and de-duplicated', async () => {
      await touch('db/migrations/0001.sql');
      await touch('services/auth/index.ts');
      await touch('infra/main.tf');
      await touch('node_modules/payments/x.js');
      await touch('a/b/c/d/billing/deep.ts');
      process.chdir(dir);

      expect(await runPrPolicyCommand(['init'], loadEnv)).toBe(0);
      const text = await fs.readFile(path.join(dir, POLICY), 'utf8');
      expect(text).toContain("  - '**/auth/**'");
      expect(text).toContain("  - '**/infra/**'");
      expect(text).toContain("  - '**/migrations/**'");
      expect(text).not.toContain('payments');
      expect(text).not.toContain('billing');
      const globs = text.match(/^ {2}- '(.+)'$/gm) ?? [];
      expect(globs).toEqual([...globs].sort());
      expect(new Set(globs).size).toBe(globs.length);
    });

    it('writes an empty sensitivePaths when nothing is detected', async () => {
      expect(await runPrPolicyCommand(['init', '--dir', dir], loadEnv)).toBe(0);
      const text = await fs.readFile(path.join(dir, POLICY), 'utf8');
      expect(text).toContain('sensitivePaths: []');
    });

    it('refuses to overwrite without --force and overwrites with it', async () => {
      await fs.mkdir(path.join(dir, '.auto-swe'));
      await fs.writeFile(path.join(dir, POLICY), 'version: 1\nmaxLowLines: 50\n');

      expect(await runPrPolicyCommand(['init', '--dir', dir], loadEnv)).toBe(1);
      expect(err.join('')).toMatch(/already exists; pass --force/);
      expect(await fs.readFile(path.join(dir, POLICY), 'utf8')).toContain('maxLowLines: 50');

      expect(await runPrPolicyCommand(['init', '--dir', dir, '--force'], loadEnv)).toBe(0);
      expect(await fs.readFile(path.join(dir, POLICY), 'utf8')).not.toContain('maxLowLines: 50');
    });

    it('refuses a --dir with no value and an unknown flag', async () => {
      expect(await runPrPolicyCommand(['init', '--dir'], loadEnv)).toBe(1);
      expect(await runPrPolicyCommand(['init', '--dir', dir, '--bogus'], loadEnv)).toBe(1);
    });

    it('generates a file that passes validate with no errors or warnings', async () => {
      await touch('migrations/0001.sql');
      await touch('charts/app/Chart.yaml');
      await runPrPolicyCommand(['init', '--dir', dir], loadEnv);
      const text = await fs.readFile(path.join(dir, POLICY), 'utf8');
      const result = validatePrPolicy(text);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(await runPrPolicyCommand(['validate', path.join(dir, POLICY)], loadEnv)).toBe(0);
    });

    it('detects directories down to depth three and not beyond', async () => {
      await touch('one/two/auth/x.ts');
      await touch('one/two/three/four/terraform/x.tf');
      expect(await detectSensitiveDirs(dir)).toEqual(['**/auth/**']);
    });

    it('keeps the commented examples on the stricter-only fields', () => {
      const text = policyTemplate([]);
      expect(text).toMatch(/cannot lower an approver count/);
      expect(text).toContain('# maxLowLines: 200');
      expect(text).toContain('# highApprovers: 2');
      expect(text).not.toContain('ignoredFromSkim');
    });
  });

  describe('validate', () => {
    async function writePolicy(text: string): Promise<string> {
      const file = path.join(dir, 'pr-policy.yml');
      await fs.writeFile(file, text);
      return file;
    }

    it('exits 0 and says OK for a valid file', async () => {
      const file = await writePolicy('version: 1\nmaxLowLines: 100\n');
      expect(await runPrPolicyCommand(['validate', file], loadEnv)).toBe(0);
      expect(out.join('')).toMatch(/^OK: /);
    });

    it('exits 1 and lists the errors for an invalid file', async () => {
      const file = await writePolicy('version: 2\n');
      expect(await runPrPolicyCommand(['validate', file], loadEnv)).toBe(1);
      expect(err.join('')).toMatch(/INVALID/);
      expect(err.join('')).toMatch(/version/);
    });

    it('exits 0 but prints each relaxation as a warning', async () => {
      const file = await writePolicy('version: 1\nmode: auto\n');
      expect(await runPrPolicyCommand(['validate', file], loadEnv)).toBe(0);
      expect(err.join('')).toMatch(/warning: mode:/);
      expect(out.join('')).toMatch(/1 warning\)/);
    });

    it('refuses a file over the size limit before reading it', async () => {
      const file = await writePolicy(`version: 1\n# ${'x'.repeat(65 * 1024)}\n`);
      expect(await runPrPolicyCommand(['validate', file], loadEnv)).toBe(1);
      expect(err.join('')).toMatch(/at most 64 KiB/);
    });

    it('defaults to .auto-swe/pr-policy.yml in the current directory', async () => {
      await fs.mkdir(path.join(dir, '.auto-swe'));
      await fs.writeFile(path.join(dir, POLICY), 'version: 1\n');
      process.chdir(dir);
      expect(await runPrPolicyCommand(['validate'], loadEnv)).toBe(0);
    });

    it('exits 1 when the file is missing', async () => {
      expect(await runPrPolicyCommand(['validate', path.join(dir, 'missing.yml')], loadEnv)).toBe(
        1
      );
      expect(err.join('')).toMatch(/cannot read/);
    });
  });

  describe('status', () => {
    const STATUS = {
      autoMergeAllowed: false,
      enabled: true,
      evidence: { badMerges: 1, lowMerged: 3, minEvidence: 5, satisfied: false, windowDays: 90 },
      lastEvaluation: {
        createdAt: '2026-10-28T10:00:00.000Z',
        prNumber: 42,
        requiredApprovers: 2,
        riskClass: 'HIGH',
        statusState: 'success',
      },
      mode: 'advisory',
      modeSource: 'repository',
    };

    it('prints mode, enablement, the last evaluation and the evidence', async () => {
      respond(200, { data: STATUS });
      expect(await runPrPolicyCommand(['status', REPO_ID], loadEnv)).toBe(0);
      const text = out.join('');
      expect(calls[0]?.url).toBe(`http://gw/api/v1/repositories/${REPO_ID}/pr-evaluation`);
      expect(calls[0]?.method).toBe('GET');
      expect(text).toMatch(/Enabled:\s+yes/);
      expect(text).toMatch(/Mode:\s+advisory \(set on this repository\)/);
      expect(text).toMatch(/PR #42 — class HIGH, 2 approver\(s\) required, status success/);
      expect(text).toMatch(
        /3 low-risk merge\(s\) in 90 days \(minimum 5\), 1 marked bad, auto not satisfied/
      );
    });

    it('says none when the repository has no evaluation yet', async () => {
      respond(200, { data: { ...STATUS, enabled: false, lastEvaluation: null } });
      expect(await runPrPolicyCommand(['status', REPO_ID], loadEnv)).toBe(0);
      expect(out.join('')).toMatch(/Last evaluation:\s+none/);
      expect(out.join('')).toMatch(/Enabled:\s+no/);
    });

    it('exits 2 with the gateway error for a repository it cannot reach', async () => {
      respond(404, { error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' } });
      expect(await runPrPolicyCommand(['status', REPO_ID], loadEnv)).toBe(2);
      expect(err.join('')).toMatch(/REPO_NOT_FOUND/);
    });

    it('requires a repository id', async () => {
      expect(await runPrPolicyCommand(['status'], loadEnv)).toBe(1);
      expect(calls).toEqual([]);
    });
  });

  describe('mode', () => {
    it('sends the chosen mode', async () => {
      respond(200, { data: { mode: 'advisory', modeSource: 'repository' } });
      expect(await runPrPolicyCommand(['mode', REPO_ID, 'advisory'], loadEnv)).toBe(0);
      expect(calls[0]?.method).toBe('PUT');
      expect(calls[0]?.url).toBe(`http://gw/api/v1/repositories/${REPO_ID}/pr-evaluation`);
      expect(calls[0]?.body).toEqual({ mode: 'advisory' });
      expect(out.join('')).toMatch(/Mode for .*: advisory/);
    });

    it('sends null for inherit', async () => {
      respond(200, { data: { mode: null, modeSource: 'default' } });
      expect(await runPrPolicyCommand(['mode', REPO_ID, 'inherit'], loadEnv)).toBe(0);
      expect(calls[0]?.body).toEqual({ mode: null });
      expect(out.join('')).toMatch(/deployment default/);
    });

    it('prints each refusal reason on its own line and exits 1 for AUTO_NOT_READY', async () => {
      const reasons = [
        'Only a platform admin may set auto mode.',
        'Auto-merge is not allowed on this deployment (prEvaluation.autoMergeAllowed).',
      ];
      respond(400, {
        error: {
          code: 'AUTO_NOT_READY',
          details: { reasons },
          message: 'Auto mode is not ready for this repository',
        },
      });
      expect(await runPrPolicyCommand(['mode', REPO_ID, 'auto'], loadEnv)).toBe(1);
      const lines = err.join('').split('\n');
      for (const reason of reasons) {
        expect(lines).toContain(reason);
      }
    });

    it('exits 2 for other gateway errors', async () => {
      respond(403, { error: { code: 'FORBIDDEN', message: 'Requires LEAD role' } });
      expect(await runPrPolicyCommand(['mode', REPO_ID, 'off'], loadEnv)).toBe(2);
      expect(err.join('')).toMatch(/FORBIDDEN/);
    });

    it('refuses an unknown mode without calling the gateway', async () => {
      respond(200, { data: {} });
      expect(await runPrPolicyCommand(['mode', REPO_ID, 'always'], loadEnv)).toBe(1);
      expect(err.join('')).toMatch(/mode must be one of/);
      expect(calls).toEqual([]);
    });

    it('requires both a repository id and a mode', async () => {
      expect(await runPrPolicyCommand(['mode', REPO_ID], loadEnv)).toBe(1);
      expect(calls).toEqual([]);
    });
  });
});
