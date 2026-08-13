import { debateSettings, saveDebateSettings } from '../debate/settings.js';
import { buildSeatModelField } from '../debate/ui.js';
import { renderProjectPanel, renderProjectThread } from '../project/journal.js';
import { activeProviderId, providerAccessIssue, providers } from '../providers.js';
import { renderHistoryFromState } from '../sessions.js';
import { $, abortController, sidebar, userInput } from '../state.js';
import { refreshProjectFiles, updateInspector } from '../ui/inspector.js';
import { openSidebar, setSidebarPanel } from '../ui/sidebar.js';
import { appendError, flashStatus, sweepReasoningTimers, updateScrollFab } from '../ui/transcript.js';

function updateComposerPlaceholder() {
  if (typeof projectMode !== 'undefined' && projectMode.enabled) {
    userInput.placeholder = 'Instruct the team… they will read, write & run inside the project folder';
  } else if (debateSettings.enabled) {
    userInput.placeholder = 'Describe the task for the team…';
  } else {
    userInput.placeholder = 'Message… Enter to send · Shift+Enter newline';
  }
}

function updateDebateToggleUi() {
  const btn = $('#debateToggle');
  if (!btn) return;
  const on = !!debateSettings.enabled;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  updateComposerPlaceholder();
  updateModeStrip();
}

/* ============================================================
   PROJECT MODE — a team of 2–4 models builds inside one assigned
   folder: real files, real commands, shared task board, decisions,
   persistent journal. Orchestrated here in the browser (keys never
   leave it); the server only provides sandboxed fs/exec/state.
   ============================================================ */
const PROJECT_MODE_KEY = 'customChatProjectMode';

let projectMode = { enabled: false, activeId: '' };
/** @type {{id:string,name:string,folder:string,exists?:boolean}[]} */
let projectList = [];
/** Full active project: { id, name, folder, team, settings, lastSeat } */
let activeProject = null;

let projectTasks = [];

let projectDecisions = [];

let projectJournal = [];

let projectBusy = false;
/** Bumped when leaving project mode / switching projects — stale guard */
let projectRun = 0;

let projectShowRoles = false;

let projectTeamSaveTimer = null;

function saveProjectModeLS() {
  try {
    localStorage.setItem(PROJECT_MODE_KEY, JSON.stringify({ enabled: projectMode.enabled, activeId: projectMode.activeId }));
  } catch { /* quota */ }
}

function loadProjectModeLS() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECT_MODE_KEY) || '{}');
    projectMode.enabled = !!raw.enabled;
    projectMode.activeId = String(raw.activeId || '');
  } catch { /* defaults */ }
}

/**
 * Project endpoint call. Pass the session's AbortSignal for anything an agent
 * triggers: the server kills a running command's whole process group when the
 * request socket closes, so Stop only actually stops if the fetch is abortable.
 */

/**
 * Project endpoint call. Pass the session's AbortSignal for anything an agent
 * triggers: the server kills a running command's whole process group when the
 * request socket closes, so Stop only actually stops if the fetch is abortable.
 */
async function pjApi(pathname, body, signal) {
  const res = await fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function pjPersistJournal(events) {
  if (!activeProject) return;
  pjApi('/api/project/journal', { id: activeProject.id, events }).catch(() => {
    flashStatus('⚠ Could not save project journal', 2500);
  });
}

/* ---------- team seats ---------- */
/** One derivation for both the display name and the dedupe comparison — a
 * truncated `base` compared against untruncated others let two seats on the
 * same long model name collapse into one identity. */
function seatBaseName(member, idx) {
  let base = (member.name || '').trim();
  if (!base) {
    const seg = String(member.model || '').split('/').pop().split(':')[0];
    base = seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : `Member ${idx + 1}`;
    base = base.slice(0, 24);
  }
  return base;
}

function projectSeatName(member, idx, team) {
  const base = seatBaseName(member, idx);
  // Dedupe repeated derived names (two seats on the same model)
  let n = 1;
  for (let j = 0; j < idx; j++) {
    if (seatBaseName(team[j], j).toLowerCase() === base.toLowerCase()) n++;
  }
  return n > 1 ? `${base} ${n}` : base;
}

/**
 * Seat names must be UNIQUE: a handoff is addressed by name (`TO: <Name>`) and
 * resolved with `find`, so two seats answering to the same string make the
 * later one unreachable — every handoff aimed at it lands on the earlier seat.
 * The per-seat dedupe can still collide once names are normalized (an explicit
 * "Ada 2" alongside a derived "Ada 2", or "A|B" and "A B" both becoming "A B"),
 * so uniqueness is settled here, after normalization, where it is observable.
 */
function uniqueSeatNames(names) {
  const seen = new Set();
  return names.map((raw, i) => {
    let name = raw || `Member ${i + 1}`;
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      return name;
    }
    for (let n = 2; ; n++) {
      const candidate = `${name} ${n}`;
      if (!seen.has(candidate.toLowerCase())) {
        seen.add(candidate.toLowerCase());
        return candidate;
      }
    }
  });
}

