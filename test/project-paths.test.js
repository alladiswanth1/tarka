'use strict';
/**
 * Project Mode path containment — the guard between a team of models and the
 * rest of the filesystem. Every case here is something an agent plausibly
 * emits (absolute paths, "..", a symlink it just created) or something a user
 * might assign by mistake (/, $HOME, the Tarka checkout itself).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { validateProjectFolder, resolveInside, SYSTEM_PREFIXES } = require('../lib/project/paths');
const { APP_DIR } = require('../lib/paths');

let root;
let project;
test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-paths-'));
  root = await fsp.realpath(root); // macOS /var -> /private/var
  project = { folder: root };
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'a.js'), 'x');
});
test.after(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

const rejects = (p, re) =>
  assert.rejects(() => resolveInside(project, p), (e) => (re ? re.test(e.message) : true), String(p));

test('ordinary relative paths resolve inside the folder', async () => {
  const a = await resolveInside(project, 'src/a.js');
  assert.equal(a.abs, path.join(root, 'src', 'a.js'));
  assert.equal(a.rel, path.join('src', 'a.js'));

  const r = await resolveInside(project, '');
  assert.equal(r.abs, root);
  assert.equal(r.rel, '');

  // Backslashes normalize — models emit Windows-style separators
  assert.equal((await resolveInside(project, 'src\\a.js')).rel, path.join('src', 'a.js'));
});

test('an absolute path is treated as folder-relative, as models emit them', async () => {
  assert.equal((await resolveInside(project, '/src/a.js')).rel, path.join('src', 'a.js'));
  // ...including a full echo of the project folder
  assert.equal((await resolveInside(project, path.join(root, 'src/a.js'))).rel, path.join('src', 'a.js'));
});

test('traversal out of the folder is refused', async () => {
  for (const p of [
    '../outside.txt',
    'src/../../outside.txt',
    '../../etc/passwd',
    'a/b/../../../escape'
  ]) {
    await rejects(p, /escapes the project folder/);
  }
});

test('the .tarka state directory is invisible in both directions', async () => {
  for (const p of ['.tarka', '.tarka/project.json', 'src/../.tarka/journal.jsonl', '/.tarka']) {
    await rejects(p, /\.tarka/);
  }
  // A file that merely starts with the same letters is fine
  assert.ok(await resolveInside(project, '.tarkarc'));
});

test('a symlink pointing outside the folder is refused', async (t) => {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-outside-'));
  const realOutside = await fsp.realpath(outside);
  await fsp.writeFile(path.join(realOutside, 'secret.txt'), 'top secret');
  const link = path.join(root, 'escape');
  try {
    await fsp.symlink(realOutside, link, 'dir');
  } catch {
    return t.skip('symlinks unavailable on this platform');
  }
  try {
    await rejects('escape/secret.txt', /symlink|escapes/);
    await rejects('escape', /symlink|escapes/);
  } finally {
    await fsp.rm(link, { force: true });
    await fsp.rm(realOutside, { recursive: true, force: true });
  }
});

/*
 * Regression: containment was proved with realpath(), which answers ENOENT for
 * a symlink whose target does not exist YET — and the probe read that as
 * "nothing here, we are creating it". But writeFile, appendFile and mkdir -p
 * all FOLLOW links, so an agent could `ln -s ~/.config/autostart/x.desktop
 * payload` and then write a file of its choosing anywhere on disk. Only the
 * link-to-an-EXISTING-file case was covered, which is the one that already
 * failed closed.
 */
test('a symlink to a not-yet-existing target cannot escape either', async (t) => {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-dangling-'));
  const realOutside = await fsp.realpath(outside);
  const links = ['dangling', 'danglingdir', 'intotarka'];
  try {
    // Targets deliberately do NOT exist: that is the whole point.
    await fsp.symlink(path.join(realOutside, 'NEW.txt'), path.join(root, 'dangling'));
    await fsp.symlink(path.join(realOutside, 'newdir'), path.join(root, 'danglingdir'), 'dir');
    await fsp.symlink(path.join(root, '.tarka', 'tasks.json'), path.join(root, 'intotarka'));
  } catch {
    return t.skip('symlinks unavailable on this platform');
  }
  try {
    await rejects('dangling', /symlink|escapes/);
    // ...including when the link is a DIRECTORY component, which mkdir -p follows
    await rejects('danglingdir/x.txt', /symlink|escapes/);
    await rejects('danglingdir', /symlink|escapes/);
    // A link into .tarka must not become a way to rewrite the team's own board
    await rejects('intotarka', /\.tarka|symlink/);
    // Nothing was created outside while proving it
    await assert.rejects(() => fsp.stat(path.join(realOutside, 'NEW.txt')));
    await assert.rejects(() => fsp.stat(path.join(realOutside, 'newdir')));
  } finally {
    for (const l of links) await fsp.rm(path.join(root, l), { force: true });
    await fsp.rm(realOutside, { recursive: true, force: true });
  }
});

