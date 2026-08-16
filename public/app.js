/**
 * Tarka entry point.
 *
 * Everything below is WIRING ONLY: DOM event listeners and the boot sequence.
 * All behaviour lives in ./src/ — see ARCHITECTURE.md for the map.
 *
 * Load order matters at the bottom of this file: config and providers must be
 * read out of localStorage before sessions restore, because a restored chat
 * asks the active provider for its context window.
 */

import { scheduleComposerDraftSave, sendMessage } from './src/compose.js';
import { getConfig, loadConfig, saveConfig, scheduleConfigAutosave } from './src/config.js';
import { detectContextFromProvider, loadProviderContextCache, scheduleContextDetect, updateContextUI } from './src/context.js';
import { debateSettings, loadDebateSettings, loadDebateTeamById, markDebateCustom, newTeamId, saveDebateSettings, saveDebateTeams, setDebateMode, snapshotDebateTeamConfig, updateDebateTeamsUi } from './src/debate/settings.js';
import { renderDebateSeats, updateDebateCostHint, updateJudgeRowVisibility } from './src/debate/ui.js';
import { exportChat } from './src/export.js';
import { attachModelPicker, favoriteId, loadSavedModels, saveSavedModels, updateModelWarnings } from './src/models.js';
import { renderProjectPanel, renderProjectThread } from './src/project/journal.js';
import { activeProject, loadProjectModeLS, pjApi, projectBusy, projectCostHintText, projectJournal, projectList, projectMode, projectTasks, reconcileExclusiveModes, refreshProjectList, removeSelectedProject, renderProjectSeats, saveProjectModeLS, scheduleProjectTeamSave, selectProject, setProjectMode, setProjectShowRoles, updateDebateToggleUi, updateModeStrip, updateProjectToggleUi } from './src/project/state.js';
import { syncLocalAgentProviders } from './src/localAgents.js';
import { activeProviderId, loadProviders, providers } from './src/providers.js';
import { initSessions, loadHistory, renderHistoryFromState, renderSessionList } from './src/sessions.js';
import { restoreComposerDraft } from './src/solo.js';
import { $, activeTeamId, copyText, debateTeams, finePointerMq, isStreaming, messages, messagesEl, mobileMq, prefersReducedMotion, savedModels, sendBtn, setActiveTeamId, setDebateTeams, setSavedModels, sidebar, sidebarScrim, statusText, userInput } from './src/state.js';
import { closeCmdk, cmdkOverlay, openCmdk } from './src/ui/cmdk.js';
import { DRAWER_KEY, initInspector } from './src/ui/inspector.js';
import { primeMarks } from './src/ui/mark.js';
import { closeProviderEditor, deleteProviderFromEditor, editingProviderId, openProviderEditor, renderProviders, saveProviderFromEditor, updateTopbar } from './src/ui/providers.js';
import { autoResize, closeSidebar, initSidebarTabs, newChat, openSidebar, setSidebarPanel, syncRail } from './src/ui/sidebar.js';
import { initViewportInsets } from './src/ui/viewport.js';
import { READY_STATUS, appendError, clearStreamUnread, editUserMessage, flashStatus, isNearBottom, regenerate, scrollFab, scrollToBottom, setStickToBottom, setStreamingUi, stickToBottom, stopStreaming, updateScrollFab } from './src/ui/transcript.js';
import { estimateTokens } from './src/tokens.js';
import { renderMarkdown } from './src/markdown.js';
import { DEBATE_MAX_SEATS, parseDebateStatus } from './src/debate/protocol.js';
import { parseAgentResponse, pjTrimConvo } from './src/project/protocol.js';

// ========== Events ==========
sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // Enter confirming an IME composition (CJK input) must not send
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendMessage();
  }
  if (e.key === 'Escape' && isStreaming) {
    stopStreaming();
  }
  // ArrowUp in an empty composer recalls the last user message for editing
  if (e.key === 'ArrowUp' && !userInput.value && !isStreaming) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      e.preventDefault();
      userInput.value = lastUser.content;
      autoResize();
      updateContextUI();
      requestAnimationFrame(() =>
        userInput.setSelectionRange(userInput.value.length, userInput.value.length)
      );
    }
  }
});

