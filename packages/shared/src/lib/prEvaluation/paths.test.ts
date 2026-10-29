import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SENSITIVE_PATHS,
  globMatches,
  isTestFile,
  isValidGlob,
  matchesAny,
  TEST_SKIP_PATTERN,
} from './paths.js';

describe('globMatches', () => {
  it('lets a leading **/ match zero directories', () => {
    expect(globMatches('**/migrations/**', 'migrations/001.sql')).toBe(true);
    expect(globMatches('**/migrations/**', 'a/b/migrations/001.sql')).toBe(true);
    expect(globMatches('**/Dockerfile*', 'Dockerfile')).toBe(true);
    expect(globMatches('**/Dockerfile*', 'svc/Dockerfile.prod')).toBe(true);
  });

  it('keeps * inside one path segment', () => {
    expect(globMatches('docker-compose*.yml', 'docker-compose.prod.yml')).toBe(true);
    expect(globMatches('docker-compose*.yml', 'sub/docker-compose.yml')).toBe(false);
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
  });

  it('matches ? as one non-slash character', () => {
    expect(globMatches('a?c', 'abc')).toBe(true);
    expect(globMatches('a?c', 'a/c')).toBe(false);
  });

  it('expands braces', () => {
    expect(globMatches('**/openapi*.{yml,yaml,json}', 'api/openapi.v2.json')).toBe(true);
    expect(globMatches('**/openapi*.{yml,yaml,json}', 'api/openapi.v2.toml')).toBe(false);
  });

  it('is case-insensitive and anchored', () => {
    expect(globMatches('.github/**', '.GitHub/workflows/ci.yml')).toBe(true);
    expect(globMatches('package.json', 'x/package.json')).toBe(false);
    expect(globMatches('go.mod', 'go.mod.bak')).toBe(false);
  });

  it('treats a bad glob as matching nothing', () => {
    expect(globMatches('', 'a')).toBe(false);
    expect(globMatches('{a,b', 'a')).toBe(false);
    expect(globMatches('{a,{b,c}}', 'a')).toBe(false);
    expect(isValidGlob('x'.repeat(201))).toBe(false);
    expect(isValidGlob('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}')).toBe(false);
  });

  it('stays fast on a pathological pattern', () => {
    const start = Date.now();
    expect(globMatches('*a*a*a*a*a*a*a*a*b', 'a'.repeat(1000))).toBe(false);
    // A backtracking matcher would not finish; the bound only separates linear from hung, and is
    // loose so v8 coverage on a CI runner does not flake it.
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 60_000);

  it('never matches a path longer than the bound', () => {
    expect(globMatches('**', 'a'.repeat(2000))).toBe(false);
  });
});

describe('default lists', () => {
  it('flags the documented sensitive paths', () => {
    for (const path of [
      'packages/shared/src/prisma/schema.prisma',
      'src/auth/login.ts',
      '.github/workflows/ci.yml',
      'deploy/main.tf',
      'yarn.lock',
      'apps/web/package.json',
      'config/.env.local',
      '.auto-swe/pr-policy.yml',
      'CODEOWNERS',
      'vitest.config.ts',
      'src/userPermissions.ts',
    ]) {
      expect(matchesAny(path, DEFAULT_SENSITIVE_PATHS), path).toBe(true);
    }
    expect(matchesAny('src/components/Button.tsx', DEFAULT_SENSITIVE_PATHS)).toBe(false);
  });

  it('recognises test files and skip markers', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('tests/helpers.py')).toBe(true);
    expect(isTestFile('src/a.ts')).toBe(false);
    for (const line of ['it.skip(', 'describe.only(', 'xit(', '@pytest.mark.skip', 't.Skip(']) {
      expect(TEST_SKIP_PATTERN.test(line), line).toBe(true);
    }
  });
});

describe('paths hardening regressions', () => {
  it('flags every reviewer-named sensitive example (finding 10)', () => {
    for (const path of [
      'svc/requirements.txt',
      'svc/go.mod',
      'mod/pom.xml',
      'app/build.gradle.kts',
      'crates/x/Cargo.toml',
      'services/api/docker-compose.yml',
      'packages/x/pnpm-lock.yaml',
      'docs/CODEOWNERS',
      'docker-compose.yaml',
      'compose.yaml',
      'api.Dockerfile',
      'Containerfile',
      'db/migration/V1__x.sql',
      'pyproject.toml',
      'uv.lock',
      '.npmrc',
      '.yarnrc.yml',
      'eslint.config.js',
      'biome.jsonc',
      'playwright.config.ts',
      '.husky/pre-commit',
      'lefthook.yml',
      '.pre-commit-config.yaml',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/settings.json',
      'id_rsa',
      'a/b/id_ed25519.pub',
      'x/cert.p12',
      'Makefile',
      'sub/justfile',
      'db/schema.rb',
      'sub/.cursor/rules/a.mdc',
      '.cursorrules',
      '.github/copilot-instructions.md',
      '.gitattributes',
      'build.gradle',
      'x/uv.lock',
      'sub/yarn.lock',
    ]) {
      expect(matchesAny(path, DEFAULT_SENSITIVE_PATHS), path).toBe(true);
    }
  });

  it('has no duplicate sensitive globs (finding 10)', () => {
    expect(new Set(DEFAULT_SENSITIVE_PATHS).size).toBe(DEFAULT_SENSITIVE_PATHS.length);
  });

  it('recognises test files by common conventions (finding 3)', () => {
    for (const path of [
      'pkg/foo_test.go',
      'spec/models/user_spec.rb',
      'lib/x_spec.rb',
      'tests/test_a.py',
      'a/test_b.py',
      'a/conftest.py',
      'src/FooTest.java',
      'src/FooTests.java',
      'src/FooTest.kt',
      'src/FooTest.cs',
      'src/FooTests.cs',
      'a/testing/h.ts',
      'e2e/login.ts',
      'cypress/x.js',
      'playwright/a.ts',
      'src/__tests__/a.ts',
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
    expect(isTestFile('src/service.ts')).toBe(false);
  });

  it('matches the wider skip markers and stays linear (finding 4)', () => {
    for (const line of [
      'it.todo(',
      '@Disabled',
      '@Ignore',
      '@Pending',
      'pending("x")',
      'self.skipTest(1)',
      '@unittest.skip("x")',
      'xtest(',
      'xdescribe (',
      '@pytest.mark.xfail',
      't.SkipNow()',
      '@skipUnless(x)',
      'test.only',
    ]) {
      expect(TEST_SKIP_PATTERN.test(line), line).toBe(true);
    }
    const start = Date.now();
    TEST_SKIP_PATTERN.test(`${' '.repeat(100_000)}x`);
    TEST_SKIP_PATTERN.test('xit'.repeat(50_000));
    // Same reasoning: catastrophic backtracking would not finish, so the bound only has to be loose.
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 60_000);
});
