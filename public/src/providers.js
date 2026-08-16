// ========== Provider profiles ==========
import { modelIdsRelated } from './modelId.js';

const PROVIDERS_KEY = 'customChatProviders';

const ACTIVE_PROVIDER_KEY = 'customChatActiveProvider';

/**
 * { id, name, baseURL, apiKey, models: [{ id, context }] }
 *
 * `models` is the OpenClaw-style custom-provider declaration: gateways in the
 * one-api family publish no context fields in /models, so the profile itself
 * can state each model's window. A declared window outranks everything except
 * the global manual override — the user's word beats the gateway's silence.
 */
let providers = [];

let activeProviderId = '';

function newProviderId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** "https://api.tokenrouter.com/v1" → "tokenrouter.com" */
function providerHostname(baseURL) {
  try {
    return new URL(baseURL).hostname.replace(/^api\./, '');
  } catch {
    return String(baseURL || '').replace(/^https?:\/\//, '').split('/')[0];
  }
}

/** Normalize a declared-models array to [{ id, context }] with sane values. */
function normalizeDeclaredModels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    const id = String(m?.id || '').trim();
    const context = Math.round(Number(m?.context));
    if (!id || !(context >= 1024) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push({ id, context });
  }
  return out.slice(0, 200);
}

/**
 * Parse the editor's declared-models text: one model per line,
 *   openai:gpt-5 = 400k        moonshotai/kimi-k3 128000
 * The size is the LAST token ("=" optional) so ids may contain ":" and "/".
 * Suffixes: k = ×1000, m = ×1000000. Lines starting with # are comments;
 * unparseable lines are skipped rather than fatal.
 */
function parseDeclaredModels(text) {
  const out = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.*?)[\s=]+(\d+(?:\.\d+)?)([km])?\s*$/i);
    if (!m) continue;
    const id = m[1].replace(/[\s=]+$/, '').trim();
    if (!id) continue;
    const mult = m[3] ? (m[3].toLowerCase() === 'm' ? 1_000_000 : 1000) : 1;
    out.push({ id, context: Math.round(parseFloat(m[2]) * mult) });
  }
  return normalizeDeclaredModels(out);
}

/** Render declared models back into the editor's line format. */
function formatDeclaredModels(models) {
  return normalizeDeclaredModels(models)
    .map(({ id, context }) => {
      const size =
        context % 1_000_000 === 0
          ? context / 1_000_000 + 'M'
          : context % 1000 === 0
            ? context / 1000 + 'k'
            : String(context);
      return `${id} = ${size}`;
    })
    .join('\n');
}

/**
 * Window the user declared for this provider+model, or 0.
 * Exact id match wins; otherwise the same segment-aware equivalence the rest
 * of the app uses ("gpt-4o" ↔ "openai:gpt-4o" ↔ "openai/gpt-4o").
 */
function declaredContextFor(providerId, modelId) {
  const p = providers.find((x) => x.id === providerId);
  if (!p || !Array.isArray(p.models) || !p.models.length) return 0;
  const want = String(modelId || '').trim().toLowerCase();
  if (!want) return 0;
  const exact = p.models.find((m) => m.id.toLowerCase() === want);
  if (exact) return exact.context;
  const related = p.models.find((m) => modelIdsRelated(m.id, modelId));
  return related ? related.context : 0;
}

function saveProviders() {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
    localStorage.setItem(ACTIVE_PROVIDER_KEY, activeProviderId);
  } catch {
    /* quota */
  }
}