userInput.addEventListener('input', () => {
  autoResize();
  updateContextUI();
  scheduleComposerDraftSave();
});

messagesEl.addEventListener('scroll', () => {
  setStickToBottom(isNearBottom(90));
  if (stickToBottom) clearStreamUnread();
  updateScrollFab();
}, { passive: true });

scrollFab?.addEventListener('click', () => {
  setStickToBottom(true);
  clearStreamUnread();
  scrollToBottom({ force: true, smooth: true });
});

// ===== Delegated interactions inside the transcript =====
messagesEl.addEventListener('click', async (e) => {
  // Code block copy button — morph icon → checkmark, flash "Copied"
  const codeBtn = e.target.closest('.code-copy');
  if (codeBtn) {
    const code = codeBtn.closest('.code-card')?.querySelector('.code-block code');
    if (!code) return;
    const ok = await copyText(code.innerText);
    const label = codeBtn.querySelector('.code-copy-label');
    codeBtn.classList.add('copied');
    if (label) label.textContent = ok ? 'Copied' : 'Failed';
    clearTimeout(codeBtn._revert);
    codeBtn._revert = setTimeout(() => {
      codeBtn.classList.remove('copied');
      if (label) label.textContent = 'Copy';
    }, 1500);
    return;
  }

  // Message action row (Copy · Regenerate)
  const actBtn = e.target.closest('.msg-action-btn');
  if (actBtn) {
    const msgEl = actBtn.closest('.msg');
    if (!msgEl) return;
    if (actBtn.dataset.act === 'copy') {
      const ok = await copyText(msgEl._raw || msgEl.querySelector('.bubble')?.innerText || '');
      const span = actBtn.querySelector('span');
      if (span) {
        span.textContent = ok ? 'Copied' : 'Failed';
        clearTimeout(actBtn._revert);
        actBtn._revert = setTimeout(() => (span.textContent = 'Copy'), 1500);
      }
    } else if (actBtn.dataset.act === 'regen') {
      regenerate(msgEl);
    } else if (actBtn.dataset.act === 'edit') {
      editUserMessage(msgEl);
    }
    return;
  }

  // Welcome quick-tip chips → insert example prompt & focus composer
  const tip = e.target.closest('.tip[data-prompt]');
  if (tip) {
    userInput.value = tip.dataset.prompt;
    autoResize();
    updateContextUI();
    userInput.focus();
    userInput.setSelectionRange(userInput.value.length, userInput.value.length);
  }
});

// ===== Mobile sidebar scrim =====
sidebarScrim?.addEventListener('click', closeSidebar);
mobileMq.addEventListener?.('change', (e) => {
  if (!e.matches) {
    // Left mobile layout — drop scrim/lock state
    document.body.classList.remove('sidebar-open');
    sidebar.classList.remove('sidebar-springing');
    if (sidebarScrim) {
      sidebarScrim.classList.remove('visible');
      sidebarScrim.hidden = true;
    }
  } else if (!sidebar.classList.contains('collapsed')) {
    // Entered mobile layout with the sidebar open — apply scrim/lock state
    document.body.classList.add('sidebar-open');
    if (sidebarScrim) {
      sidebarScrim.hidden = false;
      requestAnimationFrame(() => sidebarScrim.classList.add('visible'));
    }
  }
});

// ===== Global keys: Ctrl/Cmd+K palette, Ctrl/Cmd+Shift+O new chat, Escape =====
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    // A palette mid-close-animation still has hidden=false — treat it as
    // closed so Ctrl+K during the 200ms fade reopens instead of being eaten
    const cmdkOpen = cmdkOverlay?.hidden === false && !cmdkOverlay.classList.contains('closing');
    if (cmdkOpen) closeCmdk();
    else openCmdk();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    newChat();
    return;
  }
  if (e.key === 'Escape') {
    if (cmdkOverlay && !cmdkOverlay.hidden) {
      closeCmdk();
      return;
    }
    // "Esc stop" works everywhere, not only with the composer focused
    if (isStreaming) {
      stopStreaming();
      return;
    }
    if (mobileMq.matches && !sidebar.classList.contains('collapsed')) {
      closeSidebar();
    }
  }
});

