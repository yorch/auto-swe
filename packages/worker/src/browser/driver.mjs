import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (error) {
    try {
      return require('playwright-core');
    } catch {
      throw error;
    }
  }
}

function parseArgs(args) {
  const result = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key?.startsWith('--')) {
      positional.push(key);
      continue;
    }
    if (args[i + 1] === undefined || args[i + 1]?.startsWith('--')) {
      throw new Error(`invalid argument: ${key}`);
    }
    result[key.slice(2)] = args[i + 1];
    i++;
  }
  return { ...result, positional };
}

function normalizeHost(host) {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function matchesHost(host, patterns) {
  const normalized = normalizeHost(host);
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(normalized)) {
    return true;
  }
  return patterns.some((pattern) => {
    const item = normalizeHost(pattern);
    if (item.startsWith('*.')) {
      const suffix = item.slice(2);
      return normalized !== suffix && normalized.endsWith(`.${suffix}`);
    }
    return normalized === item;
  });
}

function isAllowedUrl(rawUrl, allowedHosts) {
  if (/^(?:data|blob|about):/i.test(rawUrl)) {
    return true;
  }
  try {
    const url = new URL(rawUrl);
    return ['http:', 'https:'].includes(url.protocol) && matchesHost(url.hostname, allowedHosts);
  } catch {
    return false;
  }
}

function proxyConfig(configuredProxy) {
  const server =
    configuredProxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!server) {
    return undefined;
  }
  const url = new URL(server);
  const result = {
    bypass: 'localhost,127.0.0.1,::1',
    server: `${url.protocol}//${url.host}`,
  };
  if (url.username || url.password) {
    return {
      ...result,
      password: decodeURIComponent(url.password),
      username: decodeURIComponent(url.username),
    };
  }
  return result;
}

function createEvents() {
  return { blocked: [], console: [], failedRequests: [], pageErrors: [] };
}

function clippedText(value) {
  return String(value).slice(0, 2000);
}

function addEvent(events, key, value) {
  if (events[key].length < 200) {
    events[key].push(value);
  }
}

function inOutputDir(outDir, requestedPath) {
  const resolved = path.resolve(outDir, requestedPath);
  if (resolved !== outDir && !resolved.startsWith(`${outDir}${path.sep}`)) {
    throw new Error('output path must be inside --out');
  }
  return resolved;
}

function errorText(error) {
  return clippedText(error instanceof Error ? error.message : String(error));
}

