/** Resolve after `ms` milliseconds. The one sleep every polling command shares. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
