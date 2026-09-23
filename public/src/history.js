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
const DEBATE_RECORD_CAP = 150_000;
function truncateDebateRecord(d) {
  // Every field restoreDebateArena reads must survive: `roster` keeps the
  // original seat indexes and which seats dropped out (the credit list in
  // `experts` is re-based to 0 and omits them), `stopped` keeps the label.
  const copy = {
    experts: d.experts,
    rounds: d.rounds,
    presenter: d.presenter,
    consensus: d.consensus,
    turns: Array.isArray(d.turns) ? [...d.turns] : [],
    finalAnswerMode: d.finalAnswerMode,
    judgeModel: d.judgeModel
  };
  if (d.roster) copy.roster = d.roster;
  if (d.stopped) copy.stopped = true;
  if (d.turnOrder === 'parallel') copy.turnOrder = 'parallel';
  try {
    // Measure once: re-serialising the whole record per dropped turn ran on
    // every debounced save, for every debate in the session.
    const fixed = JSON.stringify({ ...copy, turns: [] }).length;
    const sizes = copy.turns.map((t) => JSON.stringify(t).length + 1);
    let total = fixed + sizes.reduce((a, b) => a + b, 0);
    let drop = 0;
    while (drop < copy.turns.length && total > DEBATE_RECORD_CAP) {
      total -= sizes[drop];
      drop++;
    }
    if (drop) copy.turns = copy.turns.slice(drop);
  } catch {
    copy.turns = [];
  }
  return copy;
}

/** Warn about unsaveable history only once per session */
let historyQuotaWarned = false;

function setHistoryQuotaWarned(v) { historyQuotaWarned = v; return v; }

export { ensureMsgTokens, estimateMessagesTokens, historyQuotaWarned, pushHistoryMessage, scheduleHistorySave, truncateDebateRecord, setHistoryQuotaWarned };
