import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpTestApp, INJECTION, type StubRoutes } from '../../../test/mcpHarness.js';

const RUN = '77777777-7777-4777-8777-777777777777';
const ROW = '88888888-8888-4888-8888-888888888888';
const USER = '55555555-5555-4555-8555-555555555555';
const EMAIL = 'someone@example.com';

const evalPath = 'GET /api/v1/workflow-runs/:id/eval-results';
const effectsPath = 'GET /api/v1/workflow-runs/:id/effects';
const decisionsPath = 'GET /api/v1/workflow-runs/:id/autonomy-decisions';
const evidencePath = 'GET /api/v1/workflow-runs/:id/evidence';

const evalRow = {
  agentKey: 'reviewer',
  caseId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  evalRunId: null,
  id: ROW,
  metadata: { email: EMAIL, note: INJECTION },
  nodeId: 'review',
  passed: true,
  rationale: INJECTION,
  runId: RUN,
  runtime: null,
  scorer: 'gate:tests',
  scoreType: 'BOOLEAN',
  source: 'GATE',
  value: 1,
};

const effectRow = {
  action: INJECTION,
  agentKey: 'implementer',
  createdAt: '2026-10-01T10:00:00.000Z',
  detail: { email: EMAIL, text: INJECTION },
  error: INJECTION,
  id: ROW,
  inputDigest: INJECTION,
  kind: 'PULL_REQUEST',
  specNodeId: 'implement',
  status: 'DONE',
  target: `https://evil.example/${INJECTION}`,
  via: 'activity',
};

const decisionRow = {
  actorId: USER,
  createdAt: '2026-10-01T10:00:00.000Z',
  event: 'approve',
  id: ROW,
  payload: { comment: INJECTION, email: EMAIL },
  policyName: 'default',
  requiredApprovers: 2,
  riskClass: 'external_communication',
  runId: RUN,
};

const evidenceRow = {
  caption: INJECTION,
  contentType: `image/png; ${INJECTION}`,
  createdAt: '2026-10-01T10:00:00.000Z',
  height: 600,
  id: ROW,
  kind: 'screenshot',
  pageUrl: `https://evil.example/${INJECTION}?e=${EMAIL}`,
  sizeBytes: 2048,
  source: INJECTION,
  specNodeId: 'validate',
  stepAttempt: 1,
  width: 800,
};

const routes: StubRoutes = {
  [evalPath]: { body: { data: [evalRow] } },
  [effectsPath]: { body: { data: [effectRow], truncated: false } },
  [decisionsPath]: { body: { data: [decisionRow] } },
  [evidencePath]: { body: { data: [evidenceRow] } },
};

const forbidden = (json: unknown) => {
  const text = JSON.stringify(json);
  expect(text).not.toContain('IGNORE ALL PREVIOUS');
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain('evil.example');
};

