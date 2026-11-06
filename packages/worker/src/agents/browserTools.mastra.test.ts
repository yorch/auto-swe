import { Agent } from '@mastra/core/agent';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: vi.fn() } },
}));
vi.mock('@auto-swe/shared/config/resolveSetting', () => ({ resolveSetting: vi.fn() }));
vi.mock('../browser/session.js', () => ({ BrowserSession: { start: vi.fn() } }));
vi.mock('../lib/runEvidence.js', () => ({ recordActivityEvidence: vi.fn() }));
vi.mock('../lib/activityLog.js', () => ({ auditLog: vi.fn() }));
vi.mock('./mcpScreen.js', () => ({ screenMcpResult: vi.fn() }));

import { createMastraBrowserTools } from './browserTools.js';

const USAGE = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

describe('Mastra browser screenshot images', () => {
  it('includes the returned image part in the prompt following a screenshot tool call', async () => {
    const base64 = Buffer.from('jpeg-bytes').toString('base64');
    const prompts: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }: { prompt: unknown }) => {
        prompts.push(prompt);
        call += 1;
        return call === 1
          ? {
              content: [
                {
                  input: JSON.stringify({ caption: 'After login' }),
                  toolCallId: 'screenshot-1',
                  toolName: 'browser_screenshot',
                  type: 'tool-call',
                },
              ],
              finishReason: { raw: 'tool_use', unified: 'tool-calls' },
              usage: USAGE,
              warnings: [],
            }
          : {
              content: [{ text: 'The page is ready.', type: 'text' }],
              finishReason: { raw: 'stop', unified: 'stop' },
              usage: USAGE,
              warnings: [],
            };
      },
    } as never);
    const tools = createMastraBrowserTools({
      call: vi.fn(async () => ({
        image: { data: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' as const },
        text: '{"evidenceId":"e-1"}',
      })),
    } as never);
    const agent = new Agent({
      id: 'browser-image-test',
      instructions: 'Inspect the screenshot.',
      model,
      name: 'browser-image-test',
      tools,
    });

    await agent.generate([{ content: 'Take a screenshot.', role: 'user' }], { maxSteps: 2 });

    const followUpPrompt = JSON.stringify(prompts[1]);
    expect(followUpPrompt).toContain(base64);
    expect(followUpPrompt).toContain('"mediaType":"image/jpeg"');
    expect(followUpPrompt).toContain('"type":"file"');
  });
});
