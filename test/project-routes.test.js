'use strict';
/**
 * End-to-end /api/project* against the real server: exec semantics, the
 * catastrophic guard, and concurrent state writes.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { startTarka } = require('./helpers/harness');

let tarka;
let folder;
let projectId;
test.before(async () => {
  folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-proj-'));
  tarka = await startTarka();
  const r = await tarka.post('/api/projects', { name: 'Routes', folder });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  projectId = JSON.parse(text).project.id;
});
test.after(async () => {
  if (tarka) await tarka.close();
  if (folder) await fsp.rm(folder, { recursive: true, force: true });
});

const exec = (command, extra = {}) =>
  tarka.post('/api/project/exec', { id: projectId, command, ...extra }).then((r) => r.json());

test('a command that reads stdin gets EOF instead of hanging until the timeout', async () => {
  const started = Date.now();
  const { result } = await exec('cat', { timeoutMs: 5000 });
  assert.equal(result.timedOut, false, JSON.stringify(result));
  assert.equal(result.code, 0);
  assert.ok(Date.now() - started < 4000, 'must not wait for the timeout');
});

test('rm -rf on a parent of the project folder is blocked', async () => {
  for (const cmd of ['rm -rf ..', 'rm -rf ../', 'rm -rf ../..', 'rm -rf "../"', 'cd src && rm -rf ..']) {
    const { result } = await exec(cmd);
    assert.equal(result.blocked, true, `${cmd} should be blocked`);
  }
  const { result } = await exec('rm -rf ../tarka-proj-does-not-exist-xyz');
  assert.notEqual(result.blocked, true, 'a sibling path is ordinary work');
});

test('concurrent update patches are both kept', async () => {
  await Promise.all([
    tarka.post('/api/projects/update', { id: projectId, patch: { name: 'Renamed' } }),
    tarka.post('/api/projects/update', { id: projectId, patch: { lastSeat: 2 } }),
    tarka.post('/api/projects/update', { id: projectId, patch: { settings: { maxTurns: 9 } } })
  ]);
  const state = await tarka.post('/api/project/state', { id: projectId }).then((r) => r.json());
  assert.equal(state.project.name, 'Renamed');
  assert.equal(state.project.lastSeat, 2);
  assert.equal(state.project.settings.maxTurns, 9);
  const list = await fetch(`${tarka.origin}/api/projects`).then((r) => r.json());
  assert.equal(list.projects.find((p) => p.id === projectId).name, 'Renamed');
});

test('concurrent journal appends all land', async () => {
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      tarka.post('/api/project/journal', { id: projectId, events: [{ type: 'note', i }] })
    )
  );
  const state = await tarka.post('/api/project/state', { id: projectId }).then((r) => r.json());
  const seen = state.journal.filter((e) => e.type === 'note').map((e) => e.i).sort((a, b) => a - b);
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => i));
});

test('a second project on the same folder is refused without creating state twice', async () => {
  const r = await tarka.post('/api/projects', { name: 'Dup', folder });
  assert.equal(r.status, 409);
});
