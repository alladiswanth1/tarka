import { tokenCountAnim, updateContextUI } from './context.js';
import { restoreDebateArena } from './debate/arena.js';
import { historyQuotaWarned, setHistoryQuotaWarned, truncateDebateRecord } from './history.js';
import { debateExpertNames, isDebateMode, projectMode, setProjectMode } from './project/state.js';
import { $, HISTORY_KEY, HISTORY_MAX, chatSession, historySaveTimer, isStreaming, messages, messagesEl, mobileMq, setAbortController, setChatSession, setHistorySaveTimer, setLastCompletionTokens, setLastGenStats, setLastPromptTokens, setMessages, statusText, tokenInfo } from './state.js';
import { estimateTokens } from './tokens.js';
import { MARK_SVG, primeMarks } from './ui/mark.js';
import { closeSidebar } from './ui/sidebar.js';
import { READY_STATUS, appendMessage, createReasoningPanel, finalizeReasoningPanel, flashMessageAt, flashStatus, setStickToBottom, setStreamingUi, stopStreaming, sweepReasoningTimers, updateScrollFab, withViewTransition } from './ui/transcript.js';

// ========== Chat sessions (multi-conversation) ==========
const SESSIONS_INDEX_KEY = 'customChatSessionIndex';

const SESSION_PREFIX = 'customChatSession:';

const ACTIVE_SESSION_KEY = 'customChatActiveSession';

const SESSIONS_MAX = 30;
/** @type {{ id: string, title: string, at: number, up: number, n: number, tl?: number }[]} */
let sessionIndex = [];

let activeSessionId = '';

function newSessionId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadSessionIndex() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSIONS_INDEX_KEY) || '[]');
    sessionIndex = (Array.isArray(raw) ? raw : [])
      .filter((s) => s && s.id)
      .map((s) => ({
        id: String(s.id),
        title: String(s.title || 'New chat').slice(0, 80),
        at: Number(s.at) || 0,
        up: Number(s.up) || 0,
        n: Number(s.n) || 0,
        tl: s.tl ? 1 : 0
      }));
  } catch {
    sessionIndex = [];
  }
  try {
    activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || '';
  } catch {
    activeSessionId = '';
  }
}

function saveSessionIndex() {
  try {
    localStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(sessionIndex));
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  } catch {
    /* quota */
  }
}

function sessionTitleFrom(msgs) {
  const first = (msgs || []).find((m) => m && m.role === 'user' && m.content);
  if (!first) return 'New chat';
  return String(first.content).replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
}

/** Drop the oldest sessions (never the active one) past SESSIONS_MAX */
function pruneSessions() {
  if (sessionIndex.length <= SESSIONS_MAX) return;
  const sorted = [...sessionIndex].sort((a, b) => (b.up || b.at) - (a.up || a.at));
  const keep = new Set(sorted.slice(0, SESSIONS_MAX).map((s) => s.id));
  keep.add(activeSessionId);
  for (const s of sessionIndex) {
    if (!keep.has(s.id)) {
      try {
        localStorage.removeItem(SESSION_PREFIX + s.id);
      } catch {
        /* ignore */
      }
    }
  }
  sessionIndex = sessionIndex.filter((s) => keep.has(s.id));
}

/** Refresh the active session's index entry after a successful save */
function touchSessionMeta() {
  let s = sessionIndex.find((x) => x.id === activeSessionId);
  if (!s) {
    s = { id: activeSessionId, title: 'New chat', at: Date.now(), up: 0, n: 0 };
    sessionIndex.unshift(s);
  }
  if (!s.tl) s.title = sessionTitleFrom(messages);
  s.up = Date.now();
  s.n = messages.length;
  pruneSessions();
  saveSessionIndex();
  renderSessionList();
}

