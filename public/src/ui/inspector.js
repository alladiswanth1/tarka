import { getConfig } from '../config.js';
import { detectContextFromProvider, getContextUsage } from '../context.js';
import { debateSettings } from '../debate/settings.js';
import { downloadBlob, exportChat } from '../export.js';
import { runProjectSession } from '../project/engine.js';
import { pjEmit } from '../project/journal.js';
import { pjJournalLineForPrompt } from '../project/protocol.js';
import { activeProject, pjApi, projectBusy, projectDecisions, projectJournal, projectMode, projectSeats, renderProjectTasksList, validateProjectSetup } from '../project/state.js';
import { $, isStreaming, lastGenStats, lastThinkMs, messages, messagesEl } from '../state.js';
import { formatTokenCount } from '../tokens.js';
import { openCmdk } from '../ui/cmdk.js';
import { openSidebar, setSidebarPanel } from '../ui/sidebar.js';
import { appendError, flashStatus, formatThoughtDuration, regenerate, stopStreaming } from '../ui/transcript.js';

async function runProjectInstruction(text) {
  const issue = validateProjectSetup();
  if (issue) {
    appendError(`Project setup: ${issue}`);
    openSidebar();
    setSidebarPanel('project');
    return;
  }
  pjEmit({ type: 'user', text });
  await runProjectSession(text);
}

/* ---------- project export ---------- */
function exportProjectJournal(fmt) {
  if (!projectJournal.length) {
    flashStatus('Nothing to export', 1200);
    return;
  }
  const stamp = `project-${(activeProject?.name || 'tarka').replace(/[^\w-]+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${fmt === 'md' ? 'md' : fmt === 'json' ? 'json' : 'txt'}`;
  if (fmt === 'json') {
    downloadBlob(new Blob([JSON.stringify(projectJournal, null, 2)], { type: 'application/json' }), stamp);
  } else {
    const lines = projectJournal.map((e) => {
      const l = pjJournalLineForPrompt(e);
      return fmt === 'md' && e.type === 'report' ? `## Final report (${e.name})\n\n${e.text}` : l;
    }).filter(Boolean);
    downloadBlob(new Blob([lines.join(fmt === 'md' ? '\n\n' : '\n')], { type: 'text/plain;charset=utf-8' }), stamp);
  }
  flashStatus('Exported ✓');
}

/* ============================================================
   INSPECTOR — the right-hand pane, and the reason this layout
   exists: the debate arena and the project workspace stop living
   inside the transcript. They dock here while they are live, so a
   40-turn session stays navigable and the answer column stays
   clean; when the run ends the arena collapses back into the
   message, where history and export expect it.
   ============================================================ */
const INSPECTOR_KEY = 'customChatInspector';

const DRAWER_KEY = 'customChatDrawer';

const INSP_TITLES = { solo: 'Session', debate: 'Debate arena', project: 'Workspace' };
/** Matches the CSS breakpoint below which the inspector is not rendered */
const inspectorMq = window.matchMedia('(min-width: 1241px)');

let inspectorOpen = true;
/** Arena currently living in the inspector: { el, msgBody, bubble, ref } */
let dockedArena = null;
/** Cached project file listing for the workspace pane */
let projectFiles = [];

let projectFilesError = '';

let projectFilesInflight = false;

let projectTurnNow = 0;

let projectTurnMax = 0;

function currentMode() {
  if (typeof projectMode !== 'undefined' && projectMode.enabled) return 'project';
  if (typeof debateSettings !== 'undefined' && debateSettings.enabled) return 'debate';
  return 'solo';
}

/** Enabled AND wide enough to actually be on screen */
function inspectorVisible() {
  return inspectorOpen && inspectorMq.matches;
}

function setInspectorOpen(open, { persist = true } = {}) {
  inspectorOpen = !!open;
  const el = $('#inspector');
  if (el) el.hidden = !inspectorOpen;
  $('#inspToggle')?.setAttribute('aria-pressed', inspectorOpen ? 'true' : 'false');
  if (persist) {
    try {
      localStorage.setItem(INSPECTOR_KEY, inspectorOpen ? '1' : '0');
    } catch {
      /* quota */
    }
  }
  reflowArena();
  if (inspectorOpen) updateInspector();
}

