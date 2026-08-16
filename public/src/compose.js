import { runDebate } from './debate/engine.js';
import { debateSettings } from './debate/settings.js';
import { validateDebateSetup } from './debate/ui.js';
import { pushHistoryMessage } from './history.js';
import { getConfig } from './config.js';
import { getValidatedConfig } from './net/stream.js';
import { projectMode, validateProjectSetup } from './project/state.js';
import { streamAssistantReply } from './solo.js';
import { isStreaming, userInput } from './state.js';
import { runProjectInstruction } from './ui/inspector.js';
import { autoResize, openSidebar, setSidebarPanel } from './ui/sidebar.js';
import { appendError, appendMessage, fireSendRipple, setStickToBottom, stopStreaming } from './ui/transcript.js';

async function sendMessage() {
  if (isStreaming) {
    stopStreaming();
    return;
  }

  const text = userInput.value.trim();
  if (!text) return;

  // Project mode has its own per-seat providers and journal
  if (projectMode.enabled) {
    // Validate BEFORE the composer is cleared — same contract as the debate
    // branch below: a setup rejection must leave the typed draft in place.
    const issue = validateProjectSetup();
    if (issue) {
      appendError(`Project setup: ${issue}`);
      openSidebar();
      setSidebarPanel('project');
      return;
    }
    userInput.value = '';
    clearComposerDraft();
    autoResize();
    fireSendRipple();
    setStickToBottom(true);
    await runProjectInstruction(text);
    return;
  }

  // Debate seats carry their own providers. The solo API key must not block
  // a fully configured team.
  if (debateSettings.enabled) {
    const issue = validateDebateSetup();
    if (issue) {
      appendError(`Debate setup: ${issue}`);
      openSidebar();
      setSidebarPanel('debate');
      return;
    }
    pushHistoryMessage('user', text);
    setStickToBottom(true);
    appendMessage('user', text);
    userInput.value = '';
    clearComposerDraft();
    autoResize();
    fireSendRipple();
    await runDebate(getConfig(), text);
    return;
  }

  const cfg = getValidatedConfig();
  if (!cfg) return;

  pushHistoryMessage('user', text);
  setStickToBottom(true);
  appendMessage('user', text);
  userInput.value = '';
  clearComposerDraft();
  autoResize();
  fireSendRipple();
  await streamAssistantReply(cfg);
}

// ===== Composer draft persistence (survives accidental reloads) =====
const DRAFT_KEY = 'customChatDraft';

let draftTimer = null;

function scheduleComposerDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      const v = userInput.value;
      if (v && v.trim()) localStorage.setItem(DRAFT_KEY, v);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* quota */
    }
  }, 400);
}

function clearComposerDraft() {
  clearTimeout(draftTimer);
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

export { DRAFT_KEY, clearComposerDraft, draftTimer, scheduleComposerDraftSave, sendMessage };
