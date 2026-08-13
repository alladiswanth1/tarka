import { DEBATE_MAX_SEATS } from '../debate/protocol.js';
import { renderDebateSeats, updateDebateCostHint, updateJudgeRowVisibility } from '../debate/ui.js';
import { updateDebateToggleUi } from '../project/state.js';
import { $, TEAMS_KEY, activeTeamId, debateTeams, setActiveTeamId, setDebateTeams } from '../state.js';
import { flashStatus } from '../ui/transcript.js';

// ========== DEBATE MODE — settings ==========
const DEBATE_KEY = 'customChatDebate';

const DEBATE_DEFAULT_EXPERTS = [
  {
    name: 'Nova',
    persona: 'Visionary: generates ideas, possibilities, ambitious plans, explores multiple directions.'
  },
  {
    name: 'Kai',
    persona: 'Skeptic: stress-tests everything, finds flaws, edge cases, risks, and pushes for rigor.'
  },
  {
    name: 'Rhea',
    persona: 'Pragmatist: focuses on execution, feasibility, concrete steps, and what actually ships.'
  }
];

function defaultDebateSettings() {
  return {
    enabled: false,
    // model '' = empty (required choice); providerId '' resolved at validate/render time
    experts: DEBATE_DEFAULT_EXPERTS.map((e) => ({ ...e, model: '', providerId: '' })),
    maxRounds: 4,
    // Elite by default: experts think at the global reasoning effort, like the
    // final answer. 'off' remains available as an explicit economy choice.
    expertReasoning: 'inherit',
    // 'nominated' = team picks presenter (legacy default); 'judge' = neutral judge
    finalAnswerMode: 'nominated',
    judge: { model: '', providerId: '' }
  };
}

let debateSettings = defaultDebateSettings();

function loadDebateSettings() {
  try {
    const raw = localStorage.getItem(DEBATE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const base = defaultDebateSettings();
      debateSettings = {
        enabled: !!d.enabled,
        experts: (Array.isArray(d.experts) ? d.experts : base.experts)
          .slice(0, DEBATE_MAX_SEATS)
          .map((e, i) => ({
            name: String(e?.name || `Expert ${i + 1}`).slice(0, 40),
            persona: String(e?.persona || ''),
            model: String(e?.model || ''),
            providerId: String(e?.providerId || '')
          })),
        maxRounds: Math.min(8, Math.max(1, parseInt(d.maxRounds, 10) || 4)),
        expertReasoning: d.expertReasoning === 'off' ? 'off' : 'inherit',
        finalAnswerMode: d.finalAnswerMode === 'judge' ? 'judge' : 'nominated',
        judge: {
          model: String(d.judge?.model || ''),
          providerId: String(d.judge?.providerId || '')
        }
      };
      if (debateSettings.experts.length < 2) debateSettings.experts = base.experts;
    }
  } catch {
    debateSettings = defaultDebateSettings();
  }
  loadDebateTeams();
  // One-time elite-effort migration: settings saved before the default flip
  // carried 'off' without the user ever choosing it — upgrade them once.
  // An 'off' picked AFTER this migration is an explicit choice and sticks.
  try {
    if (localStorage.getItem('customChatEffortV2') !== '1') {
      debateSettings.expertReasoning = 'inherit';
      debateTeams.forEach((t) => {
        t.expertReasoning = 'inherit';
      });
      saveDebateSettings();
      saveDebateTeams();
      localStorage.setItem('customChatEffortV2', '1');
    }
  } catch {
    /* storage unavailable */
  }
}

function saveDebateSettings() {
  try {
    localStorage.setItem(DEBATE_KEY, JSON.stringify(debateSettings));
  } catch {
    /* quota */
  }
}

/** Debounced persistence so every seat edit survives a reload without "Save Config" */
let debateSaveTimer = null;

function scheduleDebateSave() {
  clearTimeout(debateSaveTimer);
  debateSaveTimer = setTimeout(saveDebateSettings, 400);
}

/** Any manual edit of the lineup → select flips to "Custom" (don't mutate saved teams) */
function markDebateCustom() {
  if (activeTeamId) {
    setActiveTeamId('');
    updateDebateTeamsUi();
  }
  scheduleDebateSave();
}

