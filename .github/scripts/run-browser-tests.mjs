// Runs oreilly-epub-extension/tests/test-runner.html in headless Chromium and
// exits non-zero unless every registered test passes.
//
// The in-page runner only counts tests whose suite registered, so a test file
// that 404s or throws while loading would silently shrink the suite and still
// report "N passed, 0 failed". Failed same-origin requests and uncaught page
// errors are therefore treated as failures too.
//
// Usage: node .github/scripts/run-browser-tests.mjs
//   PLAYWRIGHT_CHANNEL=chrome  use an installed Chrome instead of the bundled Chromium

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER_PATH = '/oreilly-epub-extension/tests/test-runner.html';
const TIMEOUT_MS = 180_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const filePath = path.resolve(ROOT, '.' + urlPath);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const problems = [];
  let browser;

  // Everything after the server starts sits inside try/finally: an open
  // server keeps Node alive, so a failed launch would otherwise hang the job.
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
    const page = await browser.newPage();
    page.on('pageerror', err => problems.push(`Uncaught page error: ${err.message}`));
    page.on('response', res => {
      if (res.url().startsWith(origin) && res.status() >= 400) {
        problems.push(`HTTP ${res.status()} for ${res.url().slice(origin.length)}`);
      }
    });
    page.on('requestfailed', req => {
      if (req.url().startsWith(origin)) {
        problems.push(`Request failed for ${req.url().slice(origin.length)}: ${req.failure()?.errorText}`);
      }
    });

    await page.goto(origin + RUNNER_PATH);
    await page.waitForFunction(
      () => /^\d+ passed, \d+ failed$/.test(document.getElementById('summary')?.textContent || ''),
      null,
      { timeout: TIMEOUT_MS },
    );

    const { summary, failures } = await page.evaluate(() => ({
      summary: document.getElementById('summary').textContent,
      failures: [...document.querySelectorAll('#output .result.fail')].map(el => el.textContent),
    }));
    const [passed, failed] = summary.match(/\d+/g).map(Number);

    console.log(summary);
    for (const line of failures) console.log(`  ${line}`);
    for (const line of problems) console.log(`  ${line}`);

    if (failed > 0 || passed === 0 || problems.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