function projectSeats() {
  const team = Array.isArray(activeProject?.team) ? activeProject.team.slice(0, 4) : [];
  const names = uniqueSeatNames(
    team.map((m, i) => projectSeatName(m, i, team).replace(/\|/g, ' ').trim())
  );
  return team.map((m, i) => ({
    i,
    name: names[i],
    model: String(m.model || '').trim(),
    role: String(m.role || '').trim(),
    provider: providers.length === 1 ? providers[0] : providers.find((p) => p.id === m.providerId)
  }));
}

function validateProjectSetup() {
  if (!activeProject) return 'no project selected — create or pick one in the Project panel.';
  const seats = projectSeats();
  if (seats.length < 2) return 'a project team needs at least 2 members.';
  for (const s of seats) {
    if (!s.model) return `${s.name} has no model — pick one in the Project panel.`;
    if (!s.provider) return `${s.name} has no provider selected.`;
    const access = providerAccessIssue(s.provider, s.name);
    if (access) return access;
  }
  return null;
}

/* ---------- mode management ---------- */
function updateProjectToggleUi() {
  const btn = $('#projectToggle');
  if (!btn) return;
  const on = !!projectMode.enabled;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  updateComposerPlaceholder();
  updateModeStrip();
}

/** Mode-aware topbar: solo chips ↔ debate strip ↔ project strip */
function updateModeStrip() {
  if (typeof updateInspector === 'function') updateInspector();
  const solo = $('#soloStrip');
  const strip = $('#modeStrip');
  if (!solo || !strip) return;
  if (typeof projectMode !== 'undefined' && projectMode.enabled) {
    const n = activeProject ? projectSeats().length : 0;
    const name = activeProject ? activeProject.name : 'no project';
    const folder = activeProject ? '…/' + String(activeProject.folder || '').split('/').filter(Boolean).slice(-1)[0] : '';
    strip.innerHTML = '';
    const mk = (txt, cls) => {
      const s = document.createElement('span');
      s.className = 'mode-chip' + (cls ? ' ' + cls : '');
      s.textContent = txt;
      strip.appendChild(s);
    };
    mk('▦ Project', 'mode-chip-label project');
    mk(name, 'mode-chip-strong');
    if (n) mk(`${n} members`);
    if (folder) mk(folder, 'mode-chip-mono');
    if (projectBusy) mk('working…', 'mode-chip-live');
    solo.hidden = true;
    strip.hidden = false;
    strip.onclick = () => { openSidebar(); setSidebarPanel('project'); };
  } else if (debateSettings.enabled) {
    const n = debateSettings.experts.length;
    const fin = debateSettings.finalAnswerMode === 'judge' ? 'judge' : 'nominated';
    strip.innerHTML = '';
    const mk = (txt, cls) => {
      const s = document.createElement('span');
      s.className = 'mode-chip' + (cls ? ' ' + cls : '');
      s.textContent = txt;
      strip.appendChild(s);
    };
    mk('⚔ Debate', 'mode-chip-label debate');
    mk(`${n} experts`, 'mode-chip-strong');
    mk(`${debateSettings.maxRounds} rounds`);
    mk(`final: ${fin}`);
    solo.hidden = true;
    strip.hidden = false;
    strip.onclick = () => { openSidebar(); setSidebarPanel('debate'); };
  } else {
    solo.hidden = false;
    strip.hidden = true;
    strip.onclick = null;
  }
}

function setProjectMode(on, { silent = false } = {}) {
  if (on === projectMode.enabled) {
    updateProjectToggleUi();
    return;
  }
  if (on) {
    if (debateSettings.enabled) {
      debateSettings.enabled = false;
      saveDebateSettings();
      updateDebateToggleUi();
    }
    projectMode.enabled = true;
    saveProjectModeLS();
    updateProjectToggleUi();
    refreshProjectFiles();
    renderProjectThread();
    if (!silent) flashStatus(activeProject ? `Project → ${activeProject.name}` : 'Project mode — pick a project in the sidebar');
  } else {
    projectRun++; // stale-guard any in-flight session rendering
    // A live session must actually STOP, not just go stale — otherwise its
    // in-flight upstream call (and any command it started) keeps running.
    if (projectBusy && abortController) {
      try { abortController.abort(); } catch { /* already gone */ }
    }
    sweepReasoningTimers();
    projectMode.enabled = false;
    projectBusy = false;
    saveProjectModeLS();
    updateProjectToggleUi();
    renderHistoryFromState();
    updateScrollFab();
    if (!silent) flashStatus('Project mode off');
  }
}