// ===== Pointer-reactive ambient glow (desktop, motion-safe only) =====
(() => {
  const glowEl = $('#pointerGlow');
  const mainEl = $('#main');
  if (!glowEl || !mainEl) return;
  if (prefersReducedMotion.matches || !finePointerMq.matches) return;
  let tx = window.innerWidth / 2;
  let ty = window.innerHeight * 0.3;
  let cx = tx;
  let cy = ty;
  let raf = 0;
  const tick = () => {
    cx += (tx - cx) * 0.12;
    cy += (ty - cy) * 0.12;
    glowEl.style.setProperty('--glow-x', cx.toFixed(1) + 'px');
    glowEl.style.setProperty('--glow-y', cy.toFixed(1) + 'px');
    if (Math.abs(tx - cx) > 0.5 || Math.abs(ty - cy) > 0.5) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
    }
  };
  mainEl.addEventListener('pointermove', (e) => {
    tx = e.clientX;
    ty = e.clientY;
    glowEl.classList.add('on');
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
})();

$('#saveConfig').addEventListener('click', saveConfig);
$('#openSidebar').addEventListener('click', openSidebar);
$('#closeSidebar').addEventListener('click', closeSidebar);
$('#newChat').addEventListener('click', newChat);

$('#exportChat')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#exportMenu');
  if (!menu) {
    exportChat('txt');
    return;
  }
  const open = menu.hidden;
  menu.hidden = !open;
  $('#exportChat').setAttribute('aria-expanded', open ? 'true' : 'false');
});

$('#exportMenu')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-fmt]');
  if (!btn) return;
  exportChat(btn.getAttribute('data-fmt') || 'txt');
  const menu = $('#exportMenu');
  if (menu) menu.hidden = true;
  $('#exportChat')?.setAttribute('aria-expanded', 'false');
});

document.addEventListener('click', (e) => {
  const wrap = e.target.closest?.('.export-wrap');
  if (wrap) return;
  const menu = $('#exportMenu');
  if (menu && !menu.hidden) {
    menu.hidden = true;
    $('#exportChat')?.setAttribute('aria-expanded', 'false');
  }
});

$('#detectContextBtn')?.addEventListener('click', () => detectContextFromProvider({ silent: false, force: true }));
$('#contextBadge')?.addEventListener('click', () => detectContextFromProvider({ silent: false, force: true }));
$('#contextLimit')?.addEventListener('input', updateContextUI);
$('#contextLimit')?.addEventListener('change', () => {
  updateContextUI();
});
$('#systemPrompt')?.addEventListener('input', updateContextUI);
$('#maxTokens')?.addEventListener('input', updateContextUI);

// Provider editor events
$('#addProviderBtn')?.addEventListener('click', () => {
  const open = $('#providerEditor')?.classList.contains('open');
  if (open && editingProviderId === null) closeProviderEditor();
  else openProviderEditor(null);
});
$('#provSave')?.addEventListener('click', saveProviderFromEditor);
$('#provCancel')?.addEventListener('click', closeProviderEditor);
$('#provDelete')?.addEventListener('click', deleteProviderFromEditor);
$('#provToggleKey')?.addEventListener('click', () => {
  const inp = $('#provApiKey');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  $('#provToggleKey').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
});
// Enter inside the editor saves (Escape handled globally closes nothing here)
$('#providerEditor')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    saveProviderFromEditor();
  }
});

// Debate mode events
$('#debateToggle')?.addEventListener('click', () => {
  setDebateMode(!debateSettings.enabled);
  if (debateSettings.enabled) {
    openSidebar();
    setSidebarPanel('debate');
  }
});

// Project mode events
$('#projectToggle')?.addEventListener('click', () => {
  if (!projectMode.enabled && !activeProject) {
    openSidebar();
    setSidebarPanel('project');
    const form = $('#projectCreateForm');
    if (form && !projectList.length) form.hidden = false;
    flashStatus('Pick or create a project first');
    if (projectList.length) return; // panel open, let them choose
    return;
  }
  setProjectMode(!projectMode.enabled);
  if (projectMode.enabled) {
    openSidebar();
    setSidebarPanel('project');
  }
});

$('#projectSelect')?.addEventListener('change', async () => {
  const id = $('#projectSelect').value;
  await selectProject(id);
  if (id && !projectMode.enabled) setProjectMode(true, { silent: true });
  if (id) flashStatus(`Project → ${activeProject?.name || ''}`);
});

