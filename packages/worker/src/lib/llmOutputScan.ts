import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import type { AgentTracer } from './agentTracer.js';

/**
 * Advisory injection/exfiltration scan of model output, recorded as a named
 * `activity_event` on the tracer when it finds something. This is the ONE
 * implementation of the post-generate scan every LLM-calling activity used to
 * copy inline: it never throws — a pattern-store or executor failure must not
 * abort an activity that has already paid for the model call — and it records
 * nothing for clean text.
 */
export async function recordSuspiciousLlmOutput(
  tracer: AgentTracer,
  text: string,
  opts: { name?: string; inputJson?: unknown } = {}
): Promise<void> {
  if (!text) {
    return;
  }
  try {
    const scan = await scanSkillContent(text);
    if (!scan.safe) {
      tracer.addActivityEvent({
        inputJson: opts.inputJson,
        name: opts.name ?? 'llm.suspicious_output',
        outputJson: { warnings: scan.warnings },
      });
    }
  } catch {
    // Advisory: the scan degrades, the activity continues.
  }
}
