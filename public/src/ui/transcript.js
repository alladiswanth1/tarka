import { updateContextUI } from '../context.js';
import { runDebate } from '../debate/engine.js';
import { validateDebateSetup } from '../debate/ui.js';
import { scheduleHistorySave } from '../history.js';
import { renderMarkdown } from '../markdown.js';
import { getConfig } from '../config.js';
import { getValidatedConfig } from '../net/stream.js';
import { renderHistoryFromState } from '../sessions.js';
import { streamAssistantReply } from '../solo.js';
import { $, abortController, isStreaming, messages, messagesEl, prefersReducedMotion, sendBtn, setAbortController, setIsStreaming, setMessages, statusText, userInput } from '../state.js';
import { setFaviconThinking } from '../ui/mark.js';
import { autoResize, openSidebar, setSidebarPanel } from '../ui/sidebar.js';

// ========== Chat UI ==========
function clearWelcome() {
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
}

function formatThoughtDuration(ms) {
  const sec = ms / 1000;
  if (sec < 1) return `${Math.max(0.1, sec).toFixed(1)}s`;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  return `${Math.round(sec)}s`;
}

/**
 * Reasoning panel: animated orb, shimmer "Thinking", stream, then collapse.
 */

/**
 * Reasoning panel: animated orb, shimmer "Thinking", stream, then collapse.
 */
function createReasoningPanel({ expectStream = true } = {}) {
  const panel = document.createElement('div');
  panel.className = 'reasoning-panel thinking open';
  panel.dataset.open = 'true';
  panel.innerHTML = `
    <button type="button" class="reasoning-toggle" aria-expanded="true">
      <span class="reasoning-orb" aria-hidden="true">
        <span class="orb-ring"></span>
        <span class="orb-core"></span>
      </span>
      <span class="reasoning-meta">
        <span class="reasoning-label-main">
          <span class="shimmer-text reasoning-title">Thinking</span>
          <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="reasoning-elapsed" aria-hidden="true">0.0s</span>
        </span>
        <span class="reasoning-sub">${expectStream ? 'Streaming chain of thought' : 'Working through the problem'}</span>
      </span>
      <span class="reasoning-chevron" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </span>
    </button>
    <div class="reasoning-drawer">
      <div class="reasoning-drawer-inner">
        <div class="reasoning-stream-wrap">
          <pre class="reasoning-stream"><span class="reasoning-empty">Gathering thoughts…</span></pre>
        </div>
      </div>
    </div>
  `;

  const toggle = panel.querySelector('.reasoning-toggle');
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    panel.dataset.open = open ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const api = {
    el: panel,
    streamEl: panel.querySelector('.reasoning-stream'),
    titleEl: panel.querySelector('.reasoning-title'),
    subEl: panel.querySelector('.reasoning-sub'),
    elapsedEl: panel.querySelector('.reasoning-elapsed'),
    startedAt: performance.now(),
    finalized: false,
    lastLen: 0,
    spanCount: 0,
    elapsedTimer: 0,
    pendingText: '',
    streamRaf: 0
  };

  // Live elapsed counter so the final "Thought for Xs" doesn't appear from nowhere
  api.elapsedTimer = setInterval(() => {
    if (api.elapsedEl) {
      api.elapsedEl.textContent = formatThoughtDuration(performance.now() - api.startedAt);
    }
  }, 100);
  liveReasoningPanels.add(api);

  return api;
}

/** Max live .token-fade spans before merging the oldest back into a text node */
const REASONING_SPAN_CAP = 300;

const REASONING_SPAN_MERGE = 150;

/**
 * rAF-coalesced: reasoning tokens can arrive hundreds of times a second, and
 * each DOM append + scroll forces layout. Callers always pass the cumulative
 * text, so only the latest snapshot per frame needs to touch the DOM.
 */
function updateReasoningStream(panelApi, text) {
  if (!panelApi || !text || panelApi.finalized) return;
  panelApi.pendingText = text;
  if (panelApi.streamRaf) return;
  panelApi.streamRaf = requestAnimationFrame(() => {
    panelApi.streamRaf = 0;
    if (!panelApi.finalized) applyReasoningText(panelApi, panelApi.pendingText);
  });
}

