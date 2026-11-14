/// A Docker memory value: digits and an optional binary unit (`4g`, `512m`, a bare byte count).
export const DOCKER_MEMORY_RE = /^\d+[bkmg]?$/i;

const MEMORY_UNITS: Record<string, number> = { b: 1, g: 1024 ** 3, k: 1024, m: 1024 ** 2 };

/// The size of a Docker memory string in bytes (`g` is GiB, as is a Kubernetes `Gi`), or `null`
/// when it is not one. Pure, so a schema can range-check a value without importing worker code.
export function parseDockerMemoryBytes(memory: string): number | null {
  const match = DOCKER_MEMORY_RE.exec(memory);
  if (!match) {
    return null;
  }
  const unit = /[bkmg]$/i.exec(memory)?.[0].toLowerCase() ?? 'b';
  return Number.parseInt(memory, 10) * (MEMORY_UNITS[unit] ?? 1);
}
