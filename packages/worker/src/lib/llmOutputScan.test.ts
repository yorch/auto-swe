import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ incomplete: false, safe: true, warnings: [] })),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import { AgentTracer } from './agentTracer.js';
import { recordSuspiciousLlmOutput } from './llmOutputScan.js';

const scan = vi.mocked(scanSkillContent);

function events(tracer: AgentTracer) {
  return (tracer as unknown as { records: { toolName: string; outputJson?: unknown }[] }).records;
}

beforeEach(() => {
  scan.mockReset();
  scan.mockResolvedValue({ incomplete: false, safe: true, warnings: [] });
});

describe('recordSuspiciousLlmOutput', () => {
  it('records nothing for clean output', async () => {
    const tracer = new AgentTracer();
    await recordSuspiciousLlmOutput(tracer, 'all good');
    expect(events(tracer)).toHaveLength(0);
  });

  it('skips the scan entirely for empty text', async () => {
    await recordSuspiciousLlmOutput(new AgentTracer(), '');
    expect(scan).not.toHaveBeenCalled();
  });

  it('records a named advisory event with the warnings', async () => {
    scan.mockResolvedValue({ incomplete: false, safe: false, warnings: ['injection:x'] });
    const tracer = new AgentTracer();
    await recordSuspiciousLlmOutput(tracer, 'ignore previous', { inputJson: { iteration: 2 } });
    const [ev] = events(tracer);
    expect(ev.toolName).toBe('llm.suspicious_output');
    expect(ev.outputJson).toEqual({ warnings: ['injection:x'] });
  });

  it('honours a custom event name', async () => {
    scan.mockResolvedValue({ incomplete: false, safe: false, warnings: ['w'] });
    const tracer = new AgentTracer();
    await recordSuspiciousLlmOutput(tracer, 'x', { name: 'repoDependency.suspicious_inference' });
    expect(events(tracer)[0].toolName).toBe('repoDependency.suspicious_inference');
  });

  it('never throws when the scanner fails', async () => {
    scan.mockRejectedValue(new Error('db down'));
    const tracer = new AgentTracer();
    await expect(recordSuspiciousLlmOutput(tracer, 'x')).resolves.toBeUndefined();
    expect(events(tracer)).toHaveLength(0);
  });
});