/** Apply any snapshot still waiting on a frame (finalize/destroy paths) */
function flushReasoningStream(panelApi) {
  if (!panelApi || !panelApi.streamRaf) return;
  cancelAnimationFrame(panelApi.streamRaf);
  panelApi.streamRaf = 0;
  if (panelApi.pendingText) applyReasoningText(panelApi, panelApi.pendingText);
}

function applyReasoningText(panelApi, text) {
  const { streamEl } = panelApi;

  if (text.length > panelApi.lastLen) {
    const empty = streamEl.querySelector('.reasoning-empty');
    if (empty) empty.remove();

    // Append only the delta as a fading span — tokens materialize in place
    const delta = text.slice(panelApi.lastLen);
    const span = document.createElement('span');
    span.className = 'token-fade';
    span.textContent = delta;
    streamEl.appendChild(span);
    panelApi.spanCount++;

    // Cap live spans: merge the oldest batch into a single text node
    if (panelApi.spanCount > REASONING_SPAN_CAP) {
      const spans = streamEl.querySelectorAll('span.token-fade');
      const cut = Math.min(REASONING_SPAN_MERGE, spans.length);
      let merged = '';
      for (let i = 0; i < cut; i++) merged += spans[i].textContent;
      streamEl.insertBefore(document.createTextNode(merged), spans[0]);
      for (let i = 0; i < cut; i++) spans[i].remove();
      streamEl.normalize();
      panelApi.spanCount -= cut;
    }
  } else if (text.length < panelApi.lastLen) {
    // Content reset/shrank (shouldn't happen mid-stream) — rebuild plain
    streamEl.textContent = text;
    panelApi.spanCount = 0;
  }

  panelApi.lastLen = text.length;
  panelApi.subEl.textContent = 'Chain of thought';
  // Keep scrolled to bottom while thinking
  const wrap = streamEl.closest('.reasoning-stream-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function finalizeReasoningPanel(panelApi, { forceOpen = false, stopped = false } = {}) {
  if (!panelApi || panelApi.finalized) return;
  flushReasoningStream(panelApi);
  panelApi.finalized = true;
  clearInterval(panelApi.elapsedTimer);
  liveReasoningPanels.delete(panelApi);
  if (panelApi.elapsedEl) panelApi.elapsedEl.remove();
  panelApi.durationMs = Math.round(performance.now() - panelApi.startedAt);
  const duration = formatThoughtDuration(performance.now() - panelApi.startedAt);
  const panel = panelApi.el;
  panel.classList.remove('thinking');
  panel.classList.add('done');

  panelApi.titleEl.classList.remove('shimmer-text');
  panelApi.titleEl.textContent = stopped ? `Thought · stopped at ${duration}` : `Thought for ${duration}`;
  panelApi.subEl.textContent = stopped
    ? 'Reasoning interrupted'
    : 'Tap to expand chain of thought';

  if (!forceOpen) {
    panel.classList.remove('open');
    panel.dataset.open = 'false';
    panel.querySelector('.reasoning-toggle')?.setAttribute('aria-expanded', 'false');
  }
}

/** Reasoning panels whose 100ms elapsed timer is still running */
const liveReasoningPanels = new Set();

/**
 * Stop a reasoning panel's elapsed timer, optionally removing the panel.
 * Every path that drops a panel without finalizing it must come through here —
 * a detached panel whose interval still runs burns CPU for the whole session.
 */

/**
 * Stop a reasoning panel's elapsed timer, optionally removing the panel.
 * Every path that drops a panel without finalizing it must come through here —
 * a detached panel whose interval still runs burns CPU for the whole session.
 */
function destroyReasoningPanel(panelApi, { remove = true } = {}) {
  if (!panelApi) return null;
  clearInterval(panelApi.elapsedTimer);
  panelApi.elapsedTimer = 0;
  if (remove) {
    // Panel is leaving the DOM — drop any snapshot still waiting on a frame
    if (panelApi.streamRaf) cancelAnimationFrame(panelApi.streamRaf);
    panelApi.streamRaf = 0;
  } else {
    flushReasoningStream(panelApi);
  }
  liveReasoningPanels.delete(panelApi);
  if (remove) panelApi.el.remove();
  return null;
}

/**
 * Backstop for panels orphaned by an abandoned run (New Chat mid-stream, a
 * stopped project turn): the transcript they lived in is already gone, so only
 * their timers survive. Called wherever a session/run counter is bumped.
 */

/**
 * Backstop for panels orphaned by an abandoned run (New Chat mid-stream, a
 * stopped project turn): the transcript they lived in is already gone, so only
 * their timers survive. Called wherever a session/run counter is bumped.
 */
function sweepReasoningTimers() {
  for (const api of liveReasoningPanels) clearInterval(api.elapsedTimer);
  liveReasoningPanels.clear();
}

function appendMessage(role, content, streaming = false) {
  clearWelcome();
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  msg.dataset.role = role;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'You' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (streaming ? ' streaming' : '');
  if (role === 'assistant' && !streaming && content) {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  if (role === 'assistant') {
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.appendChild(bubble);
    msg.appendChild(avatar);
    msg.appendChild(body);
    messagesEl.appendChild(msg);
    if (!streaming && content) addMessageActions(msg, body, content);
    scrollToBottom();
    return { msgEl: msg, bubble, body };
  }

  // User messages get a body wrapper too, so a Copy · Edit row can sit under
  // the bubble (right-aligned via CSS).
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.appendChild(bubble);
  msg.appendChild(avatar);
  msg.appendChild(body);
  messagesEl.appendChild(msg);
  addUserActions(msg, body, content);
  scrollToBottom();
  return { msgEl: msg, bubble, body };
}

const COPY_SVG =
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

/** Hover-reveal action row under assistant bubbles: Copy · Regenerate */
function addMessageActions(msgEl, body, rawContent) {
  msgEl._raw = rawContent;
  if (!body || body.querySelector('.msg-actions')) return;
  const row = document.createElement('div');
  row.className = 'msg-actions';
  row.innerHTML =
    `<button type="button" class="msg-action-btn" data-act="copy">` +
    COPY_SVG +
    `<span>Copy</span></button>` +
    `<button type="button" class="msg-action-btn" data-act="regen">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>` +
    `<span>Regenerate</span></button>`;
  body.appendChild(row);
}

/** Hover-reveal action row under user bubbles: Copy · Edit */
function addUserActions(msgEl, body, rawContent) {
  msgEl._raw = rawContent;
  if (!body || body.querySelector('.msg-actions')) return;
  const row = document.createElement('div');
  row.className = 'msg-actions';
  row.innerHTML =
    `<button type="button" class="msg-action-btn" data-act="copy">` +
    COPY_SVG +
    `<span>Copy</span></button>` +
    `<button type="button" class="msg-action-btn" data-act="edit">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>` +
    `<span>Edit</span></button>`;
  body.appendChild(row);
}

/**
 * Mark an assistant shell that stays on screen but was never pushed to
 * history (a stop that kept only the chain of thought or a debate
 * transcript). Excluded from DOM ↔ history mapping so Edit/Regenerate keep
 * pointing at the right turn.
 */

/**
 * Mark an assistant shell that stays on screen but was never pushed to
 * history (a stop that kept only the chain of thought or a debate
 * transcript). Excluded from DOM ↔ history mapping so Edit/Regenerate keep
 * pointing at the right turn.
 */
function markOrphanMessage(msgEl) {
  if (msgEl && msgEl.parentNode) msgEl.classList.add('msg-orphan');
}

/**
 * Edit a user turn: rewind the conversation to just before it and put the
 * text back in the composer. DOM ↔ history index is aligned from the tail,
 * because pushHistoryMessage may have trimmed the head past HISTORY_MAX.
 * Orphan shells (stopped turns that never entered history) are skipped.
 */

/**
 * Edit a user turn: rewind the conversation to just before it and put the
 * text back in the composer. DOM ↔ history index is aligned from the tail,
 * because pushHistoryMessage may have trimmed the head past HISTORY_MAX.
 * Orphan shells (stopped turns that never entered history) are skipped.
 */
function editUserMessage(msgEl) {
  if (isStreaming) {
    flashStatus('Stop the current stream first');
    return;
  }
  const all = Array.from(messagesEl.querySelectorAll('.msg:not(.msg-orphan)'));
  const domIdx = all.indexOf(msgEl);
  if (domIdx < 0) return;
  const mIdx = messages.length - (all.length - domIdx);
  if (mIdx < 0 || mIdx >= messages.length || messages[mIdx].role !== 'user') return;
  const draft = messages[mIdx].content;
  setMessages(messages.slice(0, mIdx));
  scheduleHistorySave();
  renderHistoryFromState();
  updateScrollFab();
  updateContextUI();
  userInput.value = draft;
  autoResize();
  userInput.focus();
  userInput.setSelectionRange(draft.length, draft.length);
  flashStatus('Editing — Enter resends from here', 2600);
}

/** Regenerate: drop the last assistant reply and re-run the same prompt */
async function regenerate(msgEl) {
  if (isStreaming) return;
  const assistants = messagesEl.querySelectorAll('.msg.assistant:not(.msg-orphan)');
  const lastAssistantEl = assistants[assistants.length - 1];
  if (
    msgEl !== lastAssistantEl ||
    !messages.length ||
    messages[messages.length - 1].role !== 'assistant'
  ) {
    flashStatus('Only the latest reply can be regenerated');
    return;
  }
  const wasDebate = !!messages[messages.length - 1]?.debate;
  if (wasDebate) {
    const issue = validateDebateSetup();
    if (issue) {
      appendError(`Debate setup: ${issue}`);
      openSidebar();
      setSidebarPanel('debate');
      return;
    }
  } else {
    const cfg = getValidatedConfig();
    if (!cfg) return;
  }
  const removed = messages.pop();
  scheduleHistorySave();
  msgEl.remove();
  stickToBottom = true;
  // A debate-produced reply regenerates as a debate (same task = last user msg)
  const lastUser = messages.length && messages[messages.length - 1].role === 'user'
    ? messages[messages.length - 1].content
    : '';
  if (removed && removed.debate && lastUser) {
    await runDebate(getConfig(), lastUser);
  } else {
    const cfg = getValidatedConfig();
    if (!cfg) return;
    await streamAssistantReply(cfg);
  }
}

/**
 * Permanent error line in the transcript, plus the floating toast.
 * `onRetry` adds a Retry button — a failed turn leaves the user's message in
 * history, so re-running it is one click instead of copy-paste.
 */

/**
 * Permanent error line in the transcript, plus the floating toast.
 * `onRetry` adds a Retry button — a failed turn leaves the user's message in
 * history, so re-running it is one click instead of copy-paste.
 */
function appendError(text, { onRetry = null, retryLabel = '↻ Retry' } = {}) {
  clearWelcome();
  const div = document.createElement('div');
  div.className = 'error-toast';
  const msg = document.createElement('span');
  msg.className = 'error-toast-msg';
  msg.textContent = text;
  div.appendChild(msg);
  if (typeof onRetry === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'error-retry';
    btn.textContent = retryLabel;
    btn.addEventListener('click', () => {
      if (isStreaming) return;
      div.remove();
      onRetry();
    });
    div.appendChild(btn);
  }
  messagesEl.appendChild(div);
  scrollToBottom();
  showErrorToast(text);
}

/**
 * Re-answer the last user turn after a failure. Nothing is rewound: the turn
 * is still in history and on screen, exactly as the model will see it.
 */

/**
 * Re-answer the last user turn after a failure. Nothing is rewound: the turn
 * is still in history and on screen, exactly as the model will see it.
 */
async function retryLastTurn({ debate = false } = {}) {
  if (isStreaming) return;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    flashStatus('Nothing to retry');
    return;
  }
  if (debate) {
    const issue = validateDebateSetup();
    if (issue) {
      appendError(`Debate setup: ${issue}`);
      openSidebar();
      setSidebarPanel('debate');
      return;
    }
    stickToBottom = true;
    flashStatus('Retrying…');
    await runDebate(getConfig(), last.content);
    return;
  }
  const cfg = getValidatedConfig();
  if (!cfg) return;
  stickToBottom = true;
  flashStatus('Retrying…');
  await streamAssistantReply(cfg);
}

/** Floating auto-dismissing toast (the transcript copy above stays permanently) */
let activeFloatToast = null;

function showErrorToast(text) {
  if (activeFloatToast) activeFloatToast.remove();
  const t = document.createElement('div');
  t.className = 'float-toast';
  t.setAttribute('role', 'alert');
  t.innerHTML =
    `<span class="float-toast-msg"></span>` +
    `<button type="button" class="float-toast-x" aria-label="Dismiss">✕</button>` +
    `<i class="float-toast-bar" aria-hidden="true"></i>`;
  t.querySelector('.float-toast-msg').textContent = text;
  document.body.appendChild(t);
  activeFloatToast = t;

  const DURATION = 6000;
  const bar = t.querySelector('.float-toast-bar');
  bar.style.animationDuration = DURATION + 'ms';
  let remaining = DURATION;
  let startAt = performance.now();
  let timer = setTimeout(dismiss, DURATION);

  function dismiss() {
    clearTimeout(timer);
    if (!t.isConnected) return;
    t.classList.add('leaving');
    const drop = () => {
      t.remove();
      if (activeFloatToast === t) activeFloatToast = null;
    };
    t.addEventListener('animationend', drop, { once: true });
    setTimeout(drop, 400); // fallback if animations are disabled
  }

  // Hover pauses both the JS timer and the drain bar
  t.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    remaining -= performance.now() - startAt;
    bar.style.animationPlayState = 'paused';
  });
  t.addEventListener('mouseleave', () => {
    startAt = performance.now();
    timer = setTimeout(dismiss, Math.max(400, remaining));
    bar.style.animationPlayState = 'running';
  });
  t.querySelector('.float-toast-x').addEventListener('click', dismiss);
}