/* ---------- project CRUD / panel ---------- */
async function refreshProjectList() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json().catch(() => ({}));
    projectList = Array.isArray(data.projects) ? data.projects : [];
  } catch {
    projectList = [];
  }
  const sel = $('#projectSelect');
  if (sel) {
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = projectList.length ? 'Select a project…' : 'No projects yet';
    sel.appendChild(opt0);
    projectList.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.exists === false ? `${p.name} (folder missing)` : p.name;
      sel.appendChild(opt);
    });
    sel.value = projectMode.activeId && projectList.some((p) => p.id === projectMode.activeId) ? projectMode.activeId : '';
  }
}

async function selectProject(id, { render = true } = {}) {
  projectRun++;
  // Same as toggling the mode off: a live session on the OLD project must die
  if (projectBusy && abortController) {
    try { abortController.abort(); } catch { /* already gone */ }
  }
  sweepReasoningTimers();
  if (!id) {
    activeProject = null;
    projectTasks = [];
    projectDecisions = [];
    projectJournal = [];
    projectMode.activeId = '';
    saveProjectModeLS();
    renderProjectPanel();
    updateModeStrip();
    if (render && projectMode.enabled) renderProjectThread();
    return;
  }
  try {
    const data = await pjApi('/api/project/state', { id, maxEvents: 500 });
    activeProject = data.project;
    projectTasks = Array.isArray(data.tasks) ? data.tasks : [];
    projectDecisions = Array.isArray(data.decisions) ? data.decisions : [];
    // Fire-and-forget persistence can land events out of order in the file;
    // every event carries `t`, so restore display order here (stable sort
    // keeps file order for same-ms ties)
    projectJournal = (Array.isArray(data.journal) ? data.journal : [])
      .slice()
      .sort((a, b) => (a?.t || 0) - (b?.t || 0));
    projectMode.activeId = id;
    saveProjectModeLS();
  } catch (e) {
    appendError(`Project: ${e.message}`);
    // Clear the PREVIOUS project's state too — leaving it renders A's journal
    // and task board under a panel that says no project is selected.
    activeProject = null;
    projectTasks = [];
    projectDecisions = [];
    projectJournal = [];
  }
  renderProjectPanel();
  updateModeStrip();
  refreshProjectFiles();
  if (render && projectMode.enabled) renderProjectThread();
}

function scheduleProjectTeamSave() {
  clearTimeout(projectTeamSaveTimer);
  projectTeamSaveTimer = setTimeout(() => {
    if (!activeProject) return;
    pjApi('/api/projects/update', {
      id: activeProject.id,
      patch: { team: activeProject.team, settings: activeProject.settings }
    }).catch(() => flashStatus('⚠ Could not save project settings', 2500));
  }, 600);
}

function projectCostHintText() {
  const n = activeProject ? Math.max(projectSeats().length, 2) : 2;
  const t = activeProject?.settings?.maxTurns || 24;
  return `One work session ≈ up to ${t} turns across ${n} members, each turn up to 8 tool steps (file ops are free; commands run automatically inside the folder). Stop ends the session instantly.`;
}

/** Task board renders into the sidebar panel and the inspector's Tasks tab */
function renderProjectTasksList() {
  const targets = [$('#projectTasks'), $('#inspProjTasks')].filter(Boolean);
  if (!targets.length) return;
  const icon = { todo: '○', doing: '◐', done: '●' };
  for (const ul of targets) {
    ul.innerHTML = '';
    if (!projectTasks.length) {
      ul.innerHTML = '<li class="project-task-empty">No tasks yet — the team creates them while working</li>';
      continue;
    }
    projectTasks.slice(0, 60).forEach((t) => {
      const li = document.createElement('li');
      li.className = `project-task st-${t.status || 'todo'}`;
      li.innerHTML = '<span class="pt-ic"></span><span class="pt-title"></span><span class="pt-by"></span>';
      li.querySelector('.pt-ic').textContent = icon[t.status] || '○';
      li.querySelector('.pt-title').textContent = t.title || '';
      li.querySelector('.pt-by').textContent = t.by ? `· ${t.by}` : '';
      ul.appendChild(li);
    });
  }
}

