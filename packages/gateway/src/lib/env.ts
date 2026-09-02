const DEFAULT_ORIGIN = 'http://localhost:3000';
const DEFAULT_PORT = 8080;

export function getCorsOrigins(): string[] {
  return process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) ?? [DEFAULT_ORIGIN];
}

export function getDefaultClientOrigin(): string {
  return getCorsOrigins()[0] ?? DEFAULT_ORIGIN;
}

export function getPort(): number {
  const raw = process.env.PORT;
  if (!raw) {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    return DEFAULT_PORT;
  }
  return parsed;
}