const READY_STATUS = 'Ready · Enter send · Esc stop';

const scrollFab = $('#scrollFab');

let stickToBottom = true;

function isNearBottom(threshold = 80) {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function updateScrollFab() {
  if (!scrollFab) return;
  const show = !isNearBottom(100) && messagesEl.scrollHeight > messagesEl.clientHeight + 40;
  scrollFab.classList.toggle('visible', show);
}

/** rAF-coalesced: dozens of per-token calls collapse into one scroll per frame */
let scrollRafPending = false;

let fabRafPending = false;

function scheduleScrollFabUpdate() {
  if (fabRafPending) return;
  fabRafPending = true;
  requestAnimationFrame(() => {
    fabRafPending = false;
    updateScrollFab();
  });
}

function scrollToBottom({ force = false, smooth = false } = {}) {
  if (!force && !stickToBottom) {
    scheduleScrollFabUpdate();
    return;
  }
  stickToBottom = true;
  if (smooth) {
    requestAnimationFrame(() => {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      updateScrollFab();
    });
    return;
  }
  if (scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateScrollFab();
  });
}

/** Scroll a transcript message into view and pulse it (search result jump).
 * `index` addresses `messages`, so align from the TAIL: a live session's DOM
 * keeps every bubble while `messages` is head-trimmed at HISTORY_MAX, and
 * head-indexing flashed an earlier, wrong message after 200+ turns. */
