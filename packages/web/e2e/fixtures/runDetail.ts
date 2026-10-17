import type {
  AgentTraceRecord,
  WorkflowRunDetail,
  WorkflowStepRecord,
} from '@auto-swe/shared/types/api';
import { ago } from './common';
import { TICKET_TO_PR_SPEC } from './templates';
import { RUNS } from './work';

/** run-0001: the failed request on Home, failing at its test gate after two retries. */
const START = 95;

const step = (
  n: number,
  nodeId: string,
  status: WorkflowStepRecord['status'],
  startedMinutesAgo: number,
  minutes: number,
  extra: Partial<WorkflowStepRecord> = {}
): WorkflowStepRecord => ({
  attempt: 1,
  endedAt: ago(startedMinutesAgo - minutes),
  error: null,
  id: `step-rec-${n}`,
  inputs: null,
  nodeId,
  outputs: null,
  startedAt: ago(startedMinutesAgo),
  status,
  ...extra,
});

const TEST_FAILURE = [
  'FAIL src/refunds/retry.test.ts > retries a timed-out refund once',
  '  AssertionError: expected 2 calls to the card network, received 1',
  '    at src/refunds/retry.test.ts:48:31',
  '',
  'Test Files  1 failed | 37 passed (38)',
  '     Tests  1 failed | 412 passed (413)',
].join('\n');

export const RUN_STEPS: WorkflowStepRecord[] = [
  step(1, 'validate', 'PASSED', START, 1),
  step(2, 'plan', 'PASSED', START - 1, 3),
  step(3, 'approvePlan', 'PASSED', START - 4, 12),
  step(4, 'implement', 'PASSED', START - 16, 14, {
    outputs: { filesChanged: 4, summary: 'Wrapped refund calls in an idempotent retry.' },
  }),
  ...[1, 2, 3].map((attempt) =>
    step(4 + attempt, 'runTests', 'FAILED', START - 30 - attempt * 2, 2, {
      attempt,
      error: TEST_FAILURE,
      outputs: { exitCode: 1, passed: false },
    })
  ),
];

const trace = (
  seq: number,
  type: 'tool_call' | 'llm_response' | 'activity_event',
  minutesAgo: number,
  extra: Partial<AgentTraceRecord>
): AgentTraceRecord => ({
  agentKey: 'implementer',
  attempt: 1,
  costUsd: null,
  createdAt: ago(minutesAgo),
  durationMs: 1200,
  error: null,
  id: `trace-${seq}`,
  inputJson: null,
  inputTokens: null,
  model: null,
  nodeId: 'executeImplementation',
  otelSpanId: null,
  otelTraceId: null,
  outputJson: null,
  outputTokens: null,
  recordingId: 'implement',
  seq,
  specNodeId: 'implement',
  stepAttempt: 1,
  toolName: null,
  trimmed: false,
  type,
  ...extra,
});

export const RUN_TRACES: AgentTraceRecord[] = [
  trace(1, 'llm_response', START - 17, {
    costUsd: 0.41,
    inputJson: { userMessage: 'Implement PAY-1423: retry idempotent refunds on timeout.' },
    inputTokens: 18_200,
    model: 'anthropic/claude-opus-5-5',
    outputJson: { text: 'I will read the refund client first, then add a failing test.' },
    outputTokens: 640,
  }),
  trace(2, 'tool_call', START - 18, {
    inputJson: { path: 'src/refunds/client.ts' },
    outputJson: { content: 'export async function refund(…)' },
    toolName: 'readFile',
  }),
  trace(3, 'tool_call', START - 22, {
    inputJson: { command: 'yarn vitest run src/refunds' },
    outputJson: { exitCode: 0, stdout: 'Tests  12 passed (12)' },
    toolName: 'bash',
  }),
  trace(4, 'llm_response', START - 28, {
    costUsd: 0.37,
    inputJson: { userMessage: 'Summarise the change.' },
    inputTokens: 21_900,
    model: 'anthropic/claude-opus-5-5',
    outputJson: { text: 'Refunds now retry once with the same idempotency key.' },
    outputTokens: 210,
  }),
];

export const RUN_DETAIL: WorkflowRunDetail = {
  ...RUNS[0],
  agentRuntimes: {},
  contextSnapshot: {},
  humanSteps: [],
  implementerRuntime: 'mastra',
  isAgentRun: false,
  result: null,
  specSnapshot: TICKET_TO_PR_SPEC,
  steps: RUN_STEPS,
  templateName: 'Ticket to pull request',
  tokensInputTotal: 40_100,
  tokensOutputTotal: 850,
  traces: RUN_TRACES,
  tracesTruncated: false,
};
