import { detectContextFromProvider, scheduleContextDetect } from '../context.js';
import { debateSettings, loadDebateTeamById } from '../debate/settings.js';
import { exportChat } from '../export.js';
import { escapeHtml } from '../markdown.js';
import { favoriteId, updateModelWarnings } from '../models.js';
import { projectMode, setProjectMode } from '../project/state.js';
import { activeProviderId, providers } from '../providers.js';
import { SESSION_PREFIX, activeSessionId, relTime, sessionIndex, switchSession } from '../sessions.js';
import { $, DEFAULT_MODELS, HISTORY_MAX, debateTeams, messages, prefersReducedMotion, savedModels, sidebar, userInput } from '../state.js';
import { setActiveProvider, updateTopbar } from '../ui/providers.js';
import { closeSidebar, newChat, openSidebar } from '../ui/sidebar.js';
import { flashMessageAt, flashStatus, withViewTransition } from '../ui/transcript.js';

// ========== Command palette (Ctrl/Cmd+K) ==========
const cmdkOverlay = $('#cmdkOverlay');

const cmdkInput = $('#cmdkInput');

const cmdkList = $('#cmdkList');

let cmdkFiltered = [];

let cmdkIndex = 0;

let cmdkPrevFocus = null;

/** Close-animation timer — openCmdk cancels it so a quick reopen survives. */
let cmdkCloseTimer = 0;
/** Only stagger cmdk items on open — re-renders while typing must not replay */
let cmdkStagger = false;

/** Tiny subsequence fuzzy matcher: returns { score, indices } or null */
function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  let qi = 0;
  let score = 0;
  let lastHit = -2;
  const indices = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let s = 1;
    if (lastHit === ti - 1) s += 3; // consecutive run
    if (ti === 0 || /[\s/\-_.:]/.test(t[ti - 1])) s += 2; // word boundary
    score += s;
    indices.push(ti);
    lastHit = ti;
    qi++;
  }
  if (qi < q.length) return null;
  score -= Math.floor((t.length - q.length) / 4); // prefer tighter matches
  return { score, indices };
}

