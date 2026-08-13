'use strict';
/**
 * The /api/project* endpoints. Loopback-only regardless of bind address:
 * even with HOST=0.0.0.0 for LAN chat, no remote client can reach the
 * filesystem or run a command.
 */
const path = require('path');
const fsp = require('fs').promises;
const { parseBody, sendJsonRes } = require('../http');
const { assertLoopback } = require('../security');
const { readProjectsIndex, writeProjectsIndex, newProjectId, stateDirOf,
        loadProject, readJson, writeJsonAtomic, appendJournal, readJournalTail } = require('./state');
const { validateProjectFolder } = require('./paths');
const { projectFsOp } = require('./fs');
const { projectExec } = require('./exec');

async function handleProjectRoute(req, res, url) {
  if (!assertLoopback(req, res)) return;

  // GET /api/projects — list
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    const idx = await readProjectsIndex();
    const projects = [];
    for (const p of idx) {
      let exists = true;
      try {
        exists = (await fsp.stat(p.folder)).isDirectory();
      } catch {
        exists = false;
      }
      projects.push({ ...p, exists });
    }
    return sendJsonRes(res, 200, { projects });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJsonRes(res, e.statusCode || 400, { error: e.message });
  }

  try {
    // POST /api/projects — create
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) return sendJsonRes(res, 400, { error: 'Project name is required' });
      const folder = await validateProjectFolder(body.folder);
      const idx = await readProjectsIndex();
      if (idx.some((p) => p.folder === folder)) {
        return sendJsonRes(res, 409, { error: 'That folder is already assigned to a project' });
      }
      const id = newProjectId();
      const entry = { id, name, folder, at: Date.now() };
      const meta = {
        name,
        team: Array.isArray(body.team) ? body.team.slice(0, 4) : [],
        // Same object guard as the update path: spreading a string/array here
        // persists index keys ({"0":"f","1":"a"…}) into project.json
        settings: {
          maxTurns: 24,
          reasoning: 'inherit',
          ...(body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
            ? body.settings
            : {})
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await fsp.mkdir(stateDirOf(folder), { recursive: true });
      await writeJsonAtomic(path.join(stateDirOf(folder), 'project.json'), meta);
      await writeJsonAtomic(path.join(stateDirOf(folder), 'tasks.json'), { tasks: [] });
      await writeJsonAtomic(path.join(stateDirOf(folder), 'decisions.json'), []);
      idx.push(entry);
      await writeProjectsIndex(idx);
      return sendJsonRes(res, 200, { project: { ...entry, ...meta } });
    }

    // POST /api/projects/update — { id, patch }
    if (url.pathname === '/api/projects/update' && req.method === 'POST') {
      const project = await loadProject(String(body.id || ''), res);
      if (!project) return;
      const metaFile = path.join(stateDirOf(project.folder), 'project.json');
      const meta = await readJson(metaFile, {});
      const patch = body.patch || {};
      if (typeof patch.name === 'string' && patch.name.trim()) meta.name = patch.name.trim().slice(0, 80);
      if (Array.isArray(patch.team)) meta.team = patch.team.slice(0, 4);
      if (patch.settings && typeof patch.settings === 'object' && !Array.isArray(patch.settings)) {
        meta.settings = { ...(meta.settings || {}), ...patch.settings };
      }
      if (typeof patch.lastSeat === 'number') meta.lastSeat = patch.lastSeat;
      meta.updatedAt = Date.now();
      await writeJsonAtomic(metaFile, meta);
      if (meta.name) {
        const idx = await readProjectsIndex();
        const e = idx.find((p) => p.id === project.id);
        if (e && e.name !== meta.name) {
          e.name = meta.name;
          await writeProjectsIndex(idx);
        }
      }
      return sendJsonRes(res, 200, { ok: true, project: { ...project, ...meta } });
    }

    // POST /api/projects/delete — { id, removeState? } (never deletes user files)
    if (url.pathname === '/api/projects/delete' && req.method === 'POST') {
      const id = String(body.id || '');
      const idx = await readProjectsIndex();
      const entry = idx.find((p) => p.id === id);
      if (!entry) return sendJsonRes(res, 404, { error: 'Project not found' });
      await writeProjectsIndex(idx.filter((p) => p.id !== id));
      if (body.removeState) {
        try {
          await fsp.rm(stateDirOf(entry.folder), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return sendJsonRes(res, 200, { ok: true });
    }

    // Everything below requires a valid project
    const project = await loadProject(String(body.id || ''), res);
    if (!project) return;

    if (url.pathname === '/api/project/state' && req.method === 'POST') {
      const tasks = await readJson(path.join(stateDirOf(project.folder), 'tasks.json'), { tasks: [] });
      const decisions = await readJson(path.join(stateDirOf(project.folder), 'decisions.json'), []);
      // Clamp both ends: a negative maxEvents inverts the tail slice and
      // returns the whole journal minus its oldest entries
      const maxEvents = Math.max(1, Math.min(1000, Number(body.maxEvents) || 400));
      const journal = await readJournalTail(project, maxEvents);
      return sendJsonRes(res, 200, { project, tasks: tasks.tasks || [], decisions, journal });
    }

    if (url.pathname === '/api/project/fs' && req.method === 'POST') {
      const result = await projectFsOp(project, body);
      return sendJsonRes(res, 200, { ok: true, result });
    }

    if (url.pathname === '/api/project/exec' && req.method === 'POST') {
      const result = await projectExec(project, req, res, body);
      return sendJsonRes(res, 200, { ok: !result.error, result });
    }

    if (url.pathname === '/api/project/journal' && req.method === 'POST') {
      const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
      if (events.length) await appendJournal(project, events);
      return sendJsonRes(res, 200, { ok: true });
    }

    if (url.pathname === '/api/project/tasks' && req.method === 'POST') {
      const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 200) : [];
      await writeJsonAtomic(path.join(stateDirOf(project.folder), 'tasks.json'), { tasks });
      return sendJsonRes(res, 200, { ok: true });
    }

    if (url.pathname === '/api/project/decision' && req.method === 'POST') {
      const file = path.join(stateDirOf(project.folder), 'decisions.json');
      const decisions = await readJson(file, []);
      decisions.push({
        t: Date.now(),
        by: String(body.by || '').slice(0, 60),
        text: String(body.text || '').slice(0, 2000)
      });
      await writeJsonAtomic(file, decisions.slice(-200));
      return sendJsonRes(res, 200, { ok: true, decisions: decisions.slice(-200) });
    }

    return sendJsonRes(res, 404, { error: 'Unknown project endpoint' });
  } catch (e) {
    return sendJsonRes(res, e.statusCode || 500, { error: e.message || 'Project operation failed' });
  }
}

module.exports = { handleProjectRoute };