describe('the run evidence tools', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  async function setup(r: StubRoutes = routes) {
    const built = await buildMcpTestApp(r);
    apps.push(built.app);
    return built;
  }

  it('returns eval results without the rationale or metadata', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('get_run_eval_results', { runId: RUN });
    expect(seen.urls).toEqual([`/api/v1/workflow-runs/${RUN}/eval-results`]);
    expect(out).toEqual({
      results: [
        {
          agentKey: 'reviewer',
          createdAt: '2026-10-01T10:00:00.000Z',
          id: ROW,
          nodeId: 'review',
          passed: true,
          scored: true,
          scorer: 'gate:tests',
          scoreType: 'BOOLEAN',
          source: 'GATE',
          value: 1,
        },
      ],
    });
    forbidden(json);
  });

  it('returns effects as kinds and outcomes, never action, target, detail or error', async () => {
    const { callTool } = await setup();
    const { out, json } = await callTool('list_run_effects', { runId: RUN });
    expect(out).toEqual({
      effects: [
        {
          agentKey: 'implementer',
          createdAt: '2026-10-01T10:00:00.000Z',
          id: ROW,
          kind: 'PULL_REQUEST',
          nodeId: 'implement',
          status: 'DONE',
          via: 'activity',
        },
      ],
      truncated: false,
    });
    forbidden(json);
  });

  it('returns autonomy decisions without the payload and passes the page', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('list_run_autonomy_decisions', {
      limit: 20,
      offset: 5,
      runId: RUN,
    });
    expect(seen.queries[0]).toEqual({ limit: '20', offset: '5' });
    expect(out).toEqual({
      decisions: [
        {
          actorId: USER,
          createdAt: '2026-10-01T10:00:00.000Z',
          event: 'approve',
          id: ROW,
          policyName: 'default',
          requiredApprovers: 2,
          riskClass: 'external_communication',
        },
      ],
    });
    forbidden(json);
  });

  it('returns evidence metadata without caption, page URL, source or content type', async () => {
    const { callTool } = await setup();
    const { out, json } = await callTool('list_run_evidence', { runId: RUN });
    expect(out).toEqual({
      evidence: [
        {
          createdAt: '2026-10-01T10:00:00.000Z',
          height: 600,
          id: ROW,
          kind: 'screenshot',
          nodeId: 'validate',
          sizeBytes: 2048,
          stepAttempt: 1,
          width: 800,
        },
      ],
    });
    forbidden(json);
  });

  it('cleans hostile names and enums in every tool', async () => {
    const hostile = `${INJECTION} ${EMAIL}`.repeat(10);
    const { callTool } = await setup({
      [evalPath]: {
        body: {
          data: [
            {
              ...evalRow,
              agentKey: hostile,
              nodeId: hostile,
              scorer: hostile,
              scoreType: INJECTION,
              source: EMAIL,
            },
          ],
        },
      },
      [effectsPath]: {
        body: {
          data: [
            {
              ...effectRow,
              agentKey: hostile,
              kind: INJECTION,
              specNodeId: hostile,
              status: EMAIL,
              via: INJECTION,
            },
          ],
          truncated: true,
        },
      },
      [decisionsPath]: {
        body: {
          data: [{ ...decisionRow, event: INJECTION, policyName: hostile, riskClass: hostile }],
        },
      },
      [evidencePath]: { body: { data: [{ ...evidenceRow, specNodeId: hostile }] } },
    });
    const first = async (name: string, key: string) => {
      const { out, isError } = await callTool(name, { runId: RUN });
      expect(isError).toBe(false);
      return ((out?.[key] ?? []) as Array<Record<string, unknown>>)[0] ?? {};
    };
    const result = await first('get_run_eval_results', 'results');
    expect(result).toMatchObject({ scoreType: 'UNKNOWN', source: 'UNKNOWN' });
    expect(typeof result.scorer === 'string' && result.scorer.length <= 100).toBe(true);
    expect(typeof result.agentKey === 'string' && result.agentKey.length <= 100).toBe(true);
    const effect = await first('list_run_effects', 'effects');
    expect(effect).toMatchObject({ kind: 'UNKNOWN', status: 'UNKNOWN', via: 'unknown' });
    expect(typeof effect.agentKey === 'string' && effect.agentKey.length <= 100).toBe(true);
    expect(typeof effect.nodeId === 'string' && effect.nodeId.length <= 100).toBe(true);
    const decision = await first('list_run_autonomy_decisions', 'decisions');
    expect(decision).toMatchObject({ event: 'unknown' });
    expect(typeof decision.policyName === 'string' && decision.policyName.length <= 100).toBe(true);
    const evidence = await first('list_run_evidence', 'evidence');
    expect(typeof evidence.nodeId === 'string' && evidence.nodeId.length <= 100).toBe(true);
  });

  it('marks a placeholder score as not scored and a real one as scored', async () => {
    const { out } = await setup({
      ...routes,
      [evalPath]: {
        body: {
          data: [
            { ...evalRow, passed: null, rationale: 'scorer error: judge call failed', value: 0.5 },
            { ...evalRow },
          ],
        },
      },
    }).then(({ callTool }) => callTool('get_run_eval_results', { runId: RUN }));
    const scored = ((out?.results ?? []) as Array<{ scored: boolean }>).map((r) => r.scored);
    expect(scored).toEqual([false, true]);
  });

  it.each(['request_changes', 'select', 'submit'])(
    'keeps a decision whose event is %s instead of failing the whole run',
    async (event) => {
      const { out } = await setup({
        ...routes,
        [decisionsPath]: { body: { data: [{ ...decisionRow, event }, { ...decisionRow }] } },
      }).then(({ callTool }) => callTool('list_run_autonomy_decisions', { runId: RUN }));
      const events = ((out?.decisions ?? []) as Array<{ event: string }>).map((d) => d.event);
      expect(events).toEqual([event, 'approve']);
    }
  );

  it('asks for 50 decisions by default, as the shared page description says', async () => {
    const { callTool, seen } = await setup();
    await callTool('list_run_autonomy_decisions', { runId: RUN });
    expect(seen.queries[0]).toEqual({ limit: '50' });
  });

  it.each([
    ['get_run_eval_results', evalPath],
    ['list_run_effects', effectsPath],
    ['list_run_autonomy_decisions', decisionsPath],
    ['list_run_evidence', evidencePath],
  ])('says a run the caller cannot see was not found (%s)', async (name, path) => {
    const { callTool } = await setup({ ...routes, [path]: { body: {}, status: 404 } });
    const { json, isError } = await callTool(name, { runId: RUN });
    expect(isError).toBe(true);
    expect(json.result?.content[0]?.text).toBe('Run not found.');
    forbidden(json);
  });

  it.each([
    'get_run_eval_results',
    'list_run_effects',
    'list_run_autonomy_decisions',
    'list_run_evidence',
  ])('refuses a run id that is not a uuid before any call is made (%s)', async (name) => {
    const { callTool, seen } = await setup();
    const { isError } = await callTool(name, { runId: 'not-a-uuid' });
    expect(isError).toBe(true);
    expect(seen.urls).toEqual([]);
  });
});