/** One-time setup: migrate legacy single-history storage, ensure an active session */
function initSessions() {
  loadSessionIndex();
  if (!sessionIndex.length) {
    try {
      const legacy = localStorage.getItem(HISTORY_KEY);
      if (legacy) {
        const id = newSessionId();
        localStorage.setItem(SESSION_PREFIX + id, legacy);
        let arr = [];
        try {
          arr = JSON.parse(legacy);
        } catch {
          arr = [];
        }
        sessionIndex = [
          {
            id,
            title: sessionTitleFrom(Array.isArray(arr) ? arr : []),
            at: Date.now(),
            up: Date.now(),
            n: Array.isArray(arr) ? arr.length : 0
          }
        ];
        activeSessionId = id;
        saveSessionIndex();
        localStorage.removeItem(HISTORY_KEY);
      }
    } catch {
      /* storage unavailable */
    }
  }
  if (!sessionIndex.some((s) => s.id === activeSessionId)) {
    activeSessionId = sessionIndex[0]?.id || '';
  }
  if (!activeSessionId) {
    const id = newSessionId();
    activeSessionId = id;
    sessionIndex.unshift({ id, title: 'New chat', at: Date.now(), up: Date.now(), n: 0 });
    saveSessionIndex();
  }
}

/** Persist any debounced history write immediately (before session switches) */
function flushPendingHistorySave() {
  clearTimeout(historySaveTimer);
  saveHistory();
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

function renderSessionList() {
  const ul = $('#sessionList');
  if (!ul) return;
  ul.innerHTML = '';
  const sorted = [...sessionIndex].sort((a, b) => (b.up || b.at) - (a.up || a.at));
  if (!sorted.length) {
    ul.innerHTML =
      '<li class="session-empty">No conversations yet</li>';
    return;
  }
  sorted.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'session-row' + (s.id === activeSessionId ? ' active' : '');
    li.innerHTML =
      `<button type="button" class="session-main" title="Open this chat">` +
      `<span class="session-title"></span><span class="session-meta"></span>` +
      `</button>` +
      `<button type="button" class="icon-btn small session-rename" title="Rename chat" aria-label="Rename chat">✎</button>` +
      `<button type="button" class="icon-btn small session-delete" title="Delete chat" aria-label="Delete chat">✕</button>`;
    li.querySelector('.session-title').textContent = s.title || 'New chat';
    li.querySelector('.session-meta').textContent =
      `${s.n || 0} msg${(s.n || 0) === 1 ? '' : 's'} · ${relTime(s.up || s.at) || 'new'}`;
    li.querySelector('.session-main').addEventListener('click', () => switchSession(s.id));
    li.querySelector('.session-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      renameSession(s.id);
    });
    li.querySelector('.session-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });
    ul.appendChild(li);
  });
}

/** Reset per-conversation UI/state trackers (shared by new/switch/delete) */
function resetChatUiState() {
  setStickToBottom(true);
  tokenInfo.textContent = '';
  tokenCountAnim.current = 0;
  setLastPromptTokens(null);
  setLastCompletionTokens(null);
  setLastGenStats(null);
  statusText.classList.remove('thinking-status');
  statusText.textContent = READY_STATUS;
}

function switchSession(id, { focusIndex = -1 } = {}) {
  if (id === activeSessionId || !sessionIndex.some((s) => s.id === id)) return;
  if (isStreaming) stopStreaming();
  if (typeof projectMode !== 'undefined' && projectMode.enabled) setProjectMode(false, { silent: true });
  setChatSession(chatSession + (1)); // kills in-flight streams via the stale-session guard
  sweepReasoningTimers();
  setAbortController(null);
  setStreamingUi(false);
  flushPendingHistorySave();
  activeSessionId = id;
  saveSessionIndex();
  loadHistory();
  resetChatUiState();
  // Same deferral as newChat(): bail if a newer switch has taken over, so a
  // late transition callback cannot repaint a conversation the user has left.
  const mySession = chatSession;
  withViewTransition(() => {
    if (mySession !== chatSession) return;
    renderHistoryFromState();
    updateScrollFab();
    updateContextUI();
    // Inside the transition callback the transcript is already rebuilt, so a
    // search result can be focused deterministically.
    if (focusIndex >= 0) flashMessageAt(focusIndex);
  });
  renderSessionList();
  if (mobileMq.matches) closeSidebar();
  const s = sessionIndex.find((x) => x.id === id);
  flashStatus(`Chat → ${s?.title || 'conversation'}`);
}

