'use strict';
/**
 * Boot the real UI in a headless Chromium and fail on any uncaught error.
 *
 * With no build step, a bad import order surfaces only at page load — as a
 * ReferenceError from whichever module lost the cycle race — and the static
 * graph test cannot see it (it checks that names resolve, not the order the
 * bodies run in). Skipped when no Chromium/Chrome binary is installed; still
 * zero npm dependencies.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const { startTarka } = require('./helpers/harness');

function findBrowser() {
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    try {
      const p = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
        .split('\n')[0];
      if (p) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

const browser = findBrowser();

test('the UI boots in a headless browser without an uncaught error', { skip: !browser && 'no Chromium on PATH' }, async () => {
  const tarka = await startTarka();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tarka-headless-'));
  try {
    const run = spawnSync(
      browser,
      [
        '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`,
        '--enable-logging=stderr', '--v=0', '--virtual-time-budget=5000', '--dump-dom',
        `${tarka.origin}/`
      ],
      { encoding: 'utf8', timeout: 40000 }
    );
    const consoleLines = String(run.stderr || '').split('\n').filter((l) => l.includes('CONSOLE'));
    const errors = consoleLines.filter((l) => /Uncaught|ReferenceError|TypeError|SyntaxError|Refused to/.test(l));
    assert.deepEqual(errors, [], 'page-load console errors');
    const dom = String(run.stdout || '');
    assert.match(dom, /class="welcome"/, 'the boot sequence must have rendered the welcome');
    assert.match(dom, /aria-pressed=/, 'syncRail must have run');
  } finally {
    await tarka.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
