import { SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('@auto-swe/shared', '0.1.0');

export interface AtlassianClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class AtlassianError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: 'auth' | 'not_found' | 'rate_limited' | 'server' | 'network',
    message: string
  ) {
    super(message);
    this.name = 'AtlassianError';
  }
}

export class AtlassianClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly authHeader: string;

  constructor(private readonly config: AtlassianClientConfig) {
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.maxRetries = config.maxRetries ?? 3;
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, undefined);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const url = `${base}${path}`;

    return tracer.startActiveSpan(`atlassian.${method} ${path}`, async (span) => {
      span.setAttributes({
        'http.method': method.toUpperCase(),
        'http.url': url,
        'tracker.operation': path,
        'tracker.provider': 'atlassian',
      });

      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          Authorization: this.authHeader,
        };
        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
        }

        let lastError: AtlassianError | null = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
          if (attempt > 0) {
            const delayMs = Math.min(1000 * 2 ** (attempt - 1), 16000) + Math.random() * 500;
            await new Promise((r) => setTimeout(r, delayMs));
          }
          try {
            const res = await fetch(url, {
              body: body !== undefined ? JSON.stringify(body) : undefined,
              headers,
              method,
              signal: AbortSignal.timeout(this.timeoutMs),
            });

            span.setAttribute('http.status_code', res.status);

            if (res.status === 429) {
              const raw = res.headers.get('Retry-After') ?? '5';
              let retryAfter = Number(raw);
              if (Number.isNaN(retryAfter)) {
                const date = Date.parse(raw);
                retryAfter = Number.isNaN(date)
                  ? 60
                  : Math.max(0, Math.ceil((date - Date.now()) / 1000));
              }
              await new Promise((r) => setTimeout(r, retryAfter * 1000));
              lastError = new AtlassianError(
                429,
                'rate_limited',
                `Rate limited by Atlassian (Retry-After: ${retryAfter}s)`
              );
              continue;
            }
            if (res.status === 401 || res.status === 403) {
              throw new AtlassianError(res.status, 'auth', `Atlassian auth failed: ${res.status}`);
            }
            if (res.status === 404) {
              throw new AtlassianError(404, 'not_found', `Atlassian resource not found: ${path}`);
            }
            if (res.status >= 500) {
              lastError = new AtlassianError(
                res.status,
                'server',
                `Atlassian server error: ${res.status}`
              );
              continue;
            }
            if (!res.ok) {
              throw new AtlassianError(
                res.status,
                'server',
                `Atlassian request failed: ${res.status}`
              );
            }
            const data = await res.json();
            return data as T;
          } catch (err) {
            if (err instanceof AtlassianError) {
              throw err;
            }
            lastError = new AtlassianError(0, 'network', String(err));
          }
        }
        throw lastError ?? new AtlassianError(0, 'network', 'Request failed after retries');
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
