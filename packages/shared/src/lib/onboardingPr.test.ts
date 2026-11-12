import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_PR_WORKFLOW_TYPE,
  OnboardingRequestSchema,
  onboardingPrWorkflowId,
  PR_POLICY_FILE_PATH,
  renderOnboardingFiles,
} from './onboardingPr.js';
import { parsePolicyFile } from './prEvaluation/policy.js';
import { PreviewConfigSchema } from './previewConfig.js';
import { parseRepoGatesYaml, parseRepoPreviewYaml } from './repoConfigFiles.js';
import { parseRepoSetupYaml } from './repoSetup.js';
import { parseToolsFile, TOOLS_FILE_PATH } from './toolsFile.js';

const tools = { kind: 'tools', tools: [{ key: 'ripgrep' }, { key: 'jq', version: '1.7.1' }] };

describe('OnboardingRequestSchema', () => {
  it('accepts both kinds and a policy without paths', () => {
    expect(
      OnboardingRequestSchema.safeParse({
        files: [tools, { kind: 'prPolicy', sensitivePaths: ['**/auth/**'] }],
      }).success
    ).toBe(true);
    expect(OnboardingRequestSchema.safeParse({ files: [{ kind: 'prPolicy' }] }).success).toBe(true);
  });

  it.each([
    ['no files', { files: [] }],
    ['a duplicate kind', { files: [tools, tools] }],
    ['an unknown kind', { files: [{ kind: 'workflow' }] }],
    ['an empty tools list', { files: [{ kind: 'tools', tools: [] }] }],
    [
      'more than 32 tools',
      {
        files: [
          { kind: 'tools', tools: Array.from({ length: 33 }, (_v, i) => ({ key: `tool${i}` })) },
        ],
      },
    ],
    [
      'a tool key named twice',
      { files: [{ kind: 'tools', tools: [{ key: 'jq' }, { key: 'jq', version: '1.7.1' }] }] },
    ],
    ['an invalid tool key', { files: [{ kind: 'tools', tools: [{ key: 'Bad Key' }] }] }],
    ['an extra field', { files: [{ kind: 'prPolicy', path: '.github/x' }] }],
    ['an extra top-level field', { files: [tools], path: 'x' }],
    ['a parent-directory path', { files: [{ kind: 'prPolicy', sensitivePaths: ['../x'] }] }],
    ['a leading slash', { files: [{ kind: 'prPolicy', sensitivePaths: ['/etc/**'] }] }],
    ['a newline', { files: [{ kind: 'prPolicy', sensitivePaths: ['a\nb: c'] }] }],
    ['an empty path', { files: [{ kind: 'prPolicy', sensitivePaths: [''] }] }],
    ['a 201-char path', { files: [{ kind: 'prPolicy', sensitivePaths: ['a'.repeat(201)] }] }],
    [
      'more than 50 paths',
      {
        files: [
          {
            kind: 'prPolicy',
            sensitivePaths: Array.from({ length: 51 }, (_v, i) => `dir${i}/**`),
          },
        ],
      },
    ],
  ])('rejects %s', (_name, body) => {
    expect(OnboardingRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('renderOnboardingFiles', () => {
  const setup = { env: { A: 'first', Z: 'last' }, steps: [{ name: 'install', run: 'npm ci' }] };
  const gateCommands = { runBuild: null, runLint: 'npm run lint', runTests: 'npm test' };
  const previewConfig = {
    env: { A: 'first', Z: 'last' },
    readyUrl: 'http://localhost:3000/',
    start: 'npm start',
  };

  it('renders the three new fixed paths in kind order and round-trips through their parsers', () => {
    const files = renderOnboardingFiles(
      OnboardingRequestSchema.parse({
        files: [
          { kind: 'preview', previewConfig },
          { gateCommands, kind: 'gates' },
          { kind: 'setup', setup },
        ],
      })
    );
    expect(files.map((file) => file.path)).toEqual([
      '.auto-swe/setup.yml',
      '.auto-swe/gates.yml',
      '.auto-swe/preview.yml',
    ]);
    expect(parseRepoSetupYaml(files[0]?.content ?? '')).toEqual({ ok: true, setup });
    expect(parseRepoGatesYaml(files[1]?.content ?? '')).toEqual({ ok: true, value: gateCommands });
    expect(parseRepoPreviewYaml(files[2]?.content ?? '')).toEqual({
      ok: true,
      value: PreviewConfigSchema.parse(previewConfig),
    });
  });

  it('renders identically when file and map input order differ', () => {
    const a = renderOnboardingFiles(
      OnboardingRequestSchema.parse({
        files: [
          { kind: 'setup', setup },
          { gateCommands, kind: 'gates' },
          { kind: 'preview', previewConfig },
        ],
      })
    );
    const b = renderOnboardingFiles(
      OnboardingRequestSchema.parse({
        files: [
          { kind: 'preview', previewConfig: { ...previewConfig, env: { A: 'first', Z: 'last' } } },
          {
            gateCommands: { runBuild: null, runLint: 'npm run lint', runTests: 'npm test' },
            kind: 'gates',
          },
          { kind: 'setup', setup: { ...setup, env: { A: 'first', Z: 'last' } } },
        ],
      })
    );
    expect(a).toEqual(b);
  });

  it('accepts all five kinds together and refuses duplicate or malformed new kinds', () => {
    expect(
      OnboardingRequestSchema.safeParse({
        files: [
          tools,
          { kind: 'prPolicy' },
          { kind: 'setup', setup },
          { gateCommands, kind: 'gates' },
          { kind: 'preview', previewConfig },
        ],
      }).success
    ).toBe(true);
    for (const file of [
      { kind: 'setup', setup },
      { gateCommands, kind: 'gates' },
      { kind: 'preview', previewConfig },
    ]) {
      expect(OnboardingRequestSchema.safeParse({ files: [file, file] }).success).toBe(false);
    }
    for (const file of [
      { kind: 'setup', setup: { steps: 'bad' } },
      { gateCommands: { unknown: 'bad' }, kind: 'gates' },
      { kind: 'preview', previewConfig: null },
    ]) {
      expect(OnboardingRequestSchema.safeParse({ files: [file] }).success).toBe(false);
    }
  });

  it('rejects recipes too large to parse back', () => {
    const env = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`VALUE_${i}`, 'x'.repeat(4000)])
    );
    const request = OnboardingRequestSchema.parse({
      files: [{ kind: 'preview', previewConfig: { ...previewConfig, env } }],
    });
    expect(() => renderOnboardingFiles(request)).toThrow('.auto-swe/preview.yml cannot round-trip');
  });
  it('writes only the two fixed paths, tools first, whatever the request order', () => {
    const request = OnboardingRequestSchema.parse({
      files: [{ kind: 'prPolicy', sensitivePaths: ['**/auth/**'] }, tools],
    });
    expect(renderOnboardingFiles(request).map((f) => f.path)).toEqual([
      TOOLS_FILE_PATH,
      PR_POLICY_FILE_PATH,
    ]);
  });

  it('is deterministic', () => {
    const a = OnboardingRequestSchema.parse({ files: [tools, { kind: 'prPolicy' }] });
    const b = OnboardingRequestSchema.parse({
      files: [{ kind: 'prPolicy' }, { kind: 'tools', tools: [...tools.tools].reverse() }],
    });
    expect(renderOnboardingFiles(a)).toEqual(renderOnboardingFiles(b));
  });

  it('renders a tools file that parses back', () => {
    const [file] = renderOnboardingFiles(OnboardingRequestSchema.parse({ files: [tools] }));
    expect(parseToolsFile(file.content)).toEqual([
      { key: 'jq', version: '1.7.1' },
      { key: 'ripgrep' },
    ]);
  });

  it('renders a policy the platform parser accepts (shared parser, not the SDK)', () => {
    const paths = ['**/auth/**', "it's: tricky #path", 'deploy/*'];
    const request = OnboardingRequestSchema.parse({
      files: [{ kind: 'prPolicy', sensitivePaths: paths }],
    });
    const [file] = renderOnboardingFiles(request);
    const parsed = parsePolicyFile(file.content);
    expect(parsed.errors).toEqual([]);
    expect(parsed.policy?.sensitivePaths).toEqual(paths);
    expect(file.content).toContain('version: 1');
  });

  it('renders a valid policy with no paths', () => {
    const [file] = renderOnboardingFiles(
      OnboardingRequestSchema.parse({ files: [{ kind: 'prPolicy' }] })
    );
    expect(parsePolicyFile(file.content).errors).toEqual([]);
  });
});

describe('onboardingPrWorkflowId', () => {
  it('is the full connection id and the 16-hex content hash', () => {
    expect(ONBOARDING_PR_WORKFLOW_TYPE).toBe('onboardingPrWorkflow');
    expect(onboardingPrWorkflowId('11111111-2222-4333-8444-555555555555', 'abcd1234abcd1234')).toBe(
      'onboard-11111111-2222-4333-8444-555555555555-abcd1234abcd1234'
    );
  });

  it('differs for two connections that share their first 8 hex digits', () => {
    expect(
      onboardingPrWorkflowId('11111111-2222-4333-8444-555555555555', 'abcd1234abcd1234')
    ).not.toBe(onboardingPrWorkflowId('11111111-aaaa-4333-8444-555555555555', 'abcd1234abcd1234'));
  });
});
