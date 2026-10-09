import { describe, expect, it } from 'vitest';
import { CI_TRIAGE_DEFAULTS, CI_TRIAGE_INPUT_SCHEMA } from '../lib/ciTrigger.js';
import type { InputSchema } from '../lib/inputSchema.js';
import {
  AutomationInputsSchema,
  automationOptionsProblem,
  buildAutomationPayload,
  workflowRunFailedSource as ci,
  optionKeys,
  type WorkflowRunFailedFacts,
} from './index.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const push: WorkflowRunFailedFacts = {
  branch: 'main',
  event: 'push',
  headSha: 'a'.repeat(40),
  pullRequestNumber: null,
  runAttempt: 1,
  runId: '1',
  workflowPath: '.github/workflows/ci.yml',
};

describe('AutomationInputsSchema', () => {
  it('refuses null values', () => {
    expect(AutomationInputsSchema.safeParse({ mode: null }).success).toBe(false);
    expect(AutomationInputsSchema.safeParse({ mode: 'fix' }).success).toBe(true);
  });
});

describe('optionKeys', () => {
  it('is what an automation may set: declared properties the occurrence does not fill', () => {
    expect(optionKeys(CI_TRIAGE_INPUT_SCHEMA, ci).sort()).toEqual([
      'commentOnPullRequest',
      'fixCategories',
      'maxCiFixAttempts',
      'minFixConfidence',
      'mode',
      'pullRequestDelivery',
    ]);
  });
});

describe('buildAutomationPayload', () => {
  it('materialises every default, then the options, then the occurrence', () => {
    const built = buildAutomationPayload(
      ci,
      CI_TRIAGE_INPUT_SCHEMA,
      { minFixConfidence: 0.8, mode: 'fix' },
      CONN,
      push
    );
    expect(built).toEqual({
      ok: true,
      payload: {
        ...CI_TRIAGE_DEFAULTS,
        baseBranch: 'main',
        connectionId: CONN,
        description: 'Fix the failing .github/workflows/ci.yml on main (commit aaaaaaaaaaaa).',
        githubRunId: '1',
        minFixConfidence: 0.8,
        mode: 'fix',
        runAttempt: 1,
        ticketId: 'ci-1-1',
      },
    });
  });

  it('lets the occurrence win over a stored key it fills, and drops a stored PR number', () => {
    const built = buildAutomationPayload(
      ci,
      CI_TRIAGE_INPUT_SCHEMA,
      { baseBranch: 'evil', connectionId: 'x', pullRequestNumber: 9 },
      CONN,
      push
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.baseBranch).toBe('main');
      expect(built.payload.connectionId).toBe(CONN);
      expect('pullRequestNumber' in built.payload).toBe(false);
    }
  });

  it('refuses an option the template does not declare', () => {
    expect(buildAutomationPayload(ci, CI_TRIAGE_INPUT_SCHEMA, { mood: 'x' }, CONN, push)).toEqual({
      errors: ["'mood' is not an option of this template"],
      ok: false,
    });
  });

  it('refuses what the source contract refuses even where the schema allows it', () => {
    const loose: InputSchema = {
      ...CI_TRIAGE_INPUT_SCHEMA,
      properties: { ...CI_TRIAGE_INPUT_SCHEMA.properties, maxCiFixAttempts: { type: 'number' } },
    };
    expect(buildAutomationPayload(ci, loose, { maxCiFixAttempts: 1.5 }, CONN, push).ok).toBe(false);
  });

  it('refuses a template with no declared schema', () => {
    expect(buildAutomationPayload(ci, null, {}, CONN, push).ok).toBe(false);
  });
});

describe('automationOptionsProblem', () => {
  it('refuses an option the occurrence fills', () => {
    expect(
      automationOptionsProblem(ci, ci.defaultFilters, CI_TRIAGE_INPUT_SCHEMA, { baseBranch: 'x' })
    ).toMatch(/filled by each occurrence/);
  });

  const needsPr: InputSchema = {
    ...CI_TRIAGE_INPUT_SCHEMA,
    required: [...(CI_TRIAGE_INPUT_SCHEMA.required ?? []), 'pullRequestNumber'],
  };

  it('checks every shape of occurrence the filters select', () => {
    const filters = { ...ci.defaultFilters, events: ['pull_request' as const] };
    expect(automationOptionsProblem(ci, filters, needsPr, {})).toBeNull();
    expect(
      automationOptionsProblem(ci, { ...filters, events: ['push', 'pull_request'] }, needsPr, {})
    ).toMatch(/pullRequestNumber/);
  });
});