$('#projectNewBtn')?.addEventListener('click', () => {
  const form = $('#projectCreateForm');
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) $('#projName')?.focus();
});

$('#projCreateCancel')?.addEventListener('click', () => {
  const form = $('#projectCreateForm');
  if (form) form.hidden = true;
});

$('#projCreateConfirm')?.addEventListener('click', async () => {
  const name = ($('#projName')?.value || '').trim();
  const folder = ($('#projFolder')?.value || '').trim();
  if (!name) { flashStatus('Enter a project name'); $('#projName')?.focus(); return; }
  if (!folder) { flashStatus('Enter the full folder path'); $('#projFolder')?.focus(); return; }
  try {
    const data = await pjApi('/api/projects', {
      name,
      folder,
      team: [
        { name: '', model: getConfig().model || '', providerId: activeProviderId || providers[0]?.id || '', role: '' },
        { name: '', model: getConfig().model || '', providerId: activeProviderId || providers[0]?.id || '', role: '' }
      ]
    });
    $('#projectCreateForm').hidden = true;
    $('#projName').value = '';
    $('#projFolder').value = '';
    await refreshProjectList();
    await selectProject(data.project.id);
    setProjectMode(true, { silent: true });
    flashStatus(`Project “${data.project.name}” created ✓`);
  } catch (e) {
    appendError(`Create project: ${e.message}`);
  }
});

$('#projAddMember')?.addEventListener('click', () => {
  if (!activeProject) return;
  if (!Array.isArray(activeProject.team)) activeProject.team = [];
  if (activeProject.team.length >= 4) return;
  activeProject.team.push({ name: '', model: '', providerId: activeProviderId || providers[0]?.id || '', role: '' });
  scheduleProjectTeamSave();
  renderProjectSeats();
  updateModeStrip();
});

$('#projShowRoles')?.addEventListener('change', () => {
  setProjectShowRoles(!!$('#projShowRoles').checked);
  renderProjectSeats();
});

$('#projMaxTurns')?.addEventListener('input', () => {
  if (!activeProject) return;
  const v = parseInt($('#projMaxTurns').value, 10);
  if (Number.isFinite(v)) {
    activeProject.settings = { ...(activeProject.settings || {}), maxTurns: Math.min(80, Math.max(4, v)) };
    scheduleProjectTeamSave();
    const hint = $('#projectCostHint');
    if (hint) hint.textContent = projectCostHintText();
  }
});

// On commit (not per keystroke), show the value that was actually stored —
// a field displaying 100 while the engine runs 80 misleads until reload
$('#projMaxTurns')?.addEventListener('change', () => {
  const stored = activeProject?.settings?.maxTurns;
  if (Number.isFinite(stored) && $('#projMaxTurns').value !== String(stored)) {
    $('#projMaxTurns').value = String(stored);
  }
});

$('#projReasoning')?.addEventListener('change', () => {
  if (!activeProject) return;
  activeProject.settings = { ...(activeProject.settings || {}), reasoning: $('#projReasoning').value === 'none' ? 'none' : 'inherit' };
  scheduleProjectTeamSave();
});

$('#projectRemoveBtn')?.addEventListener('click', removeSelectedProject);
$('#projectMissingRemove')?.addEventListener('click', removeSelectedProject);

$('#addSeatBtn')?.addEventListener('click', () => {
  if (debateSettings.experts.length >= DEBATE_MAX_SEATS) return;
  debateSettings.experts.push({
    name: `Expert ${debateSettings.experts.length + 1}`,
    persona: '',
    model: '',
    providerId: ''
  });
  markDebateCustom();
  renderDebateSeats();
});

$('#debateMaxRounds')?.addEventListener('input', () => {
  const v = parseInt($('#debateMaxRounds').value, 10);
  if (Number.isFinite(v)) {
    debateSettings.maxRounds = Math.min(8, Math.max(1, v));
    markDebateCustom();
  }
  updateDebateCostHint();
});

$('#debateMaxRounds')?.addEventListener('change', () => {
  const stored = debateSettings.maxRounds;
  if (Number.isFinite(stored) && $('#debateMaxRounds').value !== String(stored)) {
    $('#debateMaxRounds').value = String(stored);
  }
});