function flashMessageAt(index) {
  const all = messagesEl.querySelectorAll('.msg:not(.msg-orphan)');
  const el = all[all.length - (messages.length - index)];
  if (!el) return;
  stickToBottom = false;
  el.scrollIntoView({
    block: 'center',
    behavior: prefersReducedMotion.matches ? 'auto' : 'smooth'
  });
  el.classList.remove('msg-flash');
  void el.offsetWidth; // restart the one-shot pulse
  el.classList.add('msg-flash');
  clearTimeout(el._flashT);
  el._flashT = setTimeout(() => el.classList.remove('msg-flash'), 2400);
  updateScrollFab();
}

function flashStatus(text, ms = 1600) {
  statusText.textContent = text;
  setTimeout(() => {
    if (statusText.textContent === text) statusText.textContent = READY_STATUS;
  }, ms);
}

function setStreamingUi(active) {
  setIsStreaming(active);
  // the tab icon deliberates while you are on another tab
  if (typeof setFaviconThinking === 'function') setFaviconThinking(!!active);
  // Keep button enabled so it can act as Stop while streaming.
  // Both icons live stacked in the button; .stop-mode crossfades/rotates them in CSS.
  sendBtn.disabled = false;
  sendBtn.classList.toggle('stop-mode', active);
  sendBtn.title = active ? 'Stop' : 'Send';
  sendBtn.setAttribute('aria-label', active ? 'Stop generation' : 'Send message');
  // Ambient "alive while thinking" cue on the page chrome
  document.body.classList.toggle('is-streaming', !!active);
  // Mode switches mid-run hide a docked arena / kill the project journal view
  $('#debateToggle')?.toggleAttribute('disabled', !!active);
  $('#projectToggle')?.toggleAttribute('disabled', !!active);
}