/** Show the pane for the active mode and refresh whatever it displays */
function updateInspector() {
  const el = $('#inspector');
  if (!el) return;
  const mode = currentMode();
  el.querySelectorAll('.insp-pane').forEach((pane) => {
    pane.hidden = pane.dataset.insp !== mode;
  });
  const title = $('#inspTitle');
  if (title) title.textContent = INSP_TITLES[mode] || 'Session';
  if (!inspectorOpen) return;
  if (mode === 'project') renderProjectInspector();
  else if (mode === 'solo') updateInspectorSession();
}

/* ---------- solo: what the next request will actually look like ---------- */
function updateInspectorSession(usage, srcLabel) {
  if (!inspectorOpen || currentMode() !== 'solo') return;
  const gauge = $('#inspGauge');
  if (!gauge) return;
  const u = usage || getContextUsage();
  const src =
    srcLabel ||
    { provider: 'API', manual: 'manual', known: 'known', 'name-hint': 'name' }[u.source] ||
    'default';
  const cfg = getConfig();
  const set = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text;
  };

  set('#inspCtxUsed', formatTokenCount(Math.round(u.used)));
  set('#inspCtxLimit', ` / ${formatTokenCount(u.limit)}`);
  set('#inspCtxSrc', src);
  set('#inspCtxPct', `${Math.round(u.pct)}% used`);
  set('#inspCtxRemain', `${formatTokenCount(u.remaining)} remaining`);
  const fill = $('#inspCtxFill');
  if (fill) fill.style.width = `${Math.min(100, Math.max(1, u.pct)).toFixed(1)}%`;
  gauge.dataset.level = u.pct >= 95 ? 'critical' : u.pct >= 80 ? 'warn' : 'ok';

  set('#inspIn', u.lastIn != null ? formatTokenCount(u.lastIn) : '—');
  set('#inspOut', u.lastOut != null ? formatTokenCount(u.lastOut) : '—');
  set('#inspTps', lastGenStats?.tps > 0 ? `${lastGenStats.tps} t/s` : '—');
  set('#inspThink', lastThinkMs ? formatThoughtDuration(lastThinkMs) : '—');

  set('#inspProvider', cfg.providerName || '—');
  set('#inspModel', cfg.model || '—');
  set(
    '#inspReasoning',
    cfg.reasoningEffort === 'none' ? 'off' : `{ effort: ${cfg.reasoningEffort} }`
  );
  set('#inspTemp', String(cfg.temperature));
  set('#inspMax', cfg.maxTokens ? formatTokenCount(cfg.maxTokens) : 'default');
  set('#inspMsgs', `${messages.length}${cfg.systemPrompt.trim() ? ' + system' : ''}`);
}

/* ---------- debate: the live arena docks here ---------- */
function buildLiveArenaRef() {
  const ref = document.createElement('button');
  ref.type = 'button';
  ref.className = 'debate-live-ref';
  ref.innerHTML = '<b>⚔ Team debating</b> — the arena is open in the inspector<span>view →</span>';
  ref.addEventListener('click', () => {
    if (!inspectorOpen) setInspectorOpen(true);
    $('#inspector')?.scrollIntoView({ block: 'nearest' });
  });
  return ref;
}

function clearInspectorArena() {
  const host = $('#inspDebateBody');
  if (!host) return;
  host.querySelectorAll('.debate-panel').forEach((el) => el.remove());
  const empty = $('#inspDebateEmpty');
  if (empty) empty.hidden = false;
}

/** Put a fresh arena where it can be watched: inspector if visible, else inline */
function mountArena(arenaEl, msgBody, bubble) {
  const host = $('#inspDebateBody');
  if (inspectorVisible() && host) {
    clearInspectorArena();
    const empty = $('#inspDebateEmpty');
    if (empty) empty.hidden = true;
    host.appendChild(arenaEl);
    const ref = buildLiveArenaRef();
    msgBody.insertBefore(ref, bubble);
    dockedArena = { el: arenaEl, msgBody, bubble, ref };
    updateInspector();
    return;
  }
  msgBody.insertBefore(arenaEl, bubble);
}