async function startDriver(options) {
  const socketPath = path.resolve(options.socket);
  const outDir = path.resolve(options.out);
  const config = JSON.parse(options.config);
  const allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
  const viewport = config.viewport ?? { height: 800, width: 1280 };
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < 1 ||
    !Number.isInteger(viewport.height) ||
    viewport.height < 1
  ) {
    throw new Error('viewport width and height must be positive integers');
  }

  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rm(socketPath, { force: true });

  const { chromium } = loadPlaywright();
  const proxy = proxyConfig(config.proxy);
  const browser = await chromium.launch({
    args: ['--disable-dev-shm-usage'],
    chromiumSandbox: false,
    headless: true,
    ...(proxy ? { proxy } : {}),
  });
  const context = await browser.newContext({
    viewport,
    ...(config.recordVideo
      ? { recordVideo: { dir: outDir, size: { height: viewport.height, width: viewport.width } } }
      : {}),
  });
  if (config.trace) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }
  let events = createEvents();
  let screenshotCount = 0;
  let shuttingDown = false;
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      addEvent(events, 'console', { text: clippedText(message.text()), type: message.type() });
    }
  });
  page.on('pageerror', (error) => addEvent(events, 'pageErrors', clippedText(error.message)));
  page.on('requestfailed', (request) => {
    addEvent(events, 'failedRequests', {
      failure: clippedText(request.failure()?.errorText ?? 'request failed'),
      url: clippedText(request.url()),
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      addEvent(events, 'failedRequests', {
        status: response.status(),
        url: clippedText(response.url()),
      });
    }
  });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isAllowedUrl(url, allowedHosts)) {
      await route.continue();
      return;
    }
    addEvent(events, 'blocked', { type: 'blocked', url: clippedText(url) });
    await route.abort('blockedbyclient');
  });

  async function closeBrowser() {
    const video = page.video();
    let traceFile;
    let failure;
    try {
      if (config.trace) {
        traceFile = path.join(outDir, 'trace.zip');
        await context.tracing.stop({ path: traceFile });
      }
    } catch (error) {
      failure = error;
    }
    try {
      await context.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await browser.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      throw failure;
    }
    const videoFile = video ? await video.path() : undefined;
    return {
      ...(videoFile ? { video: videoFile } : {}),
      ...(traceFile ? { trace: traceFile } : {}),
    };
  }

  async function runCommand(command) {
    if (!command || typeof command !== 'object' || typeof command.cmd !== 'string') {
      throw new Error('command must be a JSON object with a cmd string');
    }
    const timeoutMs = command.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error('timeoutMs must be an integer from 1 to 120000');
    }
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    switch (command.cmd) {
      case 'goto': {
        if (typeof command.url !== 'string') {
          throw new Error('goto requires a url');
        }
        const waitUntil = command.waitUntil ?? 'load';
        if (!['commit', 'domcontentloaded', 'load', 'networkidle'].includes(waitUntil)) {
          throw new Error('goto waitUntil must be a Playwright load state');
        }
        const response = await page.goto(command.url, { waitUntil });
        return { status: response?.status() ?? null, title: await page.title(), url: page.url() };
      }
      case 'click':
        await page.locator(command.selector).click();
        return {};
      case 'fill':
        await page.locator(command.selector).fill(command.value);
        return {};
      case 'press':
        if (command.selector) {
          await page.locator(command.selector).press(command.key);
        } else {
          await page.keyboard.press(command.key);
        }
        return {};
      case 'select':
        await page.locator(command.selector).selectOption(command.value);
        return {};
      case 'hover':
        await page.locator(command.selector).hover();
        return {};
      case 'wait': {
        let waited = false;
        if (command.selector) {
          await page.locator(command.selector).waitFor();
          waited = true;
        }
        if (command.text) {
          await page.getByText(command.text).waitFor();
          waited = true;
        }
        if (command.ms !== undefined) {
          if (!Number.isInteger(command.ms) || command.ms < 0 || command.ms > 30_000) {
            throw new Error('wait ms must be an integer from 0 to 30000');
          }
          await new Promise((resolve) => setTimeout(resolve, command.ms));
          waited = true;
        }
        if (!waited) {
          throw new Error('wait requires selector, text, or ms');
        }
        return {};
      }
      case 'snapshot': {
        const aria = await page.locator('body').ariaSnapshot();
        return {
          aria: aria.slice(0, 20_000),
          title: await page.title(),
          url: page.url(),
        };
      }
      case 'screenshot': {
        const requestedPath = command.path ?? `screenshot-${++screenshotCount}.png`;
        const file = inOutputDir(outDir, requestedPath);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await page.screenshot({ fullPage: Boolean(command.fullPage), path: file, type: 'png' });
        const size = command.fullPage
          ? await page.evaluate(() => ({
              height: document.documentElement.scrollHeight,
              width: document.documentElement.scrollWidth,
            }))
          : page.viewportSize();
        return { file, height: size?.height ?? 0, url: page.url(), width: size?.width ?? 0 };
      }
      case 'events': {
        const drained = events;
        events = createEvents();
        return drained;
      }
      case 'close': {
        shuttingDown = true;
        return closeBrowser();
      }
      default:
        throw new Error(`unknown browser command: ${command.cmd}`);
    }
  }

  const server = net.createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline === -1) {
        return;
      }
      socket.removeAllListeners('data');
      let response;
      try {
        response = { ok: true, ...(await runCommand(JSON.parse(input.slice(0, newline)))) };
      } catch (error) {
        response = { error: errorText(error), ok: false };
      }
      socket.end(`${JSON.stringify(response)}\n`, () => {
        if (shuttingDown) {
          server.close(async () => {
            await fs.rm(socketPath, { force: true });
            process.exit(0);
          });
        }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function callDriver(options, requestJson) {
  const socket = net.createConnection(options.socket);
  let output = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(`${requestJson}\n`));
  socket.on('data', (chunk) => {
    output += chunk;
    const newline = output.indexOf('\n');
    if (newline !== -1) {
      try {
        process.stdout.write(`${JSON.stringify(JSON.parse(output.slice(0, newline)))}\n`);
        socket.destroy();
      } catch (error) {
        process.stderr.write(`invalid driver response: ${errorText(error)}\n`);
        process.exitCode = 1;
        socket.destroy();
      }
    }
  });
  socket.on('error', (error) => {
    process.stderr.write(`browser driver transport failed: ${errorText(error)}\n`);
    process.exitCode = 1;
  });
  await new Promise((resolve) => socket.once('close', resolve));
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  if (action === 'serve') {
    await startDriver(options);
  } else if (action === 'call') {
    const requestJson = options.positional[0];
    if (!requestJson) {
      throw new Error('call requires a JSON command argument');
    }
    await callDriver(options, requestJson);
  } else {
    throw new Error('expected serve or call');
  }
}

main().catch((error) => {
  process.stderr.write(`${errorText(error)}\n`);
  process.exitCode = 1;
});
