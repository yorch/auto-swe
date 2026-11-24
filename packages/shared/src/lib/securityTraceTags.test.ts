import { describe, expect, it } from 'vitest';
import {
  classifySecurityTrace,
  MEMORY_DROPPED_EVENTS,
  MEMORY_WRITE_REFUSED_EVENTS,
  SECURITY_BLOCK_TRACE_ERRORS,
  SECURITY_EVENT_TYPES,
  SECURITY_TRACE_ERRORS,
  type SecurityEventType,
  type SecurityTraceLike,
} from './securityTraceTags.js';

const TAGS = Object.values(SECURITY_TRACE_ERRORS);

describe('security trace tags', () => {
  it('has no tag that is a prefix of another', () => {
    // Every reader classifies a trace with `error.startsWith(tag)` in some order, so a tag that
    // prefixed another would classify by whichever check ran first.
    const offenders = TAGS.flatMap((a) =>
      TAGS.filter((b) => a !== b && b.startsWith(a)).map((b) => `${a} < ${b}`)
    );
    expect(offenders).toEqual([]);
  });

  it('keeps every blocking tag among the tags the workers write', () => {
    for (const tag of SECURITY_BLOCK_TRACE_ERRORS) {
      expect(TAGS).toContain(tag);
    }
  });
});

describe('classifySecurityTrace', () => {
  /**
   * One row per event type, typed as a Record so a type added to the list without a sample is a
   * compile error here — not a row the classifier silently mislabels at run time, which is what the
   * gateway's old fall-through did.
   */
  const sample: Record<SecurityEventType, SecurityTraceLike> = {
    CHANNEL_SUSPICIOUS: {
      error: null,
      toolName: 'channel.suspicious_input',
      type: 'activity_event',
    },
    CODE_SECURITY: { error: null, toolName: 'code_security.scan', type: 'activity_event' },
    CONTENT_SECURITY_BLOCK: {
      error: `${SECURITY_TRACE_ERRORS.CONTENT_BLOCK}: [CRITICAL] aws_key`,
      toolName: 'writeFile',
      type: 'tool_call',
    },
    CONTENT_SECURITY_WARN: {
      error: SECURITY_TRACE_ERRORS.CONTENT_WARN,
      toolName: 'writeFile',
      type: 'tool_call',
    },
    FILE_BLOCK: {
      error: `${SECURITY_TRACE_ERRORS.FILE_BLOCK}: '.env'`,
      toolName: 'writeFile',
      type: 'tool_call',
    },
    INSTRUCTION_FILE_BLOCK: {
      error: SECURITY_TRACE_ERRORS.INSTRUCTION_FILE_BLOCK,
      toolName: 'writeFile',
      type: 'tool_call',
    },
    LLM_SUSPICIOUS: { error: null, toolName: 'llm.suspicious_output', type: 'activity_event' },
    MEMORY_RECALL_DROPPED: {
      error: null,
      toolName: MEMORY_DROPPED_EVENTS[0] as string,
      type: 'activity_event',
    },
    MEMORY_WRITE_REFUSED: {
      error: null,
      toolName: MEMORY_WRITE_REFUSED_EVENTS[0] as string,
      type: 'activity_event',
    },
    RUN_CONFIG_BLOCK: {
      error: SECURITY_TRACE_ERRORS.RUN_CONFIG_BLOCK,
      toolName: 'Write',
      type: 'tool_call',
    },
    SHELL_BLOCK: {
      error: `${SECURITY_TRACE_ERRORS.SHELL_BLOCK}: pipe-to-shell`,
      toolName: 'bash',
      type: 'tool_call',
    },
  };

  it('names every type from the row the worker writes for it', () => {
    expect(Object.keys(sample).sort()).toEqual([...SECURITY_EVENT_TYPES].sort());
    for (const type of SECURITY_EVENT_TYPES) {
      expect(classifySecurityTrace(sample[type])).toBe(type);
    }
  });

  it('names nothing for a row that is not a security event', () => {
    // A tool call that neither a scanner nor a guard refused, and an unrelated activity event.
    expect(classifySecurityTrace({ error: null, toolName: 'bash', type: 'tool_call' })).toBeNull();
    expect(
      classifySecurityTrace({ error: null, toolName: 'workspace.ready', type: 'activity_event' })
    ).toBeNull();
    // An activity-event-shaped row with no tool name is not one either.
    expect(
      classifySecurityTrace({ error: null, toolName: null, type: 'activity_event' })
    ).toBeNull();
  });

  it('does not fall through to a type for an unrecognised error', () => {
    expect(
      classifySecurityTrace({
        error: 'something else entirely',
        toolName: 'bash',
        type: 'tool_call',
      })
    ).toBeNull();
  });
});