function highlightMatch(label, indices) {
  const set = new Set(indices);
  let out = '';
  for (let i = 0; i < label.length; i++) {
    const ch = escapeHtml(label[i]);
    out += set.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return out;
}

/** Parsed conversations for palette search; rebuilt on each palette open */
let cmdkSearchCache = null;

/**
 * Messages of any session — the live array for the active one, storage
 * otherwise. Stored sessions go through loadHistory()'s exact filter so a hit
 * index still lines up with the rendered transcript after switching.
 */

/**
 * Messages of any session — the live array for the active one, storage
 * otherwise. Stored sessions go through loadHistory()'s exact filter so a hit
 * index still lines up with the rendered transcript after switching.
 */
function sessionMessages(id) {
  if (id === activeSessionId) return messages;
  try {
    const arr = JSON.parse(localStorage.getItem(SESSION_PREFIX + id) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content
      )
      .slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

/** One-line context around a hit, with the match wrapped in <mark> */
function searchSnippetHtml(text, at, len) {
  const from = Math.max(0, at - 34);
  const to = Math.min(text.length, at + len + 90);
  const tidy = (x) => escapeHtml(x.replace(/\s+/g, ' '));
  return (
    (from > 0 ? '…' : '') +
    tidy(text.slice(from, at)) +
    `<mark>${tidy(text.slice(at, at + len))}</mark>` +
    tidy(text.slice(at + len, to)) +
    (to < text.length ? '…' : '')
  );
}

/**
 * Substring search over every stored conversation, newest chat first.
 * Results jump straight to the matching message. Parsing ≤30 sessions once
 * per palette open keeps this instant without an index to maintain.
 */

/**
 * Substring search over every stored conversation, newest chat first.
 * Results jump straight to the matching message. Parsing ≤30 sessions once
 * per palette open keeps this instant without an index to maintain.
 */
function searchAllChats(query, { limit = 12, perChat = 3 } = {}) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  if (!cmdkSearchCache) {
    cmdkSearchCache = [...sessionIndex]
      .sort((a, b) => (b.up || b.at) - (a.up || a.at))
      .map((s) => ({ meta: s, msgs: sessionMessages(s.id) }));
  }
  const out = [];
  for (const { meta, msgs } of cmdkSearchCache) {
    let hitsHere = 0;
    for (let i = 0; i < msgs.length && hitsHere < perChat && out.length < limit; i++) {
      const m = msgs[i];
      const content = typeof m?.content === 'string' ? m.content : '';
      const at = content.toLowerCase().indexOf(q);
      if (at === -1) continue;
      hitsHere++;
      const where = meta.id === activeSessionId ? 'this chat' : meta.title || 'chat';
      out.push({
        label: content.slice(at, at + 60),
        icon: m.role === 'user' ? '›' : '⌕',
        hint: `${where} · ${relTime(meta.up || meta.at)}`,
        _hl: searchSnippetHtml(content, at, q.length),
        run: () => {
          // Project Mode shows its journal instead of the chat — leave it first
          // so the transcript exists to jump into (switchSession does this too)
          if (projectMode.enabled && meta.id === activeSessionId) {
            setProjectMode(false, { silent: true });
          }
          if (meta.id === activeSessionId) flashMessageAt(i);
          else switchSession(meta.id, { focusIndex: i });
        }
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

function buildCmdkItems() {
  const currentModel = $('#model').value.trim();
  const actions = [
    { label: 'New Chat', hint: 'Ctrl+Shift+O', icon: '✦', run: () => newChat() },
    {
      label: debateSettings.enabled ? 'Debate Mode · turn off' : 'Debate Mode · turn on',
      hint: 'multi-expert answers',
      icon: '⚔',
      run: () => $('#debateToggle')?.click()
    },
    {
      label: projectMode.enabled ? 'Project Mode · turn off' : 'Project Mode · turn on',
      hint: 'team builds in a folder',
      icon: '▦',
      run: () => $('#projectToggle')?.click()
    },
    { label: 'Export · Markdown', hint: '.md', icon: '⇣', run: () => exportChat('md') },
    { label: 'Export · Plain text', hint: '.txt', icon: '⇣', run: () => exportChat('txt') },
    { label: 'Export · JSON', hint: '.json', icon: '⇣', run: () => exportChat('json') },
    {
      label: 'Toggle Sidebar',
      hint: 'Settings panel',
      icon: '☰',
      run: () => (sidebar.classList.contains('collapsed') ? openSidebar() : closeSidebar())
    },
    {
      label: 'Detect Context Limit',
      hint: 'query provider /models',
      icon: '◎',
      run: () => detectContextFromProvider({ silent: false, force: true })
    },
    { label: 'Focus Input', hint: 'Jump to composer', icon: '✎', run: () => userInput.focus() }
  ];
  const sessionActions = [...sessionIndex]
    .sort((a, b) => (b.up || b.at) - (a.up || a.at))
    .filter((s) => s.id !== activeSessionId)
    .slice(0, 15)
    .map((s) => ({
      label: `Chat · ${s.title || 'New chat'}`,
      hint: `${s.n || 0} msgs · ${relTime(s.up || s.at)}`,
      icon: '❯',
      run: () => switchSession(s.id)
    }));
  const providerActions = providers.map((p) => ({
    label: `Provider · ${p.name}`,
    hint: p.id === activeProviderId ? 'active' : 'switch provider',
    icon: '⚡',
    run: () => setActiveProvider(p.id)
  }));
  const favIds = savedModels.map(favoriteId).filter(Boolean);
  const models = [...new Set([...favIds, ...DEFAULT_MODELS])].map((m) => ({
    label: m,
    hint: m === currentModel ? 'current model' : 'switch model',
    icon: '◈',
    mono: true,
    run: () => {
      $('#model').value = m;
      updateTopbar();
      scheduleContextDetect();
      updateModelWarnings();
      flashStatus(`Model → ${m}`);
    }
  }));
  const teamActions = debateTeams.map((t) => ({
    label: `Team · ${t.name}`,
    hint: 'load team & enable debate',
    icon: '⚔',
    run: () => {
      loadDebateTeamById(t.id, { enable: true });
      openSidebar();
    }
  }));
  return [...actions, ...sessionActions, ...teamActions, ...providerActions, ...models];
}

function renderCmdkList(query) {
  const items = buildCmdkItems();
  const q = query.trim();
  if (!q) {
    cmdkFiltered = items.map((it) => ({ ...it, _hl: escapeHtml(it.label) }));
  } else {
    const commands = items
      .map((it) => {
        const m = fuzzyMatch(q, it.label);
        return m ? { ...it, _score: m.score, _hl: highlightMatch(it.label, m.indices) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b._score - a._score)
      .slice(0, 24);
    // Commands first (you usually mean one), then message hits from every chat
    cmdkFiltered = [...commands, ...searchAllChats(q)];
  }
  cmdkIndex = Math.min(cmdkIndex, Math.max(0, cmdkFiltered.length - 1));
  if (!cmdkFiltered.length) {
    cmdkList.innerHTML = '<div class="cmdk-empty">No matches</div>';
    cmdkStagger = false;
    return;
  }
  const doStagger = cmdkStagger && !prefersReducedMotion.matches;
  cmdkList.innerHTML = cmdkFiltered
    .map(
      (it, i) =>
        `<div class="cmdk-item${i === cmdkIndex ? ' active' : ''}${it.mono ? ' mono' : ''}${doStagger && i < 12 ? ' cmdk-stagger' : ''}" role="option" aria-selected="${i === cmdkIndex}" data-i="${i}"${doStagger && i < 12 ? ` style="--i:${i}"` : ''}>` +
        `<span class="cmdk-icon" aria-hidden="true">${it.icon}</span>` +
        `<span class="cmdk-label">${it._hl}</span>` +
        `<span class="cmdk-hint">${escapeHtml(it.hint || '')}</span>` +
        `</div>`
    )
    .join('');
  // Stagger only once per open
  cmdkStagger = false;
  cmdkList.querySelector('.cmdk-item.active')?.scrollIntoView({ block: 'nearest' });
}

function moveCmdkIndex(delta) {
  if (!cmdkFiltered.length) return;
  cmdkIndex = (cmdkIndex + delta + cmdkFiltered.length) % cmdkFiltered.length;
  cmdkList.querySelectorAll('.cmdk-item').forEach((el, i) => {
    el.classList.toggle('active', i === cmdkIndex);
    el.setAttribute('aria-selected', i === cmdkIndex ? 'true' : 'false');
  });
  cmdkList.querySelector('.cmdk-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openCmdk() {
  if (!cmdkOverlay) return;
  // Cancel a still-running close animation: its deferred `finish` would hide
  // the freshly opened palette 200ms in, and while `hidden` was still false
  // the app-level Ctrl+K toggle read the closing palette as open and swallowed
  // the reopen keypress.
  clearTimeout(cmdkCloseTimer);
  cmdkCloseTimer = 0;
  cmdkOverlay.classList.remove('closing');
  cmdkPrevFocus = document.activeElement;
  cmdkStagger = true;
  cmdkSearchCache = null; // re-read conversations: they change between opens
  // Reset synchronously — the view transition defers `show`, and anything typed
  // in that gap must not be wiped.
  cmdkInput.value = '';
  cmdkIndex = 0;
  const show = () => {
    cmdkOverlay.hidden = false;
    renderCmdkList(cmdkInput.value);
    cmdkInput.focus();
  };
  withViewTransition(show);
}

function closeCmdk() {
  if (!cmdkOverlay || cmdkOverlay.hidden) return;
  const finish = () => {
    cmdkCloseTimer = 0;
    cmdkOverlay.classList.remove('closing');
    cmdkOverlay.hidden = true;
  };
  const hide = () => {
    if (prefersReducedMotion.matches) {
      finish();
    } else {
      cmdkOverlay.classList.add('closing');
      cmdkCloseTimer = setTimeout(finish, 200);
    }
  };
  // Close immediately — a view transition here can be skipped by the next one
  // and would leave the palette stuck open.
  hide();
  // Restore focus to wherever the user was (focus trap release)
  if (cmdkPrevFocus && typeof cmdkPrevFocus.focus === 'function') cmdkPrevFocus.focus();
  cmdkPrevFocus = null;
}

function runCmdkItem(i) {
  const item = cmdkFiltered[i];
  if (!item) return;
  closeCmdk();
  item.run();
}

cmdkInput?.addEventListener('input', () => {
  cmdkIndex = 0;
  renderCmdkList(cmdkInput.value);
});

cmdkInput?.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    moveCmdkIndex(1);
  } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault();
    moveCmdkIndex(-1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    moveCmdkIndex(-cmdkIndex);
  } else if (e.key === 'End') {
    e.preventDefault();
    moveCmdkIndex(cmdkFiltered.length - 1 - cmdkIndex);
  } else if (e.key === 'Enter') {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    runCmdkItem(cmdkIndex);
  }
});

cmdkList?.addEventListener('click', (e) => {
  const item = e.target.closest('.cmdk-item');
  if (item) runCmdkItem(Number(item.dataset.i));
});

cmdkList?.addEventListener('mousemove', (e) => {
  const item = e.target.closest('.cmdk-item');
  if (!item) return;
  const i = Number(item.dataset.i);
  if (i !== cmdkIndex) {
    cmdkIndex = i;
    cmdkList.querySelectorAll('.cmdk-item').forEach((el, j) => {
      el.classList.toggle('active', j === i);
      el.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
  }
});

cmdkOverlay?.addEventListener('mousedown', (e) => {
  if (e.target === cmdkOverlay) closeCmdk();
});

export { buildCmdkItems, closeCmdk, cmdkFiltered, cmdkIndex, cmdkInput, cmdkList, cmdkOverlay, cmdkPrevFocus, cmdkSearchCache, cmdkStagger, fuzzyMatch, highlightMatch, moveCmdkIndex, openCmdk, renderCmdkList, runCmdkItem, searchAllChats, searchSnippetHtml, sessionMessages };
