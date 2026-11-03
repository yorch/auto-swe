import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
}));
const resolveAgentSpec = vi.hoisted(() => vi.fn());
const runAgent = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@auto-swe/shared/config', () => ({
  resolveSettings: vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, settings.values[k]]))
  ),
}));
vi.mock('../lib/config/agentSpec.js', () => ({ resolveAgentSpec }));
vi.mock('./runAgent.js', () => ({ runAgent }));
vi.mock('../lib/activityLog.js', () => ({ logWarn }));

import { AgentTracer } from '../lib/agentTracer.js';
import { type ResolvePrTitleInput, resolvePrTitle, resolvePrTitlePolicy } from './prTitle.js';

const DEFAULTS_TEMPLATE = '[auto-swe] {{ticketId}}';

function registry(over: Record<string, unknown> = {}): void {
  settings.values = {
    'workflow.prTitleFormat': 'template',
    'workflow.prTitleTemplate': '',
    'workflow.prTitleType': 'auto',
    ...over,
  };
}

function input(over: Partial<ResolvePrTitleInput> = {}): ResolvePrTitleInput {
  return {
    ctx: { teamId: 'team-1' },
    defaultsTemplate: DEFAULTS_TEMPLATE,
    description: 'Add GET /health endpoint\n\nIt should return 200.',
    files: [{ operation: 'CREATE', path: 'src/health.ts' }],
    renderTemplate: (template) =>
      template.replace('{{ticketId}}', 'JIRA-1').replace('{{description}}', 'desc'),
    repo: { prTitleFormat: null, prTitleTemplate: null },
    ticketId: 'JIRA-1',
    tracer: new AgentTracer(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registry();
  resolveAgentSpec.mockResolvedValue({ agentKey: 'prTitler' });
});

describe('resolvePrTitlePolicy', () => {
  it('uses the registry values and the defaults template when nothing is set', async () => {
    const policy = await resolvePrTitlePolicy(
      { prTitleFormat: null, prTitleTemplate: null },
      {},
      DEFAULTS_TEMPLATE
    );
    expect(policy).toEqual({
      format: 'template',
      template: DEFAULTS_TEMPLATE,
      templateExplicit: false,
      type: 'auto',
    });
  });

  it("prefers the repository's format and template over the registry's", async () => {
    registry({
      'workflow.prTitleFormat': 'conventional',
      'workflow.prTitleTemplate': 'team {{ticketId}}',
    });
    const policy = await resolvePrTitlePolicy(
      { prTitleFormat: 'template', prTitleTemplate: '  repo {{ticketId}}  ' },
      {},
      DEFAULTS_TEMPLATE
    );
    expect(policy.format).toBe('template');
    expect(policy.template).toBe('repo {{ticketId}}');
    expect(policy.templateExplicit).toBe(true);
  });

  it('falls to the registry template, then marks it explicit', async () => {
    registry({ 'workflow.prTitleTemplate': 'team {{ticketId}}' });
    const policy = await resolvePrTitlePolicy(
      { prTitleFormat: null, prTitleTemplate: '   ' },
      {},
      DEFAULTS_TEMPLATE
    );
    expect(policy.template).toBe('team {{ticketId}}');
    expect(policy.templateExplicit).toBe(true);
  });

  it('ignores a repository format it does not know and a registry type that is not one', async () => {
    registry({ 'workflow.prTitleFormat': 'conventional', 'workflow.prTitleType': 'bogus' });
    const policy = await resolvePrTitlePolicy(
      { prTitleFormat: 'wat', prTitleTemplate: null },
      {},
      DEFAULTS_TEMPLATE
    );
    expect(policy.format).toBe('conventional');
    expect(policy.type).toBe('auto');
  });

  it('passes the scope context through to the registry', async () => {
    const { resolveSettings } = await import('@auto-swe/shared/config');
    const ctx = { orgId: 'org-1', teamId: 'team-1', workflowTemplateId: 'tpl-1' };
    await resolvePrTitlePolicy({ prTitleFormat: null, prTitleTemplate: null }, ctx, 'x');
    expect(resolveSettings).toHaveBeenCalledWith(expect.any(Array), ctx);
  });
});

describe('resolvePrTitle in template format', () => {
  it('renders the defaults template and never calls the model', async () => {
    expect(await resolvePrTitle(input())).toBe('[auto-swe] JIRA-1');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('keeps an agent run its legacy title until a template is set below the defaults', async () => {
    expect(await resolvePrTitle(input({ legacyTitle: '[auto-swe] agent run: x' }))).toBe(
      '[auto-swe] agent run: x'
    );
  });

  it('renders an explicit template over the legacy title', async () => {
    registry({ 'workflow.prTitleTemplate': 'chore: {{ticketId}}' });
    expect(await resolvePrTitle(input({ legacyTitle: '[auto-swe] agent run: x' }))).toBe(
      'chore: JIRA-1'
    );
  });
});

describe('resolvePrTitle in conventional format', () => {
  beforeEach(() => {
    registry({ 'workflow.prTitleFormat': 'conventional' });
  });

  it('uses the type and summary the titler chose', async () => {
    runAgent.mockResolvedValue({ object: { summary: 'Add a health endpoint.', type: 'feat' } });
    expect(await resolvePrTitle(input())).toBe('feat: add a health endpoint');
    expect(runAgent).toHaveBeenCalledOnce();
    const [, message] = runAgent.mock.calls[0];
    expect(message).toContain('<request>');
    expect(message).toContain('CREATE src/health.ts');
  });

  it('skips the model for a fixed type and summarises from the first line of the request', async () => {
    registry({ 'workflow.prTitleFormat': 'conventional', 'workflow.prTitleType': 'docs' });
    expect(await resolvePrTitle(input())).toBe('docs: add GET /health endpoint');
    expect(runAgent).not.toHaveBeenCalled();
    expect(resolveAgentSpec).not.toHaveBeenCalled();
  });

  it("applies the repository's conventional format over a template registry", async () => {
    registry({ 'workflow.prTitleFormat': 'template' });
    runAgent.mockResolvedValue({ object: { summary: 'tidy up', type: 'chore' } });
    const title = await resolvePrTitle(
      input({ repo: { prTitleFormat: 'conventional', prTitleTemplate: null } })
    );
    expect(title).toBe('chore: tidy up');
  });

  it('falls back to chore and the first line when the titler throws', async () => {
    resolveAgentSpec.mockRejectedValue(new Error('no credential'));
    expect(await resolvePrTitle(input())).toBe('chore: add GET /health endpoint');
    expect(logWarn).toHaveBeenCalled();
  });

  it('falls back when the titler answers with the wrong shape', async () => {
    runAgent.mockResolvedValue({ object: { summary: 'x', type: 'banana' } });
    expect(await resolvePrTitle(input())).toBe('chore: add GET /health endpoint');
  });

  it('falls back to the ticket id when the request has no text', async () => {
    resolveAgentSpec.mockRejectedValue(new Error('down'));
    expect(await resolvePrTitle(input({ description: '  \n ' }))).toBe('chore: JIRA-1');
  });

  it('resolves the titler at the narrower scope when one is given', async () => {
    runAgent.mockResolvedValue({ object: { summary: 'x', type: 'fix' } });
    await resolvePrTitle(
      input({ agentCtx: { orgId: 'org-1' }, ctx: { orgId: 'org-1', teamId: 't' } })
    );
    expect(resolveAgentSpec).toHaveBeenCalledWith(expect.anything(), { orgId: 'org-1' });
    expect(runAgent.mock.calls[0][2]).toMatchObject({ ctx: { orgId: 'org-1' } });
  });

  it('records which format and type it used', async () => {
    runAgent.mockResolvedValue({ object: { summary: 'x', type: 'fix' } });
    const tracer = new AgentTracer();
    const spy = vi.spyOn(tracer, 'addActivityEvent');
    await resolvePrTitle(input({ tracer }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'pr.title',
        outputJson: { classified: true, format: 'conventional', type: 'auto' },
      })
    );
  });
});