$('#debateReasoning')?.addEventListener('change', () => {
  debateSettings.expertReasoning =
    $('#debateReasoning').value === 'inherit' ? 'inherit' : 'off';
  markDebateCustom();
});

$('#debateFinalMode')?.addEventListener('change', () => {
  debateSettings.finalAnswerMode =
    $('#debateFinalMode').value === 'judge' ? 'judge' : 'nominated';
  markDebateCustom();
  updateJudgeRowVisibility();
  updateModelWarnings();
  saveDebateSettings();
});

// Team presets
$('#debateTeamSelect')?.addEventListener('change', () => {
  const id = $('#debateTeamSelect').value;
  if (!id) {
    setActiveTeamId('');
    updateDebateTeamsUi();
    return;
  }
  loadDebateTeamById(id, { enable: false });
});

$('#debateTeamSave')?.addEventListener('click', () => {
  const form = $('#debateTeamSaveForm');
  if (!form) return;
  form.hidden = false;
  const inp = $('#debateTeamName');
  if (inp) {
    inp.value = '';
    inp.focus();
  }
});

$('#debateTeamSaveCancel')?.addEventListener('click', () => {
  const form = $('#debateTeamSaveForm');
  if (form) form.hidden = true;
});

$('#debateTeamSaveConfirm')?.addEventListener('click', () => {
  const name = ($('#debateTeamName')?.value || '').trim();
  if (!name) {
    flashStatus('Enter a team name');
    $('#debateTeamName')?.focus();
    return;
  }
  if (debateTeams.length >= 12) {
    flashStatus('Team limit reached (12) — delete one first');
    return;
  }
  const team = {
    id: newTeamId(),
    name: name.slice(0, 40),
    ...snapshotDebateTeamConfig(),
    at: Date.now()
  };
  debateTeams.unshift(team);
  setDebateTeams(debateTeams.slice(0, 12));
  saveDebateTeams();
  setActiveTeamId(team.id);
  updateDebateTeamsUi();
  const form = $('#debateTeamSaveForm');
  if (form) form.hidden = true;
  flashStatus(`Team “${team.name}” saved`);
});

$('#debateTeamName')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    $('#debateTeamSaveConfirm')?.click();
  } else if (e.key === 'Escape') {
    $('#debateTeamSaveCancel')?.click();
  }
});

$('#debateTeamDelete')?.addEventListener('click', () => {
  if (!activeTeamId) return;
  const t = debateTeams.find((x) => x.id === activeTeamId);
  if (!t) return;
  if (!confirm(`Delete team “${t.name}”?`)) return;
  setDebateTeams(debateTeams.filter((x) => x.id !== activeTeamId));
  setActiveTeamId('');
  saveDebateTeams();
  updateDebateTeamsUi();
  flashStatus('Team deleted');
});

$('#addModelBtn').addEventListener('click', () => {
  const m = $('#model').value.trim();
  if (!m) return;
  const pid = activeProviderId || '';
  if (savedModels.some((x) => favoriteId(x) === m && (x.providerId || '') === pid)) {
    flashStatus('Already in favorites');
    return;
  }
  savedModels.push({ id: m, providerId: pid });
  saveSavedModels();
  flashStatus(`Added “${m}”`);
});

$('#clearModels').addEventListener('click', () => {
  if (confirm('Clear all saved models?')) {
    setSavedModels([]);
    saveSavedModels();
  }
});

['model', 'reasoningEffort'].forEach((id) => {
  $(`#${id}`).addEventListener('change', () => {
    updateTopbar();
    if (id === 'model') {
      scheduleContextDetect();
      updateModelWarnings();
    }
  });
  $(`#${id}`).addEventListener('input', () => {
    updateTopbar();
    if (id === 'model') {
      scheduleContextDetect();
      updateModelWarnings();
    }
  });
});

// Every settings edit autosaves (debounced, silent) — "Save Config" stays as
// an explicit flush + context re-detect, but nothing is lost without it.
['model', 'reasoningEffort', 'temperature', 'maxTokens', 'contextLimit', 'systemPrompt'].forEach(
  (id) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener('input', scheduleConfigAutosave);
    el.addEventListener('change', scheduleConfigAutosave);
  }
);

