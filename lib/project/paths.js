'use strict';
/**
 * Path containment for Project Mode — the guard that keeps a team of models
 * inside the folder you assigned it.
 *
 * Two separate jobs:
 *   validateProjectFolder  vets a folder BEFORE it becomes a project (not /,
 *                          not $HOME itself, not a system dir, not Tarka's own
 *                          source tree, symlink-resolved).
 *   resolveInside          vets every agent-supplied path afterwards, with
 *                          symlink containment and `.tarka` hidden both ways.
 *
 * APP_DIR comes from lib/paths.js on purpose: deriving it from __dirname here
 * would resolve to lib/project and quietly stop protecting the app root.
 */
const path = require('path');
const os = require('os');
const fsp = require('fs').promises;
const { APP_DIR } = require('../paths');
const { TARKA_STATE_DIR } = require('./constants');

const SYSTEM_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot',
  '/sys', '/proc', '/dev', '/run', '/srv', '/root'
];

/**
 * Validate a user-assigned project folder. Returns the resolved absolute
 * path or throws { statusCode, message }.
 */
async function validateProjectFolder(folderRaw) {
  const fail = (msg) => {
    const e = new Error(msg);
    e.statusCode = 400;
    throw e;
  };
  let p = String(folderRaw || '').trim();
  if (!p) fail('Folder path is required');
  // Only "~" and "~/..." mean this user's home; "~alice/proj" would silently
  // become "$HOME/alice/proj" — a folder the user never intended.
  if (p === '~' || p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(1));
  } else if (p.startsWith('~')) {
    fail('"~user" paths are not supported — use an absolute path');
  }
  if (!path.isAbsolute(p)) fail('Folder must be an absolute path (e.g. /home/you/my-project)');
  p = path.resolve(p);

  const home = path.resolve(os.homedir());
  // Tarka's own source tree, from lib/paths.js — NOT __dirname, which here
  // would be lib/project and would leave the app root assignable as a
  // project folder (agents could then rewrite server.js).
  const appDir = APP_DIR;
  if (p === path.parse(p).root) fail('Refusing to use the filesystem root as a project folder');
  if (p === home) fail('Refusing to use your home directory itself — pick a folder inside it');
  // A parent of $HOME (/home, /Users) contains the home dir and everything in
  // it — the exact class of mistake the check above exists to catch.
  if (home.startsWith(p + path.sep)) {
    fail('Refusing to use a folder that contains your home directory — pick a folder inside it');
  }
  for (const sys of SYSTEM_PREFIXES) {
    if (p === sys || p.startsWith(sys + path.sep)) fail(`Refusing to use a system directory (${sys})`);
  }
  if (p === appDir || p.startsWith(appDir + path.sep)) {
    fail('Refusing to use the Tarka app folder itself');
  }
  if (appDir.startsWith(p + path.sep)) {
    fail('That folder contains the running Tarka app — pick a sibling folder instead');
  }

  // Create if missing; realpath afterwards so symlinked parents cannot escape checks
  await fsp.mkdir(p, { recursive: true });
  const real = await fsp.realpath(p);
  if (real !== p) {
    // Re-run the static checks on the resolved target
    if (real === path.parse(real).root || real === home || home.startsWith(real + path.sep)) {
      fail('Folder resolves to a protected location');
    }
    for (const sys of SYSTEM_PREFIXES) {
      if (real === sys || real.startsWith(sys + path.sep)) fail('Folder resolves into a system directory');
    }
    if (real === appDir || real.startsWith(appDir + path.sep) || appDir.startsWith(real + path.sep)) {
      fail('Folder resolves into the Tarka app location');
    }
  }
  return real;
}

/**
 * Where an operation on `abs` will ACTUALLY land, following symlinks at every
 * component — including ones whose target does not exist yet.
 *
 * `realpath()` answers ENOENT for a dangling symlink, and a probe that walks up
 * to the nearest existing ancestor then reads that as "nothing here, we are
 * creating it". But `writeFile`, `appendFile` and `mkdir -p` all FOLLOW links,
 * so an agent could `ln -s ~/.config/autostart/x.desktop payload` (target not
 * yet existing) and then `write payload` to create a file — with content it
 * chose — anywhere on disk the user can write. Resolving component by component
 * with `lstat` sees the link itself rather than asking about its target.
 */
async function resolveLanding(abs, depth = 0) {
  if (depth > 32) return abs; // symlink loop — let the containment check judge it
  const { root: fsRoot } = path.parse(abs);
  const parts = abs.slice(fsRoot.length).split(path.sep).filter(Boolean);
  let cur = fsRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch {
      // Nothing exists from here down; the remainder is created fresh under it.
      const rest = parts.slice(i + 1);
      return rest.length ? path.join(cur, ...rest) : cur;
    }
    if (st.isSymbolicLink()) {
      const target = path.resolve(path.dirname(cur), await fsp.readlink(cur));
      const rest = parts.slice(i + 1);
      return resolveLanding(rest.length ? path.join(target, ...rest) : target, depth + 1);
    }
  }
  return cur;
}

/**
 * Resolve an agent-supplied path inside the project folder.
 * - absolute paths are treated as folder-relative (models emit them often)
 * - `.tarka` is invisible in both directions
 * - symlink-safe: where the path LANDS must be inside the root, whether or not
 *   the link target exists yet (see resolveLanding)
 */
async function resolveInside(project, relRaw, { forWrite = false } = {}) {
  const fail = (msg, code = 400) => {
    const e = new Error(msg);
    e.statusCode = code;
    throw e;
  };
  const root = project.folder; // already realpathed at creation
  let rel = String(relRaw == null ? '' : relRaw).trim().replace(/\\/g, '/');
  if (rel.startsWith(root + '/') || rel === root) rel = rel.slice(root.length);
  rel = rel.replace(/^\/+/, '');
  const abs = path.resolve(root, rel === '' ? '.' : rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    fail('Path escapes the project folder', 403);
  }
  const relNorm = abs === root ? '' : abs.slice(root.length + 1);
  // Case-insensitive: on APFS/NTFS, ".TARKA/…" reaches the real state dir
  const hitsStateDir = (relPath) =>
    relPath.split(path.sep).some((c) => c.toLowerCase() === TARKA_STATE_DIR);
  if (relNorm && hitsStateDir(relNorm)) {
    fail('The .tarka state directory is managed by Tarka and not accessible to agents', 403);
  }
  // Symlink containment: judge where the operation actually lands. `root` was
  // realpathed when the project was created, so a contained path resolves to
  // itself and only a link (or a link in an ancestor) moves the landing site.
  const landing = await resolveLanding(abs);
  if (landing !== root && !landing.startsWith(root + path.sep)) {
    fail('Path resolves outside the project folder (symlink)', 403);
  }
  // The `.tarka` exclusion must hold for the RESOLVED path too — a symlink
  // `visible -> .tarka` passes the relNorm check above but lands in the state
  // dir, letting agents rewrite their own task board.
  if (landing !== root && hitsStateDir(landing.slice(root.length + 1))) {
    fail('The .tarka state directory is managed by Tarka and not accessible to agents', 403);
  }
  if (forWrite && abs === root) fail('Refusing to operate on the project root itself');
  return { abs, rel: relNorm };
}

module.exports = { SYSTEM_PREFIXES, validateProjectFolder, resolveInside };