/** Run finished: the transcript belongs with the answer (history + export) */
function dockArenaIntoMessage() {
  if (!dockedArena) return;
  const { el, msgBody, bubble, ref } = dockedArena;
  dockedArena = null;
  if (ref && ref.parentNode) ref.remove();
  if (msgBody && msgBody.isConnected) {
    const credit = msgBody.querySelector('.debate-credit');
    const anchor = credit || (bubble && bubble.parentNode === msgBody ? bubble : null);
    if (anchor) msgBody.insertBefore(el, anchor);
    else msgBody.insertBefore(el, msgBody.firstChild);
  } else {
    el.remove();
  }
  clearInspectorArena();
}

/** Inspector hidden or window narrowed mid-debate → fall back to inline.
 * Opening the inspector mid-debate remounts a live arena that was inline. */
function reflowArena() {
  if (inspectorVisible()) {
    if (dockedArena) return;
    const live = document.querySelector('#messages .debate-panel.thinking');
    if (!live) return;
    const msgBody = live.closest('.msg-body');
    const bubble = msgBody?.querySelector('.bubble');
    if (msgBody && bubble) mountArena(live, msgBody, bubble);
    return;
  }
  if (!dockedArena) return;
  const { el, msgBody, bubble, ref } = dockedArena;
  dockedArena = null;
  if (ref && ref.parentNode) ref.remove();
  if (msgBody && msgBody.isConnected) {
    if (bubble && bubble.parentNode === msgBody) msgBody.insertBefore(el, bubble);
    else msgBody.appendChild(el);
  }
  clearInspectorArena();
}

/* ---------- project: files · tasks · decisions ---------- */
/** Paths this session actually wrote — surfaced in the tree */

/* ---------- project: files · tasks · decisions ---------- */
/** Paths this session actually wrote — surfaced in the tree */
function projectTouchedPaths() {
  const out = new Set();
  for (const e of projectJournal) {
    if (e && e.type === 'tool' && ['write', 'append', 'edit'].includes(e.tool) && e.args?.path) {
      out.add(String(e.args.path).replace(/^\/+/, ''));
    }
  }
  return out;
}

async function refreshProjectFiles() {
  if (!activeProject || projectFilesInflight) return;
  projectFilesInflight = true;
  try {
    const data = await pjApi('/api/project/fs', { id: activeProject.id, op: 'list', path: '' });
    projectFiles = (data.result?.entries || []).slice(0, 300);
    projectFilesError = '';
  } catch (e) {
    projectFiles = [];
    projectFilesError = e.message || 'list failed';
  } finally {
    projectFilesInflight = false;
  }
  renderProjectTree();
}

function renderProjectTree() {
  const wrap = $('#inspProjTree');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!activeProject) {
    wrap.innerHTML = '<div class="tree-empty">No project selected</div>';
    return;
  }
  if (projectFilesError) {
    wrap.innerHTML = '<div class="tree-empty">Couldn’t list files — tap refresh</div>';
    return;
  }
  if (!projectFiles.length) {
    wrap.innerHTML = '<div class="tree-empty">Empty folder</div>';
    return;
  }
  const touched = projectTouchedPaths();
  const frag = document.createDocumentFragment();
  projectFiles.slice(0, 200).forEach((en) => {
    const raw = String(en.path || '');
    const clean = raw.replace(/\/$/, '');
    const depth = clean.split('/').length - 1;
    const row = document.createElement('div');
    row.className =
      'tree-row' + (en.dir ? ' dir' : '') + (!en.dir && touched.has(raw) ? ' touched' : '');
    row.style.paddingLeft = `${7 + depth * 12}px`;
    row.title = raw;
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = clean.split('/').pop() + (en.dir ? '/' : '');
    row.appendChild(name);
    if (en.skipped) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = 'skipped';
      row.appendChild(sz);
    } else if (!en.dir) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = en.size >= 1024 ? `${(en.size / 1024).toFixed(1)}k` : `${en.size || 0}b`;
      row.appendChild(sz);
    }
    if (!en.dir && touched.has(raw)) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'touched';
      row.appendChild(tag);
    }
    frag.appendChild(row);
  });
  wrap.appendChild(frag);
}

