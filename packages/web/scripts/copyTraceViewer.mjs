import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('playwright-core/package.json');
const source = resolve(dirname(packageJsonPath), 'lib/vite/traceViewer');
const target = fileURLToPath(new URL('../public/trace-viewer', import.meta.url));

await rm(target, { force: true, recursive: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