test('a symlink that stays inside the folder is allowed', async (t) => {
  const link = path.join(root, 'inner-link');
  try {
    await fsp.symlink(path.join(root, 'src'), link, 'dir');
  } catch {
    return t.skip('symlinks unavailable on this platform');
  }
  try {
    const r = await resolveInside(project, 'inner-link/a.js');
    assert.ok(r.abs.startsWith(root));
  } finally {
    await fsp.rm(link, { force: true });
  }
});

test('writes to the project root itself are refused', async () => {
  await assert.rejects(
    () => resolveInside(project, '', { forWrite: true }),
    /project root itself/
  );
});

test('validateProjectFolder refuses the obviously destructive targets', async () => {
  await assert.rejects(() => validateProjectFolder(''), /required/);
  await assert.rejects(() => validateProjectFolder('relative/path'), /absolute/);
  await assert.rejects(() => validateProjectFolder(path.parse(process.cwd()).root), /filesystem root/);
  await assert.rejects(() => validateProjectFolder(os.homedir()), /home directory/);
  for (const sys of SYSTEM_PREFIXES) {
    if (!fs.existsSync(sys)) continue;
    await assert.rejects(() => validateProjectFolder(sys), /system directory/, sys);
    await assert.rejects(() => validateProjectFolder(path.join(sys, 'sub')), /system directory/, sys);
  }
});

/*
 * The APP_DIR guard is why lib/project/paths.js imports it from lib/paths.js:
 * deriving it from __dirname here would resolve to lib/project and leave the
 * app root assignable — agents could then rewrite server.js.
 */
test('validateProjectFolder refuses Tarka’s own source tree', async () => {
  await assert.rejects(() => validateProjectFolder(APP_DIR), /Tarka app folder/);
  await assert.rejects(() => validateProjectFolder(path.join(APP_DIR, 'lib')), /Tarka app folder/);
  // When the checkout lives at $HOME/tarka the parent is the home directory,
  // which a different guard refuses first. Either refusal is containment.
  await assert.rejects(
    () => validateProjectFolder(path.dirname(APP_DIR)),
    /contains the running Tarka app|home directory|filesystem root|system directory/
  );
});

test('validateProjectFolder creates a missing folder and returns its real path', async () => {
  const target = path.join(root, 'brand', 'new');
  const out = await validateProjectFolder(target);
  assert.equal(out, await fsp.realpath(target));
  assert.ok(fs.existsSync(target));
});

test('validateProjectFolder expands a leading ~', async () => {
  // Under the home dir but not the home dir itself
  const target = path.join(os.homedir(), '.tarka-test-scratch');
  try {
    const out = await validateProjectFolder('~/.tarka-test-scratch');
    assert.equal(out, await fsp.realpath(target));
  } finally {
    await fsp.rm(target, { recursive: true, force: true });
  }
});

/*
 * Regression: the `.tarka` exclusion applied only to the LITERAL path, so a
 * symlink an agent creates (`ln -s .tarka visible`) reached the state dir
 * through the file API, and on case-insensitive filesystems `.TARKA` did too.
 */
test('the .tarka exclusion holds through symlinks and case games', async () => {
  await fsp.mkdir(path.join(root, '.tarka'), { recursive: true });
  await fsp.writeFile(path.join(root, '.tarka', 'tasks.json'), '{}');
  await fsp.symlink('.tarka', path.join(root, 'visible'));
  try {
    await rejects('visible/tasks.json', /state directory/);
    await rejects('visible', /state directory/);
    // Case variants fail closed on every platform
    await rejects('.TARKA/journal.jsonl', /state directory/);
    await rejects('.Tarka', /state directory/);
  } finally {
    await fsp.unlink(path.join(root, 'visible'));
  }
});