function renderProjectSeats() {
  const wrap = $('#projectSeats');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!activeProject) return;
  if (!Array.isArray(activeProject.team)) activeProject.team = [];
  // A usable team needs 2 seats minimum — scaffold them
  while (activeProject.team.length < 2) {
    activeProject.team.push({ name: '', model: '', providerId: activeProviderId || providers[0]?.id || '', role: '' });
  }
  const multiProvider = providers.length >= 2;

  activeProject.team.slice(0, 4).forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'debate-seat project-seat';
    card.style.setProperty('--seat-c', `var(--debate-c${i % 4})`);

    const head = document.createElement('div');
    head.className = 'debate-seat-head';
    head.innerHTML =
      '<i class="seat-dot" aria-hidden="true"></i><span class="seat-title"></span>' +
      '<button type="button" class="icon-btn small seat-remove" title="Remove member" aria-label="Remove member">✕</button>';
    head.querySelector('.seat-title').textContent = projectSeatName(m, i, activeProject.team);
    const removeBtn = head.querySelector('.seat-remove');
    removeBtn.hidden = activeProject.team.length <= 2;
    removeBtn.addEventListener('click', () => {
      activeProject.team.splice(i, 1);
      scheduleProjectTeamSave();
      renderProjectSeats();
      updateModeStrip();
    });
    card.appendChild(head);

    const addField = (labelText, el) => {
      const label = document.createElement('label');
      label.appendChild(document.createTextNode(labelText));
      label.appendChild(el);
      card.appendChild(label);
    };

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = m.name || '';
    nameInput.placeholder = 'Name (optional — auto from model)';
    nameInput.addEventListener('input', () => {
      m.name = nameInput.value;
      scheduleProjectTeamSave();
    });
    addField('Name', nameInput);

    if (providers.length) {
      if (!providers.some((p) => p.id === m.providerId)) {
        m.providerId = activeProviderId || providers[0].id;
      }
      if (multiProvider) {
        const sel = document.createElement('select');
        sel.className = 'seat-provider-select';
        providers.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          sel.appendChild(opt);
        });
        sel.value = m.providerId;
        sel.addEventListener('change', () => {
          m.providerId = sel.value;
          scheduleProjectTeamSave();
          const mi = card.querySelector('.seat-model-input');
          if (mi && mi._modelPickerRefresh) mi._modelPickerRefresh();
        });
        addField('Provider', sel);
      }
    }

    const modelWrap = buildSeatModelField(m, {
      getProviderId: () => (providers.length === 1 ? providers[0]?.id : m.providerId || activeProviderId),
      onChange: () => scheduleProjectTeamSave()
    });
    addField('Model', modelWrap);
    // Project seats persist server-side, not via debate settings
    const mInput = modelWrap.querySelector('input');
    if (mInput) mInput.addEventListener('input', () => scheduleProjectTeamSave());

    if (projectShowRoles) {
      const roleInput = document.createElement('textarea');
      roleInput.rows = 2;
      roleInput.value = m.role || '';
      roleInput.placeholder = 'Optional focus, e.g. "frontend & styling" — leave empty for full self-organization';
      roleInput.addEventListener('input', () => {
        m.role = roleInput.value;
        scheduleProjectTeamSave();
      });
      addField('Role (optional)', roleInput);
    }

    wrap.appendChild(card);
  });

  const addBtn = $('#projAddMember');
  if (addBtn) addBtn.hidden = activeProject.team.length >= 4;
}

function setProjectDecisions(v) { projectDecisions = v; return v; }
function setProjectBusy(v) { projectBusy = v; return v; }

function setProjectRun(v) { projectRun = v; return v; }

function setProjectShowRoles(v) { projectShowRoles = v; return v; }

export { PROJECT_MODE_KEY, activeProject, loadProjectModeLS, pjApi, pjPersistJournal, projectBusy, projectCostHintText, projectDecisions, projectJournal, projectList, projectMode, projectRun, projectSeatName, projectSeats, projectShowRoles, projectTasks, projectTeamSaveTimer, refreshProjectList, renderProjectSeats, renderProjectTasksList, saveProjectModeLS, scheduleProjectTeamSave, selectProject, setProjectBusy, setProjectDecisions, setProjectMode, setProjectRun, setProjectShowRoles, updateComposerPlaceholder, updateDebateToggleUi, updateModeStrip, updateProjectToggleUi, validateProjectSetup };