function loadProviders() {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      providers = (Array.isArray(arr) ? arr : [])
        .filter((p) => p && p.id)
        .map((p) => {
          const agent = isKnownLocalAgent(p.agent) ? p.agent : localAgentFromBaseURL(p.baseURL);
          const isLocal = isKnownLocalAgent(agent);
          return {
            id: String(p.id),
            name: String(p.name || ''),
            baseURL: String(p.baseURL || ''),
            apiKey: String(p.apiKey || ''),
            models: normalizeDeclaredModels(p.models),
            kind: isLocal ? 'local' : '',
            agent: isLocal ? agent : '',
            // Fail closed: a saved ready flag is not proof. Detect re-confirms.
            ready: isLocal ? false : true,
            version: String(p.version || '')
          };
        });
      activeProviderId = localStorage.getItem(ACTIVE_PROVIDER_KEY) || '';
      if (!providers.some((p) => p.id === activeProviderId)) {
        activeProviderId = providers.length ? providers[0].id : '';
      }
      return;
    }
  } catch {
    /* corrupted — fall through to migration */
  }

  // Migration: no provider store yet — build provider #1 from the legacy
  // single-config keys. The legacy keys are left in place as a backup.
  providers = [];
  activeProviderId = '';
  try {
    const legacy = JSON.parse(localStorage.getItem('customChatConfig') || 'null');
    if (legacy && (legacy.baseURL || legacy.apiKey)) {
      const p = {
        id: newProviderId(),
        name: providerHostname(legacy.baseURL) || 'Provider 1',
        baseURL: legacy.baseURL || '',
        apiKey: legacy.apiKey || ''
      };
      providers = [p];
      activeProviderId = p.id;
      saveProviders();
    }
  } catch {
    /* no legacy config */
  }
}

/** Active profile; falls back to first, then to a blank unsaved one */
function getActiveProvider() {
  return (
    providers.find((p) => p.id === activeProviderId) ||
    providers[0] || { id: '', name: '', baseURL: '', apiKey: '', models: [] }
  );
}

const KNOWN_LOCAL_AGENTS = ['claude', 'codex', 'grok'];

function isKnownLocalAgent(id) {
  return KNOWN_LOCAL_AGENTS.includes(String(id || '').trim().toLowerCase());
}

function localAgentFromBaseURL(baseURL) {
  const base = String(baseURL || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
  const m = /^tarka-local:\/\/([a-z0-9-]+)$/.exec(base);
  return m && isKnownLocalAgent(m[1]) ? m[1] : null;
}

function localAgentId(p) {
  if (!p) return null;
  if (isKnownLocalAgent(p.agent)) return String(p.agent).trim().toLowerCase();
  return localAgentFromBaseURL(p.baseURL);
}

/** Only a real Claude/Codex profile — `kind: 'local'` on a remote URL is not enough. */
function isLocalProvider(p) {
  return localAgentId(p) != null;
}

/** Detect must have confirmed sign-in this session. Missing/undefined ready is not ready. */
function localProfileReady(p) {
  return isLocalProvider(p) && p.ready === true;
}

function localProviderNeedsKey(p) {
  return !isLocalProvider(p);
}

/** Null when the profile can send; otherwise a setup error for Solo/Debate/Project. */
function providerAccessIssue(p, label) {
  const who = label || 'this seat';
  if (!p) return `${who} has no provider selected.`;
  if (isLocalProvider(p)) {
    if (!localProfileReady(p)) {
      return `${who}'s ${p.name || 'local CLI'} is not signed in on this machine.`;
    }
    return null;
  }
  if (!(p.apiKey || '').trim()) return `${who}'s provider “${p.name}” has no API key.`;
  return null;
}

function setActiveProviderId(v) { activeProviderId = v; return v; }
function setProviders(v) { providers = v; return v; }

export { ACTIVE_PROVIDER_KEY, KNOWN_LOCAL_AGENTS, PROVIDERS_KEY, activeProviderId, declaredContextFor, formatDeclaredModels, getActiveProvider, isKnownLocalAgent, isLocalProvider, loadProviders, localAgentFromBaseURL, localAgentId, localProfileReady, localProviderNeedsKey, newProviderId, normalizeDeclaredModels, parseDeclaredModels, providerAccessIssue, providerHostname, providers, saveProviders, setActiveProviderId, setProviders };
