import { updateContextUI } from '../context.js';
import { projectMode, setProjectMode } from '../project/state.js';
import { flushPendingHistorySave, newSessionId, pruneSessions, renderHistoryFromState, renderSessionList, resetChatUiState, saveSessionIndex, sessionIndex, setActiveSessionId } from '../sessions.js';
import { chatSession, isStreaming, messages, messagesEl, mobileMq, prefersReducedMotion, setAbortController, setChatSession, setMessages, sidebar, sidebarScrim, userInput } from '../state.js';
import { DRAWER_KEY } from '../ui/inspector.js';
import { setStreamingUi, stopStreaming, sweepReasoningTimers, updateScrollFab, withViewTransition } from '../ui/transcript.js';

// ========== Helpers ==========
function autoResize() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
}

/** Card Deck sidebar: pill tabs → API / System / Debate / Favs */
const SIDEBAR_PANEL_NOTES = {
  chats: 'Your conversations — switch, rename, or delete. Everything stays in this browser.',
  api: 'Providers, model, reasoning, and context for the active gateway.',
  sys: 'Instructions sent with every request (when no system message is already in the chat).',
  debate: 'Team lineup, rounds, and how the final answer is chosen.',
  project: 'A team of 2–4 models builds inside one assigned folder — files, commands, tasks, decisions.',
  favs: 'Favorite model ids — click to use; chip cycles provider scope.'
};

/** Panel the drawer is currently showing (the rail highlights it while open) */
let activeSidebarPanel = 'api';

/**
 * The rail is lit only when the drawer is actually open on that section.
 * `openOverride` matters because open/close run inside a View Transition, so
 * the class isn't on the element yet when the caller syncs.
 */

/**
 * The rail is lit only when the drawer is actually open on that section.
 * `openOverride` matters because open/close run inside a View Transition, so
 * the class isn't on the element yet when the caller syncs.
 */
function syncRail(openOverride) {
  const open =
    typeof openOverride === 'boolean' ? openOverride : !sidebar.classList.contains('collapsed');
  document.querySelectorAll('.rail-btn[data-panel]').forEach((btn) => {
    btn.classList.toggle('on', open && btn.dataset.panel === activeSidebarPanel);
  });
}

function setSidebarPanel(panelId) {
  const id = SIDEBAR_PANEL_NOTES[panelId] ? panelId : 'api';
  activeSidebarPanel = id;
  document.querySelectorAll('.side-tab').forEach((btn) => {
    const on = btn.dataset.panel === id;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.config-panel').forEach((panel) => {
    const on = panel.dataset.panel === id;
    panel.classList.toggle('open', on);
    panel.hidden = !on;
  });
  const note = document.getElementById('panelNote');
  if (note) note.textContent = SIDEBAR_PANEL_NOTES[id] || SIDEBAR_PANEL_NOTES.api;
  syncRail();
}

function initSidebarTabs() {
  document.querySelectorAll('.side-tab').forEach((btn) => {
    btn.addEventListener('click', () => setSidebarPanel(btn.dataset.panel));
  });
  // Icon rail: pick a section to open the drawer, click it again to close
  document.querySelectorAll('.rail-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.classList.contains('on');
      if (open && btn.dataset.panel === activeSidebarPanel) {
        closeSidebar();
        return;
      }
      setSidebarPanel(btn.dataset.panel);
      openSidebar();
    });
  });
  setSidebarPanel('api');
}

function openSidebar() {
  const apply = () => {
    sidebar.classList.remove('collapsed');
    if (mobileMq.matches) {
      if (sidebarScrim) {
        sidebarScrim.hidden = false;
        requestAnimationFrame(() => sidebarScrim.classList.add('visible'));
      }
      document.body.classList.add('sidebar-open');
      // Slight spring overshoot on open only (animation overrides the transition)
      if (!prefersReducedMotion.matches) {
        sidebar.classList.remove('sidebar-springing');
        void sidebar.offsetWidth;
        sidebar.classList.add('sidebar-springing');
      }
    }
  };
  // Desktop: View Transitions when available; transform transition remains the fallback
  if (!mobileMq.matches) {
    withViewTransition(apply);
  } else {
    apply();
  }
  syncRail(true);
  try {
    localStorage.setItem(DRAWER_KEY, '1');
  } catch {
    /* quota */
  }
}

function closeSidebar() {
  const apply = () => {
    sidebar.classList.add('collapsed');
    sidebar.classList.remove('sidebar-springing');
    document.body.classList.remove('sidebar-open');
    if (sidebarScrim) {
      sidebarScrim.classList.remove('visible');
      setTimeout(() => {
        if (!sidebarScrim.classList.contains('visible')) sidebarScrim.hidden = true;
      }, 300);
    }
  };
  if (!mobileMq.matches) {
    withViewTransition(apply);
  } else {
    apply();
  }
  syncRail(false);
  try {
    localStorage.setItem(DRAWER_KEY, '0');
  } catch {
    /* quota */
  }
}

function newChat() {
  if (isStreaming) {
    stopStreaming();
  }
  if (projectMode.enabled) setProjectMode(false, { silent: true });
  // State reset happens immediately (kills in-flight streams via session bump)
  setChatSession(chatSession + (1));
  sweepReasoningTimers();
  // The stale in-flight handler skips all cleanup (including its finally) once
  // the session bumps, so reset streaming UI state here. Safe when idle.
  setAbortController(null);
  setStreamingUi(false);
  // The old conversation is archived, not destroyed: persist it, then open a
  // fresh session (reusing the current one when it's already empty).
  flushPendingHistorySave();
  if (messages.length) {
    const id = newSessionId();
    setActiveSessionId(id);
    sessionIndex.unshift({ id, title: 'New chat', at: Date.now(), up: Date.now(), n: 0 });
    pruneSessions();
    saveSessionIndex();
  }
  setMessages([]);
  resetChatUiState();
  renderSessionList();

  // The wipe below is deferred by a frame (View Transitions) or 200ms (the
  // fallback). A turn started inside that window — a restored draft plus
  // Enter is enough — already owns the transcript, and re-rendering from
  // `messages` would delete the live reply out from under its renderer while
  // history quietly keeps the text. So when that happens, retire exactly the
  // nodes the previous conversation left behind and let the new turn stand.
  const mySession = chatSession;
  const staleNodes = Array.from(messagesEl.childNodes);
  const applyVisual = () => {
    if (mySession !== chatSession) return; // a newer switch owns the view
    if (isStreaming || messagesEl.childNodes.length !== staleNodes.length) {
      for (const n of staleNodes) n.remove();
    } else {
      renderHistoryFromState();
    }
    updateScrollFab();
    updateContextUI();
  };

  const hasContent = messagesEl.querySelector('.msg, .error-toast');
  if (!hasContent || prefersReducedMotion.matches) {
    applyVisual();
    return;
  }

  // Progressive enhancement: View Transitions API, else manual fade-out
  if (typeof document.startViewTransition === 'function' && !prefersReducedMotion.matches) {
    withViewTransition(applyVisual);
    return;
  }
  messagesEl.classList.add('msgs-leaving');
  setTimeout(() => {
    messagesEl.classList.remove('msgs-leaving');
    applyVisual();
  }, 200);
}

export { SIDEBAR_PANEL_NOTES, activeSidebarPanel, autoResize, closeSidebar, initSidebarTabs, newChat, openSidebar, setSidebarPanel, syncRail };
