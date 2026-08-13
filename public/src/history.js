import { saveHistory } from './sessions.js';
import { HISTORY_MAX, historySaveTimer, isStreaming, messages, setHistorySaveTimer, setMessages } from './state.js';
import { estimateTokens } from './tokens.js';

/** Ensure message has cached token estimate (_tok); compute once per content. */
function ensureMsgTokens(m) {
  if (m && typeof m._tok !== 'number') {
    m._tok = estimateTokens(m.content);
  }
  return m ? m._tok : 0;
}

/**
 * Sum cached per-message token estimates. Only re-tokenizes system prompt
 * (and callers should estimate the live draft separately).
 */

/**
 * Sum cached per-message token estimates. Only re-tokenizes system prompt
 * (and callers should estimate the live draft separately).
 */
function estimateMessagesTokens(msgs, systemPrompt) {
  let total = 0;
  if (systemPrompt && systemPrompt.trim()) {
    total += estimateTokens(systemPrompt) + 4;
  }
  for (const m of msgs) {
    total += 4; // role framing
    total += ensureMsgTokens(m);
  }
  total += 3; // reply priming
  return total;
}

/** Push a history message with precomputed _tok and schedule persistence. */
function pushHistoryMessage(role, content) {
  const m = { role, content, _tok: estimateTokens(content) };
  messages.push(m);
  if (messages.length > HISTORY_MAX) {
    setMessages(messages.slice(-HISTORY_MAX));
  }
  scheduleHistorySave();
  return m;
}

function scheduleHistorySave() {
  clearTimeout(historySaveTimer);
  setHistorySaveTimer(setTimeout(saveHistory, 500));
}

/** Cap a persisted debate record at ~150KB by dropping oldest turns first */
function truncateDebateRecord(d) {
  // Preserve all known fields (including judge-mode) so history restore stays correct
  const copy = {
    experts: d.experts,
    rounds: d.rounds,
    presenter: d.presenter,
    consensus: d.consensus,
    turns: Array.isArray(d.turns) ? [...d.turns] : [],
    finalAnswerMode: d.finalAnswerMode,
    judgeModel: d.judgeModel
  };
  try {
    while (copy.turns.length > 0 && JSON.stringify(copy).length > 150_000) {
      copy.turns.shift();
    }
  } catch {
    copy.turns = [];
  }
  return copy;
}

/** Warn about unsaveable history only once per session */
let historyQuotaWarned = false;

function setHistoryQuotaWarned(v) { historyQuotaWarned = v; return v; }

export { ensureMsgTokens, estimateMessagesTokens, historyQuotaWarned, pushHistoryMessage, scheduleHistorySave, truncateDebateRecord, setHistoryQuotaWarned };
