import { describe, expect, it } from 'vitest';
import { DOCKER_MEMORY_RE, parseDockerMemoryBytes } from './dockerMemory.js';

describe('parseDockerMemoryBytes', () => {
  it('reads binary units and bare byte counts', () => {
    expect(parseDockerMemoryBytes('4g')).toBe(4 * 1024 ** 3);
    expect(parseDockerMemoryBytes('512M')).toBe(512 * 1024 ** 2);
    expect(parseDockerMemoryBytes('64k')).toBe(64 * 1024);
    expect(parseDockerMemoryBytes('1048576')).toBe(1048576);
    expect(parseDockerMemoryBytes('7b')).toBe(7);
  });

  it('returns null for anything the regex refuses', () => {
    for (const bad of ['4gb', '', '4g --privileged', '-1g', '1.5g']) {
      expect(DOCKER_MEMORY_RE.test(bad)).toBe(false);
      expect(parseDockerMemoryBytes(bad)).toBeNull();
    }
  });
});