/** Run fn inside a View Transition when supported; otherwise run immediately. */
function withViewTransition(fn) {
  if (prefersReducedMotion.matches || typeof document.startViewTransition !== 'function') {
    fn();
    return;
  }
  try {
    // A transition started while another is still running rejects with
    // InvalidStateError — the DOM update still happens, so just swallow it.
    const t = document.startViewTransition(fn);
    t?.finished?.catch(() => {});
    t?.updateCallbackDone?.catch(() => {});
    t?.ready?.catch(() => {});
  } catch {
    fn();
  }
}

/** Quick radial ripple from the send button on successful send */
function fireSendRipple() {
  if (prefersReducedMotion.matches) return;
  const r = document.createElement('span');
  r.className = 'send-ripple';
  sendBtn.appendChild(r);
  r.addEventListener('animationend', () => r.remove(), { once: true });
  setTimeout(() => r.remove(), 600);
}

// ===== Scroll-FAB unread pulse =====
let fabUnread = false;

function markStreamUnread() {
  if (fabUnread || stickToBottom || !scrollFab) return;
  fabUnread = true;
  scrollFab.classList.add('unread');
  scrollFab.classList.remove('pulse');
  void scrollFab.offsetWidth; // restart the one-shot pulse
  scrollFab.classList.add('pulse');
}

