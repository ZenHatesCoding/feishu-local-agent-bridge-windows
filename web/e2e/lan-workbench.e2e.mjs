/**
 * End-to-end smoke: real browser (headless chromium) against the real LAN
 * center + fake workers, served from the built workbench bundle.
 *
 * Skips (exit 0) when playwright or its browser binaries are unavailable.
 * Requires the root project to be built (`pnpm build` in the repo root) so
 * dist/index.js exports LanSimTopology.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP: playwright is not installed (web/pnpm install)');
  process.exit(0);
}

const steps = [];
function step(name) {
  steps.push(name);
  console.log(`[e2e] ${name}`);
}
/** Poll until the condition holds (default 10s deadline). */
async function expectCondition(description, fn, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`E2E FAILED at "${description}": ${err && err.message ? err.message : err}`);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`E2E FAILED at "${description}": condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let dataDir;
let topology;
let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.log(`SKIP: chromium unavailable (${err && err.message ? err.message.split('\n')[0] : err})`);
  process.exit(0);
}

try {
  const { LanSimTopology } = await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
  dataDir = await mkdtemp(join(tmpdir(), 'lan-e2e-'));
  topology = await LanSimTopology.start({
    dataDir,
    webDir: join(root, 'web', 'dist'),
    port: 48999,
    nodes: [
      { agentId: 'alpha', displayName: 'Alpha' },
      {
        agentId: 'beta',
        displayName: 'Beta',
        script: [
          { delayMs: 100, status: '分析中' },
          { delayMs: 200, text: 'E2E 回答：迁移窗口已确认。' },
        ],
      },
    ],
  });
  step('topology started');

  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[browser-error] ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    console.log(`[request-failed] ${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });
  await page.goto(topology.url, { waitUntil: 'networkidle' });
  await expectCondition('login form visible', () => page.locator('.login-card input').first().isVisible());

  await page.locator('.login-card input').first().fill(topology.ownerUsername);
  await page.locator('.login-card input[type="password"]').fill(topology.ownerPassword);
  await page.locator('.login-card button[type="submit"]').click();
  await expectCondition('workbench after login', () => page.locator('.workbench').isVisible());
  step('logged in');

  await page.locator('.new-conversation input').fill('E2E 验收会话');
  await page.locator('.new-conversation button[type="submit"]').click();
  await expectCondition('conversation appears in sidebar', async () =>
    (await page.locator('.conversation-list .title', { hasText: 'E2E 验收会话' }).count()) > 0);
  step('conversation created');

  await page.locator('.composer textarea').fill('请确认迁移窗口。');
  await page.locator('.composer-agents .chip', { hasText: '@Beta' }).click();
  await page.locator('.composer button.primary').click();
  try {
    await expectCondition('user message appears', async () =>
      (await page.locator('.bubble.user p', { hasText: '请确认迁移窗口。' }).count()) > 0);
  } catch (err) {
    const toast = await page.locator('.error-toast').textContent().catch(() => '(no toast)');
    const bubbles = await page.locator('.bubble').count().catch(() => -1);
    const streamStatus = await page.locator('.stream').textContent().catch(() => '(none)');
    console.error(`[e2e] diagnostic: toast="${toast}" bubbles=${bubbles} stream="${streamStatus}"`);
    throw err;
  }
  step('message sent with @Beta mention');

  await expectCondition('agent answer appears', async () =>
    (await page.locator('.bubble.agent p', { hasText: 'E2E 回答' }).count()) > 0, { timeoutMs: 15000 });
  step('beta answered via structured action');

  await expectCondition('run block streamed', async () =>
    (await page.locator('.run-block').count()) > 0);
  try {
    await expectCondition('dispatch completed in task panel', async () =>
      (await page.locator('.dispatch-status.status-completed').count()) > 0, { timeoutMs: 10000 });
  } catch (err) {
    const statuses = await page.locator('.dispatch-status').allTextContents().catch(() => []);
    console.error(`[e2e] diagnostic: dispatch statuses=${JSON.stringify(statuses)}`);
    throw err;
  }
  step('dispatch completed in task panel');

  // File upload round trip.
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.locator('.composer-actions .ghost', { hasText: '附件' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'e2e-report.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('e2e attachment payload\n', 'utf8'),
  });
  await expectCondition('file card in task panel', async () =>
    (await page.locator('.file-card .file-name', { hasText: 'e2e-report.txt' }).count()) > 0);
  step('file uploaded and listed');

  console.log(`[e2e] PASS (${steps.length} steps)`);
} catch (err) {
  console.error(`[e2e] ${err.message}`);
  console.error('[e2e] completed steps:', steps.join(' | '));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (topology) await topology.stop().catch(() => {});
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