test('validateProjectFolder refuses ~user paths and parents of $HOME', async () => {
  await assert.rejects(() => validateProjectFolder('~alice/proj'), /not supported/);
  const homeParent = path.dirname(path.resolve(os.homedir()));
  if (homeParent !== path.parse(homeParent).root || os.homedir() !== homeParent) {
    await assert.rejects(
      () => validateProjectFolder(homeParent),
      /contains your home|system directory|filesystem root/
    );
  }
});

/*
 * Regression: sh treats a newline exactly like ";" — a two-line command must
 * not slip past the catastrophic-command guard.
 */
test('the exec guard sees newline-separated commands', () => {
  const { CATASTROPHIC_RE } = require('../lib/project/exec');
  assert.ok(CATASTROPHIC_RE.test('true\nrm -rf /'), 'newline separator');
  assert.ok(CATASTROPHIC_RE.test('rm -rf /'), 'plain form still caught');
  assert.ok(!CATASTROPHIC_RE.test('rm -rf ./build'), 'project-local rm stays allowed');
  assert.ok(!CATASTROPHIC_RE.test('echo hi\nls'), 'harmless multi-line commands pass');
});

/*
 * Regression: the guard names "rm on /" as the thing it blocks, but the anchor
 * had no leading-whitespace allowance and the terminator only accepted a bare
 * "/" — so one space of indentation, or the far more common "/*" glob, walked
 * straight through the check the README advertises.
 */
test('the exec guard catches the ways a root wipe is actually written', () => {
  const { CATASTROPHIC_RE } = require('../lib/project/exec');
  for (const cmd of [
    ' rm -rf /',      // leading space defeated the ^ anchor
    '\trm -rf /',     // ...as did a tab
    'rm -rf /*',      // the canonical "delete everything"
    'rm -rf /.',
    'rm -rf //',
    'rm  -rf   /*',   // padded flags
    'echo x; rm -rf /*'
  ]) {
    assert.ok(CATASTROPHIC_RE.test(cmd), `should block: ${cmd}`);
  }
  // An absolute path is not a root wipe: the team works in real directories and
  // a guard that blocks its own scratch space is worse than no guard.
  for (const cmd of [
    'rm -rf /tmp/scratch',
    'rm -rf /home/me/proj',
    'rm -rf build/',
    'rm file.txt',
    'rm -rf node_modules'
  ]) {
    assert.ok(!CATASTROPHIC_RE.test(cmd), `should allow: ${cmd}`);
  }
});

/*
 * A command can begin inside a group, a substitution or after a shell keyword,
 * and the target can end at a separator rather than whitespace — so the guard
 * has to recognise both ends. $HOME is guarded next to /: validateProjectFolder
 * already refuses the home directory as a project folder, so losing it to a
 * stray cleanup is the same unrecoverable outcome by another route.
 */
test('the exec guard follows the shell into groups, keywords and $HOME', () => {
  const { CATASTROPHIC_RE } = require('../lib/project/exec');
  for (const cmd of [
    '(rm -rf /)',
    '{ rm -rf /; }',
    '$(rm -rf /)',
    'sh -c "rm -rf /"',
    'for i in 1; do rm -rf /; done',
    'if true; then rm -rf /; fi',
    'time rm -rf /',
    'command rm -rf /',
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf ~/*',
    'rm -rf $HOME',
    'rm -rf "$HOME"',
    'rm -rf ${HOME}',
    'doas ls'
  ]) {
    assert.ok(CATASTROPHIC_RE.test(cmd), `should block: ${cmd}`);
  }

  // The destructive verbs only count in COMMAND position. Matching them
  // anywhere refused ordinary work, and a guard that blocks the job it was
  // hired to protect just gets worked around.
  for (const cmd of [
    'git commit -m "fix shutdown handler"',
    'grep -rn sudo /etc/sudoers.d',
    'cat notes.md | grep shutdown',
    'make halt',
    './scripts/reboot-db.sh',
    'rm -rf ~/projects/old', // a path INSIDE home is ordinary work
    'rm -rf "$PROJECT/dist"',
    'rm -f /tmp/x.log'
  ]) {
    assert.ok(!CATASTROPHIC_RE.test(cmd), `should allow: ${cmd}`);
  }
});