function clearStreamUnread() {
  if (!fabUnread || !scrollFab) return;
  fabUnread = false;
  scrollFab.classList.remove('unread', 'pulse');
}

function stopStreaming() {
  if (abortController) {
    abortController.abort();
    setAbortController(null);
  }
}

/**
 * Cancel-with-nothing-received: unwind the exchange completely — assistant
 * shell and user bubble leave the DOM, the user turn leaves history, and the
 * text returns to the composer, so view, state, and draft all agree.
 */

/**
 * Cancel-with-nothing-received: unwind the exchange completely — assistant
 * shell and user bubble leave the DOM, the user turn leaves history, and the
 * text returns to the composer, so view, state, and draft all agree.
 */
function unwindLastUserExchange(msgEl, restoreDraft) {
  if (msgEl && msgEl.parentNode) msgEl.remove();
  if (messages.length && messages[messages.length - 1].role === 'user') {
    const popped = messages.pop();
    scheduleHistorySave();
    const userEls = messagesEl.querySelectorAll('.msg.user');
    const lastUserEl = userEls[userEls.length - 1];
    if (lastUserEl && lastUserEl.querySelector('.bubble')?.textContent === popped.content) {
      lastUserEl.remove();
    }
    if (restoreDraft && !userInput.value.trim()) {
      userInput.value = popped.content;
      autoResize();
      updateContextUI();
    }
  }
  if (!messages.length) renderHistoryFromState();
}

function setStickToBottom(v) { stickToBottom = v; return v; }

export { COPY_SVG, READY_STATUS, REASONING_SPAN_CAP, REASONING_SPAN_MERGE, activeFloatToast, addMessageActions, addUserActions, appendError, appendMessage, clearStreamUnread, clearWelcome, createReasoningPanel, destroyReasoningPanel, editUserMessage, fabRafPending, fabUnread, finalizeReasoningPanel, fireSendRipple, flashMessageAt, flashStatus, formatThoughtDuration, isNearBottom, liveReasoningPanels, markOrphanMessage, markStreamUnread, regenerate, retryLastTurn, scheduleScrollFabUpdate, scrollFab, scrollRafPending, scrollToBottom, setStreamingUi, showErrorToast, stickToBottom, stopStreaming, sweepReasoningTimers, unwindLastUserExchange, updateReasoningStream, updateScrollFab, withViewTransition, setStickToBottom };
