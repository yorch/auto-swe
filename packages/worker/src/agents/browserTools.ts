import { resolveSetting } from '@auto-swe/shared/config/resolveSetting';
import { prisma } from '@auto-swe/shared/db';
import { type PreviewConfig, PreviewConfigSchema } from '@auto-swe/shared/lib/previewConfig';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { BrowserSession } from '../browser/session.js';
import { auditLog } from '../lib/activityLog.js';
import { type AgentTracer, redactString } from '../lib/agentTracer.js';
import { recordActivityEvidence } from '../lib/runEvidence.js';
import { screenMcpResult } from './mcpScreen.js';

export interface BrowserToolContext {
  ensureSession(): Promise<BrowserSession>;
  startApp(): Promise<string>;
  saveScreenshot(input: {
    caption: string;
    filePath: string;
    fullPage: boolean;
    width?: number;
    height?: number;
    pageUrl: string;
    session: BrowserSession;
  }): Promise<{
    evidenceId: string;
    width?: number;
    height?: number;
    ariaSnapshot: string;
    image: Buffer;
  }>;
}

type BrowserTool<A extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  schema: A;
  run(session: BrowserToolContext, args: z.infer<A>): Promise<{ text: string; image?: Buffer }>;
};

function textResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

export const BROWSER_TOOLS = [
  {
    description: 'Start the configured app preview, if one exists.',
    name: 'browser_start_app',
    async run(session) {
      return { text: await session.startApp() };
    },
    schema: z.object({}),
  },
  {
    description: 'Navigate to a URL in the app browser.',
    name: 'browser_navigate',
    async run(session, args) {
      const result = await (await session.ensureSession()).call({ cmd: 'goto', url: args.url });
      return { text: textResult(result) };
    },
    schema: z.object({ url: z.string().url() }),
  },
  {
    description: 'Click a page element by selector.',
    name: 'browser_click',
    async run(session, args) {
      const result = await (await session.ensureSession()).call({
        cmd: 'click',
        selector: args.selector,
      });
      return { text: textResult(result) };
    },
    schema: z.object({ selector: z.string().min(1) }),
  },
  {
    description: 'Fill a page field by selector.',
    name: 'browser_fill',
    async run(session, args) {
      const result = await (await session.ensureSession()).call({
        cmd: 'fill',
        selector: args.selector,
        value: args.value,
      });
      return { text: textResult(result) };
    },
    schema: z.object({ selector: z.string().min(1), value: z.string() }),
  },
  {
    description: 'Press a key, optionally scoped to a selector.',
    name: 'browser_press',
    async run(session, args) {
      const result = await (await session.ensureSession()).call({
        cmd: 'press',
        key: args.key,
        ...(args.selector ? { selector: args.selector } : {}),
      });
      return { text: textResult(result) };
    },
    schema: z.object({ key: z.string().min(1), selector: z.string().optional() }),
  },
  {
    description: 'Select an option by selector and value.',
    name: 'browser_select',
    async run(session, args) {
      const result = await (await session.ensureSession()).call({
        cmd: 'select',
        selector: args.selector,
        value: args.value,
      });
      return { text: textResult(result) };
    },
    schema: z.object({ selector: z.string().min(1), value: z.string() }),
  },
  {
    description: 'Wait for a selector, text, or a bounded number of milliseconds.',
    name: 'browser_wait',
    async run(session, args) {
      const result = await (await session.ensureSession()).call({ cmd: 'wait', ...args });
      return { text: textResult(result) };
    },
    schema: z.object({
      ms: z.number().int().min(0).max(30_000).optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
    }),
  },
  {
    description: 'Return the current page URL, title and accessible page snapshot.',
    name: 'browser_snapshot',
    async run(session) {
      const result = await (await session.ensureSession()).call({ cmd: 'snapshot' });
      return { text: textResult(result) };
    },
    schema: z.object({}),
  },
  {
    description: 'Save a screenshot as run evidence and return its id and page snapshot.',
    name: 'browser_screenshot',
    async run(context, args: { caption: string; fullPage?: boolean }) {
      const session = await context.ensureSession();
      const shot = await session.call({ cmd: 'screenshot', fullPage: args.fullPage ?? false });
      if (!shot.ok || typeof shot.file !== 'string') {
        throw new Error(shot.error ?? 'Browser screenshot failed');
      }
      const saved = await context.saveScreenshot({
        caption: args.caption,
        filePath: shot.file,
        fullPage: args.fullPage ?? false,
        height: typeof shot.height === 'number' ? shot.height : undefined,
        pageUrl: typeof shot.url === 'string' ? shot.url : '',
        session,
        width: typeof shot.width === 'number' ? shot.width : undefined,
      });
      return {
        image: saved.image,
        text: JSON.stringify({
          ariaSnapshot: saved.ariaSnapshot,
          evidenceId: saved.evidenceId,
          height: saved.height,
          pageUrl: shot.url,
          width: saved.width,
        }),
      };
    },
    schema: z.object({ caption: z.string().min(1), fullPage: z.boolean().optional() }),
  },
  {
    description: 'Inspect console, page errors and failed requests from the browser.',
    name: 'browser_console',
    async run(session) {
      const result = await (await session.ensureSession()).call({ cmd: 'events' });
      return { text: textResult(result) };
    },
    schema: z.object({}),
  },
] satisfies BrowserTool[];

