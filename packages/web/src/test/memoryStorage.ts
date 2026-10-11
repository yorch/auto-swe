import { vi } from 'vitest';

/** A Map-backed Storage: Node's own `localStorage` global can shadow jsdom's with `undefined`. */
class MemoryStorage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
}

/**
 * Installs a working `localStorage` (and a `Storage` class to spy on) for one test. Pair with
 * `vi.unstubAllGlobals()` in `afterEach`, so a test that asserts persistence behaves the same on
 * every runtime instead of depending on which storage the runtime happens to expose.
 */
export function installMemoryStorage(): void {
  vi.stubGlobal('Storage', MemoryStorage);
  vi.stubGlobal('localStorage', new MemoryStorage());
}
