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
import { InboundEventFiltersSchema, inboundEventSource } from './sources/inboundEvent.js';

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

  it('names no repository for an automation that has none', () => {
    // The CI template and contract need a repository; one that does not stands in here.
    const { connectionId: _, ...properties } = CI_TRIAGE_INPUT_SCHEMA.properties;
    const repoless: InputSchema = {
      ...CI_TRIAGE_INPUT_SCHEMA,
      properties,
      required: (CI_TRIAGE_INPUT_SCHEMA.required ?? []).filter((k) => k !== 'connectionId'),
    };
    const built = buildAutomationPayload({ ...ci, contract: undefined }, repoless, {}, null, push);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect('connectionId' in built.payload).toBe(false);
      expect(built.payload.ticketId).toBe('ci-1-1');
    }
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

  describe('a mapped field the sample value cannot satisfy', () => {
    const schema: InputSchema = {
      properties: {
        connectionId: { connectionType: 'git_repo', type: 'connection' },
        cve: { maxLength: 32, pattern: 'CVE-\\d{4}-\\d{4,7}', type: 'string' },
        mode: { maxLength: 3, type: 'string' },
        short: { maxLength: 3, type: 'string' },
      },
      required: ['connectionId'],
      type: 'object',
    };
    const filters = (fields: Record<string, string>) =>
      InboundEventFiltersSchema.parse({
        endpointId: '22222222-2222-4222-8222-222222222222',
        eventTypes: ['x'],
        fields,
      });

    it('saves: pattern and maxLength are checked on the real value, not the stand-in', () => {
      const cases: Record<string, string>[] = [
        { cve: '/cve' },
        { short: '/s' },
        { cve: '/cve', short: '/s' },
      ];
      for (const fields of cases) {
        expect(
          automationOptionsProblem(inboundEventSource, filters(fields), schema, {}, true),
          JSON.stringify(fields)
        ).toBeNull();
      }
    });

    it('checks a constraint on a key the platform builds, so the save fails, not every fire', () => {
      // The description is built from the event the same way at every fire, and is far longer
      // than 200 characters for an inbound event: no occurrence could ever start a run.
      const shortDescription: InputSchema = {
        ...schema,
        properties: { ...schema.properties, description: { maxLength: 200, type: 'string' } },
      };
      expect(
        automationOptionsProblem(
          inboundEventSource,
          filters({ cve: '/cve' }),
          shortDescription,
          {},
          true
        )
      ).toContain("'description' must be at most 200 characters");
      // The CVE pattern on the mapped field still saves beside an unconstrained description.
      expect(
        automationOptionsProblem(inboundEventSource, filters({ cve: '/cve' }), schema, {}, true)
      ).toBeNull();
    });

    it('refuses at save a mapped field whose stored pattern this platform does not run', () => {
      // A legacy schema, stored before the subset was enforced: relaxing its pattern for the
      // stand-in would let the save pass and fail every fire as "cannot be checked".
      const legacy = {
        ...schema,
        properties: { ...schema.properties, cve: { pattern: '(CVE|GHSA)-.+', type: 'string' } },
      } as InputSchema;
      expect(
        automationOptionsProblem(inboundEventSource, filters({ cve: '/cve' }), legacy, {}, true)
      ).toContain("'cve' cannot be checked");
    });

    it('still checks an option the automation stores, which is a real value', () => {
      expect(
        automationOptionsProblem(
          inboundEventSource,
          filters({ cve: '/cve' }),
          schema,
          { mode: 'toolong' },
          true
        )
      ).toContain("'mode' must be at most 3 characters");
    });

    it('still refuses the real value at run time', () => {
      const r = buildAutomationPayload(
        inboundEventSource,
        schema,
        {},
        CONN,
        inboundEventSource.samples(filters({ cve: '/cve' }), schema)[0] as never
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors.join()).toContain("'cve' does not match the required pattern");
    });
  });
});