export type BrowserToolName = (typeof BROWSER_TOOLS)[number]['name'];

export interface BrowserToolsetOptions {
  workspace: Workspace;
  repoId: string;
  tracer: AgentTracer;
  containerId: string;
}

export class BrowserToolset implements BrowserToolContext {
  private closed = false;
  private browser?: BrowserSession;
  private sessionPromise?: Promise<BrowserSession>;
  private previewConfig?: z.infer<typeof PreviewConfigSchema> | null;
  private preview?: Awaited<ReturnType<typeof import('../lib/appPreview.js')['startAppPreview']>>;
  private previewPromise?: Promise<
    Awaited<ReturnType<typeof import('../lib/appPreview.js')['startAppPreview']>>
  >;
  private closing = false;
  private readonly evidenceIds: string[] = [];

  constructor(private readonly options: BrowserToolsetOptions) {}

  async ensureSession(): Promise<BrowserSession> {
    if (this.closing) {
      throw new Error('Browser toolset is closing');
    }
    // Memoize the in-flight start: an agent may issue several tool calls in one
    // step, and two concurrent starts would leave one session unreachable from
    // `close()`, losing its recording and trace.
    if (!this.sessionPromise) {
      const starting = (async () => {
        await this.loadPreviewConfig();
        return BrowserSession.start(this.options.workspace, {
          allowedHosts: this.previewConfig?.allowedHosts ?? [],
          maxVideoBytes: await resolveSetting('uiValidation.maxVideoBytes'),
          recordVideo: await resolveSetting('uiValidation.agentRecordVideo'),
          trace: true,
        });
      })();
      this.sessionPromise = starting;
      starting.catch(() => {
        if (this.sessionPromise === starting) {
          this.sessionPromise = undefined;
        }
      });
    }
    return this.sessionPromise;
  }

  async startApp(): Promise<string> {
    if (this.closing) {
      throw new Error('Browser toolset is closing');
    }
    await this.loadPreviewConfig();
    if (!this.previewConfig) {
      await this.ensureSession();
      return 'No app preview is configured. Start the server with bash, then pass its URL to browser_navigate.';
    }
    if (!this.previewPromise) {
      const starting = (async () => {
        const { startAppPreview } = await import('../lib/appPreview.js');
        return startAppPreview(this.options.workspace, this.previewConfig as PreviewConfig);
      })();
      this.previewPromise = starting;
      starting.catch(() => {
        if (this.previewPromise === starting) {
          this.previewPromise = undefined;
        }
      });
    }
    this.preview = await this.previewPromise;
    await this.ensureSession();
    return `App preview ready at ${this.preview.baseUrl}`;
  }

