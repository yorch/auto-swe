import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import {
  filterTraces,
  formatTraceOffset,
  isTraceFilterActive,
  NO_TRACE_FILTER,
  newestTraces,
} from './traceFilter';

function trace(over: Partial<AgentTraceRecord>): AgentTraceRecord {
  return {
    agentKey: 'implementer',
    createdAt: '2026-10-01T12:00:00Z',
    error: null,
    id: 'x',
    inputJson: null,
    nodeId: 'implement',
    outputJson: null,
    toolName: null,
    type: 'tool_call',
    ...over,
  } as unknown as AgentTraceRecord;
}

const traces = [
  trace({ id: 'a', inputJson: { command: 'yarn test' }, toolName: 'bash' }),
  trace({ error: 'ENOENT: no such file', id: 'b', toolName: 'readFile' }),
  trace({
    id: 'c',
    model: 'anthropic/claude',
    outputJson: { text: 'All DONE' },
    type: 'llm_response',
  }),
  trace({ id: 'd', toolName: 'git.commit_push', type: 'activity_event' }),
];

describe('filterTraces', () => {
  it('returns the same list when no filter is set', () => {
    expect(filterTraces(traces, NO_TRACE_FILTER)).toBe(traces);
    expect(isTraceFilterActive(NO_TRACE_FILTER)).toBe(false);
  });

  it('narrows to errors only', () => {
    expect(filterTraces(traces, { ...NO_TRACE_FILTER, errorsOnly: true }).map((t) => t.id)).toEqual(
      ['b']
    );
  });

  it('narrows by kind', () => {
    expect(
      filterTraces(traces, { ...NO_TRACE_FILTER, kind: 'llm_response' }).map((t) => t.id)
    ).toEqual(['c']);
  });

  it('searches names, errors and payloads case-insensitively', () => {
    const ids = (query: string) =>
      filterTraces(traces, { ...NO_TRACE_FILTER, query }).map((t) => t.id);
    expect(ids('YARN TEST')).toEqual(['a']);
    expect(ids('enoent')).toEqual(['b']);
    expect(ids('all done')).toEqual(['c']);
    expect(ids('commit_push')).toEqual(['d']);
    expect(ids('nothing like this')).toEqual([]);
  });

  it('combines the filters', () => {
    expect(
      filterTraces(traces, { errorsOnly: true, kind: 'tool_call', query: 'readfile' }).map(
        (t) => t.id
      )
    ).toEqual(['b']);
    expect(filterTraces(traces, { errorsOnly: true, kind: 'llm_response', query: '' })).toEqual([]);
  });
});

describe('newestTraces', () => {
  it('keeps the newest and reports how many were held back', () => {
    expect(newestTraces(traces, 2)).toEqual({ hidden: 2, shown: traces.slice(2) });
    expect(newestTraces(traces, 10)).toEqual({ hidden: 0, shown: traces });
  });
});

describe('formatTraceOffset', () => {
  const start = '2026-10-01T12:00:00Z';
  it('formats minutes and seconds since the start', () => {
    expect(formatTraceOffset('2026-10-01T12:02:14Z', start)).toBe('+02:14');
    expect(formatTraceOffset(start, start)).toBe('+00:00');
  });
  it('adds hours past an hour', () => {
    expect(formatTraceOffset('2026-10-01T13:02:14Z', start)).toBe('+1:02:14');
  });
  it('never goes negative and tolerates missing or bad times', () => {
    expect(formatTraceOffset('2026-10-01T11:59:00Z', start)).toBe('+00:00');
    expect(formatTraceOffset(null, start)).toBeNull();
    expect(formatTraceOffset('2026-10-01T12:00:00Z', undefined)).toBeNull();
    expect(formatTraceOffset('garbage', start)).toBeNull();
  });
});
