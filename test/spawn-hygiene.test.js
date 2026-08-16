'use strict';
/**
 * Spawn-env scrub and orthogonal exit facts — the shipped helpers Project
 * exec and local-agent spawn actually call. A re-implementation here is not
 * evidence.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { scrubSpawnEnv, commandExitFacts, SECRET_ENV_RE } = require('../lib/spawn-hygiene');
const exec = require('../lib/project/exec');

test('scrubSpawnEnv drops KEY/SECRET/TOKEN/PASSWORD names and keeps PATH', () => {
  const out = scrubSpawnEnv({
    PATH: '/usr/bin',
    HOME: '/home/you',
    LANG: 'C',
    OPENAI_API_KEY: 'sk-secret',
    ANTHROPIC_API_KEY: 'sk-ant',
    GITHUB_TOKEN: 'ghp_x',
    AWS_SECRET_ACCESS_KEY: 'wxyz',
    DB_PASSWORD: 'hunter2',
    MY_TOKENIZER_UNUSED: 'drop-me-too',
    TERM: 'xterm'
  });
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/you');
  assert.equal(out.LANG, 'C');
  assert.equal(out.TERM, 'xterm');
  assert.equal(out.OPENAI_API_KEY, undefined);
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(out.DB_PASSWORD, undefined);
  assert.ok(SECRET_ENV_RE.test('OPENAI_API_KEY'));
  assert.ok(!SECRET_ENV_RE.test('PATH'));
});

test('commandExitFacts (lib) does not collapse a timeout into a plain success', () => {
  assert.equal(commandExitFacts({ exitCode: 0 }).cleanSuccess, true);
  assert.equal(commandExitFacts({ timedOut: true, exitCode: 0 }).cleanSuccess, false);
  assert.equal(commandExitFacts({ signal: 'SIGTERM', exitCode: 0 }).cleanSuccess, false);
  const f = commandExitFacts({ timedOut: true, signal: 'SIGKILL', exitCode: 0, aborted: false });
  assert.equal(f.timedOut, true);
  assert.equal(f.signal, 'SIGKILL');
  assert.equal(f.exitCode, 0);
});

test('project exec and local-agent spawn call the shipped scrub', () => {
  const execSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'project', 'exec.js'), 'utf8');
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local-agents.js'), 'utf8');
  assert.match(execSrc, /scrubSpawnEnv/);
  assert.match(execSrc, /commandExitFacts/);
  assert.match(agentSrc, /scrubSpawnEnv/);
  assert.equal(typeof exec.scrubSpawnEnv, 'function');
  assert.equal(typeof exec.commandExitFacts, 'function');
  assert.equal(exec.scrubSpawnEnv, scrubSpawnEnv);
  assert.equal(exec.commandExitFacts, commandExitFacts);
});