  async saveScreenshot(input: {
    caption: string;
    filePath: string;
    fullPage: boolean;
    pageUrl: string;
    session: BrowserSession;
    width?: number;
    height?: number;
  }) {
    const [image, snapshot] = await Promise.all([
      input.session.readOutFile(input.filePath, 10_000_000),
      input.session.call({ cmd: 'snapshot' }),
    ]);
    const ariaSnapshot = await screenText(
      textResult(snapshot),
      'browser_screenshot',
      this.options.tracer
    );
    const saved = await recordActivityEvidence(
      {
        body: image,
        caption: input.caption,
        contentType: 'image/png',
        height: input.height,
        kind: 'screenshot',
        pageUrl: input.pageUrl,
        source: 'agent',
        width: input.width,
      },
      this.options.tracer
    );
    if (!saved.ok) {
      throw new Error(`Unable to save browser screenshot evidence: ${saved.reason}`);
    }
    this.evidenceIds.push(saved.evidenceId);
    return {
      ariaSnapshot,
      evidenceId: saved.evidenceId,
      height: input.height,
      image,
      width: input.width,
    };
  }

  async call(name: BrowserToolName, args: unknown): Promise<{ text: string; image?: Buffer }> {
    const entry = BROWSER_TOOLS.find((tool) => tool.name === name);
    if (!entry) {
      throw new Error(`Browser tool is not available: ${name}`);
    }
    const started = Date.now();
    let parsed: unknown = args;
    auditLog(
      `[browser:audit] container=${redactString(this.options.containerId)} tool=${name} url/selector=${redactString(JSON.stringify(args)).slice(0, 1000)}`
    );
    try {
      parsed = entry.schema.parse(args);
      const result: { text: string; image?: Buffer } = await entry.run(this, parsed as never);
      const screened = await screenText(result.text, name, this.options.tracer);
      this.options.tracer.addToolCall({
        durationMs: Date.now() - started,
        inputJson: parsed as Record<string, unknown>,
        outputJson: screened,
        toolName: `browser:${name}`,
      });
      return { text: screened, ...(result.image ? { image: result.image } : {}) };
    } catch (error) {
      this.options.tracer.addToolCall({
        durationMs: Date.now() - started,
        error: redactString(error instanceof Error ? error.message : String(error)),
        inputJson: parsed as Record<string, unknown>,
        toolName: `browser:${name}`,
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.closing) {
      return;
    }
    this.closing = true;
    try {
      // A start that is still in flight when the session ends would otherwise
      // outlive cleanup: wait for it so its recording and trace are persisted.
      this.browser ??= await this.sessionPromise?.catch(() => undefined);
      this.preview ??= await this.previewPromise?.catch(() => undefined);
      const outputs = await this.browser?.close();
      for (const message of outputs?.errors ?? []) {
        this.options.tracer.addActivityEvent({
          name: 'ui.evidence_unavailable',
          outputJson: { error: message },
        });
      }
      if (outputs?.video) {
        const saved = await recordActivityEvidence(
          {
            body: outputs.video,
            caption: 'Agent browser session recording',
            contentType: 'video/webm',
            kind: 'video',
            source: 'agent',
          },
          this.options.tracer
        );
        if (saved.ok) {
          this.evidenceIds.push(saved.evidenceId);
        }
      }
      if (outputs?.trace) {
        const saved = await recordActivityEvidence(
          {
            body: outputs.trace,
            caption: 'Agent browser trace',
            contentType: 'application/zip',
            kind: 'trace',
            source: 'agent',
          },
          this.options.tracer
        );
        if (saved.ok) {
          this.evidenceIds.push(saved.evidenceId);
        }
      }
    } finally {
      await this.preview?.stop();
    }
  }

  private async loadPreviewConfig(): Promise<void> {
    if (this.previewConfig !== undefined) {
      return;
    }
    const repo = await prisma.connection.findUnique({
      select: { previewConfig: true },
      where: { id: this.options.repoId },
    });
    const parsed = PreviewConfigSchema.safeParse(repo?.previewConfig);
    this.previewConfig = parsed.success ? parsed.data : null;
  }
}

async function screenText(text: string, name: string, tracer: AgentTracer): Promise<string> {
  const result = await screenMcpResult(text, name, tracer);
  return result.blocked ? result.message : textResult(result.result);
}

export function createMastraBrowserTools(toolset: BrowserToolset) {
  return Object.fromEntries(
    BROWSER_TOOLS.map((entry) => [
      entry.name,
      createTool({
        description: entry.description,
        execute: async (args) => ({ text: (await toolset.call(entry.name, args)).text }),
        id: entry.name,
        inputSchema: entry.schema,
      }),
    ])
  );
}