// Session panel events
$('#sessionNewBtn')?.addEventListener('click', () => {
  newChat();
  flashStatus('New chat started');
});

// ========== Init ==========
initSidebarTabs();
loadProviderContextCache();
loadProviders(); // before loadConfig/updateTopbar — both read the active provider
loadDebateSettings(); // before renderProviders — it re-renders the debate seats
loadConfig();
loadProjectModeLS();
reconcileExclusiveModes();
loadSavedModels(); // favorites migration + recents + catalog cache
// Main model combo (scoped to active provider)
attachModelPicker($('#model'), {
  getProviderId: () => activeProviderId || providers[0]?.id || '',
  onChange: () => {
    updateTopbar();
    scheduleContextDetect();
    updateModelWarnings();
  }
});
renderProviders();
renderDebateSeats();
updateDebateToggleUi();
syncLocalAgentProviders()
  .then(() => {
    renderProviders();
    renderDebateSeats();
    updateTopbar();
    updateModelWarnings();
  })
  .catch(() => {});
updateDebateTeamsUi();
// Restore the active conversation (sessions migrate legacy history in place)
initSessions();
renderSessionList();
if (loadHistory()) {
  renderHistoryFromState();
}
// Project mode: restore list + active project (async; view swaps in when ready)
updateProjectToggleUi();
initInspector();
initViewportInsets();
(async () => {
  await refreshProjectList();
  if (projectMode.activeId && projectList.some((p) => p.id === projectMode.activeId)) {
    await selectProject(projectMode.activeId, { render: projectMode.enabled });
  } else if (projectMode.enabled) {
    projectMode.enabled = false;
    saveProjectModeLS();
    updateProjectToggleUi();
  }
  renderProjectPanel();
})();
updateTopbar();
setStreamingUi(false);
statusText.textContent = READY_STATUS;
updateScrollFab();
updateContextUI();
updateModelWarnings();
primeMarks();
scheduleContextDetect();
restoreComposerDraft();
updateContextUI();
if (!mobileMq.matches) userInput.focus();

// The rail is the primary navigation, so the settings drawer starts closed
// unless it was left open on this device.
(() => {
  let wasOpen = false;
  try {
    wasOpen = localStorage.getItem(DRAWER_KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  // applied directly: a view transition on first paint just flashes
  sidebar.classList.toggle('collapsed', !(wasOpen && !mobileMq.matches));
  syncRail();
})();

// Reposition fixed model-picker dropdowns when the sidebar scrolls or window resizes
const repositionOpenPickers = () => {
  document.querySelectorAll('.model-picker-input').forEach((inp) => {
    if (typeof inp._modelPickerReposition === 'function') inp._modelPickerReposition();
  });
};
window.addEventListener('resize', repositionOpenPickers);
// The drawer slides; a dropdown opened mid-animation would be measured wrong
sidebar.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'margin-left' || e.propertyName === 'transform') repositionOpenPickers();
});
$('#sidebar')?.querySelector('.sidebar-content')?.addEventListener('scroll', repositionOpenPickers, {
  passive: true
});


/* ------------------------------------------------------------------
 * Devtools handle.
 *
 * Module scope is the point of this refactor — nothing leaks to `window`
 * by accident any more. But a NAMED escape hatch is genuinely useful when
 * debugging in the console, and it's what automated checks drive the app
 * through. State is exposed via getters so you always read the live value.
 * Nothing in the app depends on this object; deleting it changes nothing.
 * ------------------------------------------------------------------ */
window.tarka = {
  // actions
  sendMessage, newChat, stopStreaming, setProjectMode, selectProject,
  refreshProjectList, renderProjectThread, saveDebateSettings, pjApi,
  // pure helpers, handy for poking at the protocols
  parseDebateStatus, parseAgentResponse, pjTrimConvo, renderMarkdown, estimateTokens,
  // live state (getters — these are module bindings, not copies)
  get messages() { return messages; },
  get isStreaming() { return isStreaming; },
  get debateSettings() { return debateSettings; },
  get projectMode() { return projectMode; },
  get projectBusy() { return projectBusy; },
  get projectJournal() { return projectJournal; },
  get activeProject() { return activeProject; },
  get projectTasks() { return projectTasks; }
};