function renameSession(id) {
  const s = sessionIndex.find((x) => x.id === id);
  if (!s) return;
  const name = prompt('Rename chat', s.title || 'New chat');
  if (name == null) return;
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return;
  s.title = trimmed;
  s.tl = 1; // manual titles are never auto-overwritten
  saveSessionIndex();
  renderSessionList();
}

function deleteSession(id) {
  const s = sessionIndex.find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`Delete chat “${s.title}”?`)) return;
  try {
    localStorage.removeItem(SESSION_PREFIX + id);
  } catch {
    /* ignore */
  }
  sessionIndex = sessionIndex.filter((x) => x.id !== id);
  if (activeSessionId === id) {
    if (isStreaming) stopStreaming();
    setChatSession(chatSession + (1));
    sweepReasoningTimers();
    setAbortController(null);
    setStreamingUi(false);
    const next = [...sessionIndex].sort((a, b) => (b.up || b.at) - (a.up || a.at))[0];
    if (next) {
      activeSessionId = next.id;
      loadHistory();
    } else {
      const nid = newSessionId();
      activeSessionId = nid;
      sessionIndex.unshift({ id: nid, title: 'New chat', at: Date.now(), up: Date.now(), n: 0 });
      setMessages([]);
    }
    resetChatUiState();
    renderHistoryFromState();
    updateScrollFab();
    updateContextUI();
  }
  saveSessionIndex();
  renderSessionList();
  flashStatus('Chat deleted');
}

function saveHistory() {
  // Mid-stream saves are deferred, not DROPPED: a save scheduled just before
  // streaming began (the user's own turn, or a regenerate's pop) used to be
  // silently discarded, so closing the tab during a multi-minute generation
  // lost the message — or resurrected the reply regenerate had deleted.
  if (isStreaming) {
    clearTimeout(historySaveTimer);
    setHistorySaveTimer(setTimeout(saveHistory, 500));
    return;
  }
  if (!activeSessionId) return;
  const slim = messages.slice(-HISTORY_MAX).map((m) => {
    const o = { role: m.role, content: m.content };
    if (m.reasoning) o.reasoning = String(m.reasoning).slice(0, 24_000);
    if (m.reasoningMs) o.reasoningMs = m.reasoningMs;
    if (m.debate) o.debate = truncateDebateRecord(m.debate);
    return o;
  });
  // Quota fallbacks: full → without reasoning → without debate transcripts →
  // recent tail only. Losing extras beats silently losing the whole chat.
  const noReasoning = () =>
    slim.map((m) => {
      const o = { role: m.role, content: m.content };
      if (m.debate) o.debate = m.debate;
      return o;
    });
  const noDebate = () => slim.map((m) => ({ role: m.role, content: m.content }));
  const attempts = [
    () => slim,
    noReasoning,
    noDebate,
    () => noDebate().slice(-60),
    () => noDebate().slice(-20)
  ];
  for (const build of attempts) {
    try {
      localStorage.setItem(SESSION_PREFIX + activeSessionId, JSON.stringify(build()));
      touchSessionMeta();
      return;
    } catch {
      /* try a smaller shape */
    }
  }
  if (!historyQuotaWarned) {
    setHistoryQuotaWarned(true);
    flashStatus('⚠ Browser storage is full — this chat cannot be saved', 4000);
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(SESSION_PREFIX + activeSessionId);
    if (!raw) {
      setMessages([]);
      return false;
    }
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) {
      setMessages([]);
      return false;
    }
    setMessages(arr
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .slice(-HISTORY_MAX)
      .map((m) => {
        const o = { role: m.role, content: m.content, _tok: estimateTokens(m.content) };
        if (m.debate && typeof m.debate === 'object') o.debate = m.debate;
        if (typeof m.reasoning === 'string' && m.reasoning) {
          o.reasoning = m.reasoning;
          if (Number.isFinite(m.reasoningMs)) o.reasoningMs = m.reasoningMs;
        }
        return o;
      }));
    return messages.length > 0;
  } catch {
    setMessages([]);
    return false;
  }
}

