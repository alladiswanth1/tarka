import { escapeHtml, renderMarkdown } from '../markdown.js';
import { activeProject, pjPersistJournal, projectCostHintText, projectJournal, renderProjectSeats, renderProjectTasksList } from '../project/state.js';
import { $, messagesEl } from '../state.js';
import { markStreamUnread, scrollToBottom, setStickToBottom, stickToBottom, updateScrollFab } from '../ui/transcript.js';

function renderProjectPanel() {
  const details = $('#projectDetails');
  const meta = $('#projectMeta');
  if (!details) return;
  const sel = $('#projectSelect');
  if (sel) sel.value = activeProject ? activeProject.id : '';
  if (!activeProject) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  if (meta) {
    meta.innerHTML = '';
    const name = document.createElement('div');
    name.className = 'project-meta-name';
    name.textContent = activeProject.name;
    const folder = document.createElement('div');
    folder.className = 'project-meta-folder';
    folder.textContent = activeProject.folder;
    folder.title = activeProject.folder;
    meta.appendChild(name);
    meta.appendChild(folder);
  }
  const mt = $('#projMaxTurns');
  if (mt) mt.value = activeProject.settings?.maxTurns || 24;
  const rs = $('#projReasoning');
  if (rs) rs.value = activeProject.settings?.reasoning === 'none' ? 'none' : 'inherit';
  renderProjectSeats();
  renderProjectTasksList();
  const hint = $('#projectCostHint');
  if (hint) hint.textContent = projectCostHintText();
}

/* ---------- journal thread rendering ---------- */
const PJ_TOOL_ICONS = {
  read_file: '▤', list_files: '⊞', run: '❯', mkdir: '⊕', move: '⇄', delete: '⌫',
  write: '✎', append: '✚', edit: '✂', task_add: '☑', task_update: '☑', decision: '★', debate: '⚔'
};

function pjToolLabel(tool, args = {}) {
  switch (tool) {
    case 'read_file': return `read ${args.path || ''}`;
    case 'list_files': return `list ${args.path || '/'}`;
    case 'run': return `run: ${String(args.command || '').slice(0, 80)}`;
    case 'mkdir': return `mkdir ${args.path || ''}`;
    case 'move': return `move ${args.path || ''} → ${args.to || ''}`;
    case 'delete': return `delete ${args.path || ''}`;
    case 'write': return `write ${args.path || ''}`;
    case 'append': return `append ${args.path || ''}`;
    case 'edit': return `edit ${args.path || ''}`;
    case 'task_add': return `task + ${String(args.title || '').slice(0, 60)}`;
    case 'task_update': return `task ${args.id || ''} → ${args.status || ''}`;
    case 'decision': return `decision recorded`;
    case 'debate': return `team debate: ${String(args.question || '').slice(0, 60)}`;
    default: return tool;
  }
}

function pjSeatColor(i) {
  return `var(--debate-c${(i ?? 0) % 4})`;
}

function pjToolCardDom(e) {
  const card = document.createElement('div');
  card.className = 'pj-tool' + (e.ok === false ? ' err' : '');
  card.innerHTML =
    '<button type="button" class="pj-tool-head">' +
    '<span class="pj-tool-ic"></span><span class="pj-tool-label"></span>' +
    '<span class="pj-tool-status"></span><span class="pj-tool-chev">▾</span>' +
    '</button><div class="pj-tool-body" hidden><pre></pre></div>';
  card.querySelector('.pj-tool-ic').textContent = PJ_TOOL_ICONS[e.tool] || '⚙';
  card.querySelector('.pj-tool-label').textContent = pjToolLabel(e.tool, e.args);
  card.querySelector('.pj-tool-status').textContent =
    e.ok === false ? 'error' : e.ms != null ? `${e.ms >= 1000 ? (e.ms / 1000).toFixed(1) + 's' : e.ms + 'ms'}` : 'ok';
  card.querySelector('pre').textContent = e.detail || '(no output)';
  card.querySelector('.pj-tool-head').addEventListener('click', () => {
    const b = card.querySelector('.pj-tool-body');
    b.hidden = !b.hidden;
    card.classList.toggle('open', !b.hidden);
  });
  return card;
}

function pjTurnShellDom(name, seatI) {
  const turn = document.createElement('div');
  turn.className = 'pj-turn';
  turn.style.setProperty('--turn-c', pjSeatColor(seatI));
  turn.innerHTML = '<div class="pj-turn-head"><i class="pj-turn-dot"></i><b class="pj-turn-name"></b></div><div class="pj-turn-body"></div>';
  turn.querySelector('.pj-turn-name').textContent = name;
  return turn;
}

