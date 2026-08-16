'use strict';
/** File operations for Project Mode. Every path goes through resolveInside. */
const path = require('path');
const fsp = require('fs').promises;
const { resolveInside } = require('./paths');
const { TARKA_STATE_DIR, READ_CAP_BYTES, WRITE_CAP_BYTES } = require('./constants');

const SKIP_DIRS = new Set(['node_modules', '.git', TARKA_STATE_DIR, 'dist', 'build', '__pycache__', '.venv', 'venv', '.next', 'target']);

async function listProjectTree(project, startRel, maxEntries = 600, maxDepth = 8) {
  const { abs: startAbs, rel: startRelNorm } = await resolveInside(project, startRel || '');
  const out = [];
  let truncated = false;
  const walk = async (dir, rel, depth) => {
    if (out.length >= maxEntries) {
      truncated = true;
      return;
    }
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const it of items) {
      if (out.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (it.name === TARKA_STATE_DIR) continue;
      const childRel = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name)) {
          out.push({ path: childRel + '/', dir: true, skipped: true });
          continue;
        }
        out.push({ path: childRel + '/', dir: true });
        if (depth < maxDepth) await walk(path.join(dir, it.name), childRel, depth + 1);
      } else if (it.isFile()) {
        let size = 0;
        try {
          size = (await fsp.stat(path.join(dir, it.name))).size;
        } catch {
          /* ignore */
        }
        out.push({ path: childRel, size });
      }
    }
  };
  // A guessed nonexistent path is routine agent behavior — answer 404 with
  // the relative path, not a 500 leaking the server's absolute path in ENOENT.
  let st;
  try {
    st = await fsp.stat(startAbs);
  } catch {
    const e = new Error(`Not found: ${startRelNorm || '.'}`);
    e.statusCode = 404;
    throw e;
  }
  // The NORMALIZED path, like every other branch: echoing the raw agent string
  // leaks the server's absolute path when the agent passed one.
  if (st.isFile()) return { entries: [{ path: startRelNorm, size: st.size }], truncated: false };
  await walk(startAbs, startRelNorm, 1);
  return { entries: out, truncated };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** File operations, all path-contained. Returns a JSON-able result. */
async function projectFsOp(project, body) {
  const op = String(body.op || '');
  const fail = (msg, code = 400) => {
    const e = new Error(msg);
    e.statusCode = code;
    throw e;
  };

  if (op === 'list') {
    return await listProjectTree(project, body.path || '', 600, 8);
  }

  if (op === 'read') {
    const { abs, rel } = await resolveInside(project, body.path);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      fail(`File not found: ${rel}`, 404);
    }
    if (st.isDirectory()) fail(`${rel} is a directory — use list`, 400);
    // A FIFO/socket/device blocks open() forever, pinning a libuv threadpool
    // thread; four of those freeze every fs operation in the process.
    if (!st.isFile()) fail(`${rel} is not a regular file`, 400);
    if (st.size > READ_CAP_BYTES) {
      fail(`File too large to read whole (${st.size} bytes) — use run with head/grep/sed instead`, 413);
    }
    const buf = await fsp.readFile(abs);
    if (looksBinary(buf)) return { path: rel, binary: true, size: st.size };
    return { path: rel, size: st.size, content: buf.toString('utf8') };
  }

  if (op === 'write' || op === 'append') {
    const { abs, rel } = await resolveInside(project, body.path, { forWrite: true });
    const content = String(body.content == null ? '' : body.content);
    if (Buffer.byteLength(content) > WRITE_CAP_BYTES) fail('Content exceeds the 5MB write cap', 413);
    // Same FIFO/device hazard as read: writing to a pipe with no reader blocks.
    // stat (not lstat) — writeFile follows symlinks, so judge what it lands on.
    try {
      const cur = await fsp.stat(abs);
      if (!cur.isFile()) fail(`${rel} exists and is not a regular file`, 400);
    } catch (e) {
      if (e.statusCode) throw e; // ENOENT is fine — we are creating it
    }
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      if (op === 'append') await fsp.appendFile(abs, content);
      else await fsp.writeFile(abs, content);
    } catch (e) {
      if (e.statusCode) throw e;
      fail(
        `Cannot write ${rel}: ${e.code === 'ENOTDIR' ? 'a path component is not a directory' : e.code || e.message}`,
        400
      );
    }
    const lines = content ? content.split('\n').length : 0;
    return { path: rel, bytes: Buffer.byteLength(content), lines, mode: op };
  }

  if (op === 'mkdir') {
    const { abs, rel } = await resolveInside(project, body.path, { forWrite: true });
    try {
      await fsp.mkdir(abs, { recursive: true });
    } catch (e) {
      // Raw fs errors carry the server's ABSOLUTE path, and routes.js returns
      // an unrecognised error as a 500 body — the same leak the 404 above is
      // careful to avoid. Re-describe it in project-relative terms.
      fail(`Cannot create ${rel}: ${e.code === 'ENOTDIR' ? 'a path component is not a directory' : e.code || e.message}`, 400);
    }
    return { path: rel, created: true };
  }

  if (op === 'move') {
    const from = await resolveInside(project, body.path, { forWrite: true });
    const to = await resolveInside(project, body.to, { forWrite: true });
    try {
      await fsp.access(to.abs);
      fail(`Target already exists: ${to.rel}`, 409);
    } catch (e) {
      if (e.statusCode) throw e;
    }
    try {
      await fsp.mkdir(path.dirname(to.abs), { recursive: true });
      await fsp.rename(from.abs, to.abs);
    } catch (e) {
      if (e.statusCode) throw e;
      fail(
        `Cannot move ${from.rel} → ${to.rel}: ${e.code === 'EXDEV' ? 'cross-device move' : e.code || e.message}`,
        400
      );
    }
    return { from: from.rel, to: to.rel };
  }

  if (op === 'delete') {
    const { abs, rel } = await resolveInside(project, body.path, { forWrite: true });
    try {
      await fsp.rm(abs, { recursive: true, force: true });
    } catch (e) {
      fail(`Cannot delete ${rel}: ${e.code || e.message}`, 400);
    }
    return { path: rel, deleted: true };
  }

  fail(`Unknown fs op: ${op}`);
}

module.exports = { SKIP_DIRS, listProjectTree, looksBinary, projectFsOp };