function renderProjectDecisions() {
  const wrap = $('#inspProjDecisions');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!projectDecisions.length) {
    wrap.innerHTML = '<div class="tree-empty">No decisions recorded yet</div>';
    return;
  }
  [...projectDecisions]
    .slice(-40)
    .reverse()
    .forEach((d) => {
      const div = document.createElement('div');
      div.className = 'pj-decision';
      div.style.marginBottom = '8px';
      div.innerHTML =
        '<span class="pj-dec-star">★</span><span class="pj-dec-text"></span><span class="pj-dec-by"></span>';
      div.querySelector('.pj-dec-text').textContent = d.text || '';
      div.querySelector('.pj-dec-by').textContent = d.by || '';
      wrap.appendChild(div);
    });
}

function renderProjectInspector() {
  if (!inspectorOpen) return;
  const set = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text;
  };
  const seats = activeProject ? projectSeats() : [];
  const folderEl = $('#inspProjFolder');
  if (folderEl) {
    folderEl.textContent = activeProject ? activeProject.folder : 'no project';
    folderEl.title = activeProject ? activeProject.folder : '';
  }
  set(
    '#inspProjTurn',
    projectBusy
      ? `${projectTurnNow} / ${projectTurnMax}`
      : activeProject
        ? `idle · max ${activeProject.settings?.maxTurns || 24}`
        : '—'
  );
  set('#inspProjMembers', seats.length ? seats.map((s) => s.name).join(' · ') : '—');
  set(
    '#inspProjReasoning',
    activeProject
      ? activeProject.settings?.reasoning === 'none'
        ? 'off'
        : `inherit (${getConfig().reasoningEffort})`
      : '—'
  );
  set('#inspProjTools', String(projectJournal.filter((e) => e && e.type === 'tool').length));
  const stop = $('#inspProjStop');
  if (stop) stop.disabled = !projectBusy;
  renderProjectTasksList();
  renderProjectDecisions();
  renderProjectTree();
}

/* ---------- wiring ---------- */
function initInspector() {
  try {
    inspectorOpen = localStorage.getItem(INSPECTOR_KEY) !== '0';
  } catch {
    inspectorOpen = true;
  }
  setInspectorOpen(inspectorOpen, { persist: false });

  $('#inspToggle')?.addEventListener('click', () => setInspectorOpen(!inspectorOpen));
  $('#inspClose')?.addEventListener('click', () => setInspectorOpen(false));
  $('#railCmdk')?.addEventListener('click', () => openCmdk());

  document.querySelectorAll('.insp-tab').forEach((tab) => {
    tab.setAttribute('aria-selected', tab.classList.contains('on') ? 'true' : 'false');
    tab.addEventListener('click', () => {
      document.querySelectorAll('.insp-tab').forEach((t) => {
        const on = t === tab;
        t.classList.toggle('on', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('[data-ppane]').forEach((pane) => {
        pane.hidden = pane.dataset.ppane !== tab.dataset.ptab;
      });
    });
  });

  $('#inspRegen')?.addEventListener('click', () => {
    const list = messagesEl.querySelectorAll('.msg.assistant:not(.msg-orphan)');
    const last = list[list.length - 1];
    if (last) regenerate(last);
    else flashStatus('Nothing to regenerate');
  });
  $('#inspExport')?.addEventListener('click', () => exportChat('md'));
  $('#inspDetect')?.addEventListener('click', () => detectContextFromProvider({ silent: false, force: true }));
  $('#inspProjStop')?.addEventListener('click', () => {
    if (isStreaming) stopStreaming();
  });
  $('#inspProjRefresh')?.addEventListener('click', () => refreshProjectFiles());

  // Crossing the breakpoint must not strand a live arena off-screen
  inspectorMq.addEventListener?.('change', () => {
    reflowArena();
    if (inspectorOpen) updateInspector();
  });

  updateInspector();
}

function setProjectTurnNow(v) { projectTurnNow = v; return v; }
function setProjectTurnMax(v) { projectTurnMax = v; return v; }

export { DRAWER_KEY, INSPECTOR_KEY, INSP_TITLES, buildLiveArenaRef, clearInspectorArena, currentMode, dockArenaIntoMessage, dockedArena, exportProjectJournal, initInspector, inspectorMq, inspectorOpen, inspectorVisible, mountArena, projectFiles, projectFilesInflight, projectTouchedPaths, projectTurnMax, projectTurnNow, reflowArena, refreshProjectFiles, renderProjectDecisions, renderProjectInspector, renderProjectTree, runProjectInstruction, setInspectorOpen, updateInspector, updateInspectorSession, setProjectTurnMax, setProjectTurnNow };