function journalEventDom(e) {
  if (e.type === 'user') {
    const div = document.createElement('div');
    div.className = 'msg user is-restored';
    div.innerHTML = '<div class="avatar">You</div><div class="msg-body"><div class="bubble"></div></div>';
    div.querySelector('.bubble').textContent = e.text || '';
    return div;
  }
  if (e.type === 'say' || e.type === 'report') {
    const turn = pjTurnShellDom(e.name || 'Agent', e.seat);
    if (e.type === 'report') turn.classList.add('pj-report');
    const bubble = document.createElement('div');
    bubble.className = 'bubble pj-bubble';
    bubble.innerHTML = renderMarkdown(e.text || '');
    turn.querySelector('.pj-turn-body').appendChild(bubble);
    return turn;
  }
  if (e.type === 'tool') {
    const turn = pjTurnShellDom(e.name || 'Agent', e.seat);
    turn.classList.add('pj-tool-turn');
    turn.querySelector('.pj-turn-body').appendChild(pjToolCardDom(e));
    return turn;
  }
  if (e.type === 'decision') {
    const div = document.createElement('div');
    div.className = 'pj-decision';
    div.innerHTML = '<span class="pj-dec-star">★</span><span class="pj-dec-text"></span><span class="pj-dec-by"></span>';
    div.querySelector('.pj-dec-text').textContent = e.text || '';
    div.querySelector('.pj-dec-by').textContent = e.by ? `— ${e.by}` : '';
    return div;
  }
  if (e.type === 'council') {
    const div = document.createElement('div');
    div.className = 'pj-council';
    const head = document.createElement('div');
    head.className = 'pj-council-head';
    head.textContent = `⚔ Team debate — ${e.question || ''}`;
    div.appendChild(head);
    (e.takes || []).forEach((t, k) => {
      const row = document.createElement('div');
      row.className = 'pj-council-take';
      row.style.setProperty('--turn-c', pjSeatColor(t.seat != null ? t.seat : k));
      row.innerHTML = '<b></b><p></p>';
      row.querySelector('b').textContent = t.name || '';
      row.querySelector('p').textContent = t.text || '';
      div.appendChild(row);
    });
    return div;
  }
  if (e.type === 'session') {
    const div = document.createElement('div');
    div.className = 'pj-session-div' + (e.phase === 'start' ? ' start' : '');
    const label =
      e.phase === 'start'
        ? 'work session started'
        : `session ${e.reason || 'ended'}`;
    div.innerHTML = `<span>${escapeHtml(label)}</span>`;
    return div;
  }
  if (e.type === 'sys') {
    const div = document.createElement('div');
    div.className = 'pj-sys' + (e.kind === 'error' ? ' err' : e.kind === 'done' ? ' ok' : '');
    div.textContent = e.text || '';
    return div;
  }
  return null;
}

function projectWelcomeDom() {
  const div = document.createElement('div');
  div.className = 'welcome';
  const name = activeProject ? escapeHtml(activeProject.name) : 'Project Mode';
  const folder = activeProject ? escapeHtml(activeProject.folder) : '';
  div.innerHTML =
    `<div class="welcome-icon">▦</div><h1>${name}</h1>` +
    (activeProject
      ? `<p class="pj-welcome-folder">${folder}</p><p>Give the team an instruction below.<br/>They plan on a shared task board, write real files, and run commands — all inside this folder.</p>`
      : `<p>Select or create a project in the sidebar → Project tab.<br/>Then assign 2–4 models and give the team an instruction.</p>`);
  return div;
}

function renderProjectThread() {
  messagesEl.innerHTML = '';
  if (!projectJournal.length) {
    messagesEl.appendChild(projectWelcomeDom());
    updateScrollFab();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of projectJournal) {
    const dom = journalEventDom(e);
    if (dom) frag.appendChild(dom);
  }
  messagesEl.appendChild(frag);
  setStickToBottom(true);
  scrollToBottom({ force: true });
  updateScrollFab();
}

/** Append event: journal array + DOM + server persistence in one step */
function pjEmit(e, { persist = true } = {}) {
  e.t = e.t || Date.now();
  projectJournal.push(e);
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
  const dom = journalEventDom(e);
  if (dom) {
    messagesEl.appendChild(dom);
    if (!stickToBottom) markStreamUnread();
    scrollToBottom();
  }
  if (persist) pjPersistJournal([e]);
  return dom;
}

/* ---------- agent output protocol ---------- */

export { PJ_TOOL_ICONS, journalEventDom, pjEmit, pjSeatColor, pjToolCardDom, pjToolLabel, pjTurnShellDom, projectWelcomeDom, renderProjectPanel, renderProjectThread };