function welcomeHtml() {
  if (isDebateMode()) {
    const names = debateExpertNames();
    return `
    <div class="welcome">
      <div class="welcome-icon">${MARK_SVG}</div>
      <h1>Debate</h1>
      <p>A team of experts discusses the task, then one writes the answer.<br/>Give every seat a model in the Debate panel, then describe the task.</p>
      <p class="welcome-sub">${names || 'Add at least two experts'}</p>
      <div class="quick-tips">
        <button type="button" class="tip" data-prompt="Compare two approaches and recommend one, with the tradeoffs named.">Compare approaches</button>
        <button type="button" class="tip" data-prompt="Design a small system, then stress-test the design before the final write-up.">Design + critique</button>
        <button type="button" class="tip" data-prompt="Argue both sides of a decision, then present one recommendation.">Decide</button>
      </div>
    </div>`;
  }
  return `
    <div class="welcome">
      <div class="welcome-icon">${MARK_SVG}</div>
      <h1>Tarka</h1>
      <p>Talk to any OpenAI-compatible endpoint, or a signed-in local CLI<br/>(Claude Code, Codex, Grok Build). Set it up in the API panel.</p>
      <div class="quick-tips">
        <button type="button" class="tip" data-prompt="Stream me a short story about a lighthouse keeper, one sentence at a time.">Streaming</button>
        <button type="button" class="tip" data-prompt="Explain step by step: why is the sky blue?">Reasoning</button>
        <button type="button" class="tip" data-prompt="What model are you, and what are your strengths?">Any model</button>
      </div>
    </div>`;
}

function renderHistoryFromState() {
  messagesEl.innerHTML = '';
  if (!messages.length) {
    messagesEl.innerHTML = welcomeHtml();
    primeMarks(messagesEl);
    return;
  }
  // Suppress entrance animations for restored history (no 50× msgIn on reload)
  for (const m of messages) {
    const refs = appendMessage(m.role, m.content, false);
    if (refs.msgEl) refs.msgEl.classList.add('is-restored');
    if (m.role === 'assistant' && refs.body) {
      if (m.reasoning) {
        refs.body.insertBefore(buildRestoredReasoningPanel(m.reasoning, m.reasoningMs), refs.bubble);
      }
      if (m.debate) restoreDebateArena(refs, m.debate);
    }
  }
}

/** Collapsed, finished reasoning panel for history-restored messages */
function buildRestoredReasoningPanel(text, ms) {
  const api = createReasoningPanel({ expectStream: false });
  clearInterval(api.elapsedTimer);
  const empty = api.streamEl.querySelector('.reasoning-empty');
  if (empty) empty.remove();
  api.streamEl.textContent = String(text);
  api.lastLen = String(text).length;
  api.subEl.textContent = 'Chain of thought';
  api.startedAt = performance.now() - (Number(ms) || 0);
  finalizeReasoningPanel(api, { forceOpen: false });
  if (!ms) api.titleEl.textContent = 'Thought (from history)';
  api.el.classList.add('is-restored');
  return api.el;
}

function setActiveSessionId(v) { activeSessionId = v; return v; }

export { ACTIVE_SESSION_KEY, SESSIONS_INDEX_KEY, SESSIONS_MAX, SESSION_PREFIX, activeSessionId, buildRestoredReasoningPanel, deleteSession, flushPendingHistorySave, initSessions, loadHistory, loadSessionIndex, newSessionId, pruneSessions, relTime, renameSession, renderHistoryFromState, renderSessionList, resetChatUiState, saveHistory, saveSessionIndex, sessionIndex, sessionTitleFrom, setActiveSessionId, switchSession, touchSessionMeta };