function loadDebateTeams() {
  try {
    const raw = JSON.parse(localStorage.getItem(TEAMS_KEY) || '[]');
    setDebateTeams((Array.isArray(raw) ? raw : [])
      .filter((t) => t && t.id && t.name)
      .slice(0, 12)
      .map((t) => ({
        id: String(t.id),
        name: String(t.name).slice(0, 40),
        experts: Array.isArray(t.experts) ? t.experts : [],
        maxRounds: Math.min(8, Math.max(1, parseInt(t.maxRounds, 10) || 4)),
        expertReasoning: t.expertReasoning === 'off' ? 'off' : 'inherit',
        finalAnswerMode: t.finalAnswerMode === 'judge' ? 'judge' : 'nominated',
        judge: {
          model: String(t.judge?.model || ''),
          providerId: String(t.judge?.providerId || '')
        },
        at: Number(t.at) || 0
      })));
  } catch {
    setDebateTeams([]);
  }
}

function saveDebateTeams() {
  try {
    localStorage.setItem(TEAMS_KEY, JSON.stringify(debateTeams.slice(0, 12)));
  } catch {
    /* quota */
  }
}

function snapshotDebateTeamConfig() {
  return {
    experts: debateSettings.experts.map((e) => ({
      name: e.name,
      persona: e.persona,
      model: e.model,
      providerId: e.providerId
    })),
    maxRounds: debateSettings.maxRounds,
    expertReasoning: debateSettings.expertReasoning,
    finalAnswerMode: debateSettings.finalAnswerMode === 'judge' ? 'judge' : 'nominated',
    judge: {
      model: debateSettings.judge?.model || '',
      providerId: debateSettings.judge?.providerId || ''
    }
  };
}

function applyDebateTeamConfig(cfg, { enable = false } = {}) {
  const base = defaultDebateSettings();
  debateSettings.experts = (Array.isArray(cfg.experts) ? cfg.experts : base.experts)
    .slice(0, DEBATE_MAX_SEATS)
    .map((e, i) => ({
      name: String(e?.name || `Expert ${i + 1}`).slice(0, 40),
      persona: String(e?.persona || ''),
      model: String(e?.model || ''),
      providerId: String(e?.providerId || '')
    }));
  if (debateSettings.experts.length < 2) {
    debateSettings.experts = base.experts.map((e) => ({ ...e }));
  }
  debateSettings.maxRounds = Math.min(8, Math.max(1, parseInt(cfg.maxRounds, 10) || 4));
  debateSettings.expertReasoning = cfg.expertReasoning === 'off' ? 'off' : 'inherit';
  debateSettings.finalAnswerMode = cfg.finalAnswerMode === 'judge' ? 'judge' : 'nominated';
  debateSettings.judge = {
    model: String(cfg.judge?.model || ''),
    providerId: String(cfg.judge?.providerId || '')
  };
  if (enable) debateSettings.enabled = true;
  saveDebateSettings();
  renderDebateSeats();
  updateDebateToggleUi();
  updateDebateCostHint();
  updateDebateTeamsUi();
  updateJudgeRowVisibility();
}

function loadDebateTeamById(id, { enable = false } = {}) {
  const t = debateTeams.find((x) => x.id === id);
  if (!t) return false;
  setActiveTeamId(t.id);
  applyDebateTeamConfig(t, { enable });
  flashStatus(`Team → ${t.name}`);
  return true;
}

function updateDebateTeamsUi() {
  const sel = $('#debateTeamSelect');
  if (!sel) return;
  const prev = activeTeamId;
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Custom';
  sel.appendChild(opt0);
  debateTeams.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  sel.value = debateTeams.some((t) => t.id === prev) ? prev : '';
  setActiveTeamId(sel.value);
  const del = $('#debateTeamDelete');
  if (del) del.hidden = !activeTeamId;
}

function newTeamId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export { DEBATE_DEFAULT_EXPERTS, DEBATE_KEY, applyDebateTeamConfig, debateSaveTimer, debateSettings, defaultDebateSettings, loadDebateSettings, loadDebateTeamById, loadDebateTeams, markDebateCustom, newTeamId, saveDebateSettings, saveDebateTeams, scheduleDebateSave, snapshotDebateTeamConfig, updateDebateTeamsUi };
