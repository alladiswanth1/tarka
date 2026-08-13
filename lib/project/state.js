'use strict';
/**
 * Project bookkeeping, all plain JSON on disk — no database.
 *
 *   data/projects.json          the index of projects (id, name, folder)
 *   <folder>/.tarka/project.json    team + settings
 *   <folder>/.tarka/tasks.json      the shared task board
 *   <folder>/.tarka/decisions.json  the decision log
 *   <folder>/.tarka/journal.jsonl   append-only turn journal (rotated)
 *
 * `.tarka` is invisible to agents (see resolveInside) so the team cannot
 * rewrite its own task board through the file tools.
 */
const path = require('path');
const fsp = require('fs').promises;
const { DATA_DIR, PROJECTS_INDEX } = require('../paths');
const { sendJsonRes } = require('../http');
const { TARKA_STATE_DIR, JOURNAL_ROTATE_BYTES, JOURNAL_TAIL_BYTES } = require('./constants');

/** Monotonic tiebreaker: two same-millisecond writes must not share a tmp name. */
let atomicSeq = 0;
async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${atomicSeq++}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, file);
  } catch (e) {
    // A failed write (ENOSPC…) must not orphan tmp files forever
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readProjectsIndex() {
  const idx = await readJson(PROJECTS_INDEX, []);
  return Array.isArray(idx) ? idx : [];
}

async function writeProjectsIndex(list) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(PROJECTS_INDEX, list);
}

function newProjectId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function stateDirOf(folder) {
  return path.join(folder, TARKA_STATE_DIR);
}

async function loadProject(id, res) {
  const idx = await readProjectsIndex();
  const entry = idx.find((p) => p && p.id === id);
  if (!entry) {
    sendJsonRes(res, 404, { error: 'Project not found' });
    return null;
  }
  let folderOk = true;
  try {
    const st = await fsp.stat(entry.folder);
    if (!st.isDirectory()) folderOk = false;
  } catch {
    folderOk = false;
  }
  if (!folderOk) {
    sendJsonRes(res, 410, { error: `Project folder is missing: ${entry.folder}` });
    return null;
  }
  const meta = await readJson(path.join(stateDirOf(entry.folder), 'project.json'), {});
  return { ...entry, ...meta, id: entry.id, folder: entry.folder };
}

async function appendJournal(project, events) {
  const file = path.join(stateDirOf(project.folder), 'journal.jsonl');
  await fsp.mkdir(stateDirOf(project.folder), { recursive: true });
  try {
    const st = await fsp.stat(file);
    if (st.size > JOURNAL_ROTATE_BYTES) {
      await fsp.rename(file, file.replace(/\.jsonl$/, `-${Date.now()}.old.jsonl`));
    }
  } catch {
    /* no file yet */
  }
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.appendFile(file, lines);
}

async function readJournalTail(project, maxEvents = 400) {
  const file = path.join(stateDirOf(project.folder), 'journal.jsonl');
  let text = '';
  try {
    const st = await fsp.stat(file);
    if (st.size <= JOURNAL_TAIL_BYTES) {
      text = await fsp.readFile(file, 'utf8');
    } else {
      const fh = await fsp.open(file, 'r');
      const buf = Buffer.alloc(JOURNAL_TAIL_BYTES);
      try {
        await fh.read(buf, 0, JOURNAL_TAIL_BYTES, st.size - JOURNAL_TAIL_BYTES);
      } finally {
        // A read error must not leak the handle — this runs on every journal
        // poll, so a leak here accumulates for the life of the process.
        await fh.close().catch(() => {});
      }
      text = buf.toString('utf8');
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return events.slice(-maxEvents);
}

module.exports = {
  writeJsonAtomic, readJson, readProjectsIndex, writeProjectsIndex,
  newProjectId, stateDirOf, loadProject, appendJournal, readJournalTail
};
