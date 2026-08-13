/*
 * This module imports NOTHING. It is the bottom of the dependency graph, and
 * it must stay there: it declares `$` and the DOM refs that half the app reads
 * at module scope, so any import here can put state.js *after* one of its own
 * consumers in the evaluation order and turn `$` into a
 * "Cannot access '$' before initialization" TDZ error at load time.
 */

/** Shorthand for document.querySelector — used across every UI module. */
const $ = (sel) => document.querySelector(sel);

// ========== State ==========
let messages = []; // { role, content }

let isStreaming = false;
/** @type {{ id: string, providerId: string }[]} providerId '' = any provider */
let savedModels = [];
/** @type {{ id: string, providerId: string, at: number }[]} last 8 successful completions */
let recentModels = [];
/** In-memory + localStorage catalog: { [providerId]: { models: {id, context}[], at: number, failed?: boolean } } */
let modelCatalogCache = {};
/** In-flight catalog fetches: { [providerId]: Promise } */
let modelCatalogInflight = {};

const CATALOG_TTL_MS = 60 * 60 * 1000;
/** Failed catalog fetches retry much sooner than successful ones (1h vs 60s) */
const CATALOG_FAIL_TTL_MS = 60 * 1000;

const RECENT_MODELS_KEY = 'customChatRecentModels';

const CATALOG_KEY = 'customChatModelCatalog';

const TEAMS_KEY = 'customChatDebateTeams';
/** @type {{ id: string, name: string, experts: any[], maxRounds: number, expertReasoning: string, finalAnswerMode: string, judge: object, at: number }[]} */
let debateTeams = [];
/** '' = Custom (unsaved lineup) */
let activeTeamId = '';

let abortController = null;
/** Bumped on New Chat so in-flight sendMessage handlers ignore stale sessions */
let chatSession = 0;
/** @type {{ limit: number, source: string, model: string } | null} */
let resolvedContext = null;
/** last measured prompt tokens from provider usage (calibrates estimates) */
let lastPromptTokens = null;

let lastCompletionTokens = null;
/** { ms, tps } of the last completed generation (real usage preferred) */
let lastGenStats = null;
/** Chain-of-thought duration of the last reply (Session pane) */
let lastThinkMs = null;

let contextDetectTimer = null;

let providerContextCache = {}; // modelId -> { limit, at }
/** In-flight detect record { key: `${providerId}::${modelId}`, promise } */
let detectContextInflight = null;

let historySaveTimer = null;

const HISTORY_KEY = 'customChatHistory';

const HISTORY_MAX = 200;

const messagesEl = $('#messages');

const userInput = $('#userInput');

const sendBtn = $('#sendBtn');

const statusText = $('#statusText');

const tokenInfo = $('#tokenInfo');

const sidebar = $('#sidebar');

const sidebarScrim = $('#sidebarScrim');

// ========== Motion / device helpers ==========
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Matches the CSS breakpoint where the drawer becomes an overlay (needs the scrim)
const mobileMq = window.matchMedia('(max-width: 900px)');

const finePointerMq = window.matchMedia('(hover: hover) and (pointer: fine)');

const supportsInterpolateSize =
  typeof CSS !== 'undefined' && CSS.supports && CSS.supports('interpolate-size', 'allow-keywords');

const DEFAULT_MODELS = [
  'moonshotai/kimi-k3',
  'deepseek/deepseek-r1',
  'openai/gpt-5',
  'anthropic/claude-sonnet-4-5',
  'x-ai/grok-4',
  'google/gemini-2.5-flash'
];

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function setMessages(v) { messages = v; return v; }
function setHistorySaveTimer(v) { historySaveTimer = v; return v; }
function setLastPromptTokens(v) { lastPromptTokens = v; return v; }
function setLastCompletionTokens(v) { lastCompletionTokens = v; return v; }
function setLastGenStats(v) { lastGenStats = v; return v; }
function setAbortController(v) { abortController = v; return v; }
function setChatSession(v) { chatSession = v; return v; }
function setProviderContextCache(v) { providerContextCache = v; return v; }
function setResolvedContext(v) { resolvedContext = v; return v; }
function setDetectContextInflight(v) { detectContextInflight = v; return v; }
function setContextDetectTimer(v) { contextDetectTimer = v; return v; }
function setSavedModels(v) { savedModels = v; return v; }
function setRecentModels(v) { recentModels = v; return v; }
function setModelCatalogCache(v) { modelCatalogCache = v; return v; }
function setIsStreaming(v) { isStreaming = v; return v; }
function setActiveTeamId(v) { activeTeamId = v; return v; }
function setDebateTeams(v) { debateTeams = v; return v; }
function setLastThinkMs(v) { lastThinkMs = v; return v; }

export { $, CATALOG_FAIL_TTL_MS, CATALOG_KEY, CATALOG_TTL_MS, DEFAULT_MODELS, HISTORY_KEY, HISTORY_MAX, RECENT_MODELS_KEY, TEAMS_KEY, abortController, activeTeamId, chatSession, contextDetectTimer, copyText, debateTeams, detectContextInflight, finePointerMq, historySaveTimer, isStreaming, lastCompletionTokens, lastGenStats, lastPromptTokens, lastThinkMs, messages, messagesEl, mobileMq, modelCatalogCache, modelCatalogInflight, prefersReducedMotion, providerContextCache, recentModels, resolvedContext, savedModels, sendBtn, setAbortController, setActiveTeamId, setChatSession, setContextDetectTimer, setDebateTeams, setDetectContextInflight, setHistorySaveTimer, setIsStreaming, setLastCompletionTokens, setLastGenStats, setLastPromptTokens, setLastThinkMs, setMessages, setModelCatalogCache, setProviderContextCache, setRecentModels, setResolvedContext, setSavedModels, sidebar, sidebarScrim, statusText, supportsInterpolateSize, tokenInfo, userInput };
