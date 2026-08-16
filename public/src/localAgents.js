/**
 * Detect Claude Code / Codex / Grok Build CLIs on this machine and expose
 * them as ordinary Tarka providers (same list Solo, Debate, and Project
 * already pick from).
 */
import { activeProviderId, isKnownLocalAgent, providers, saveProviders, setActiveProviderId } from './providers.js';
import { $ } from './state.js';
import { setActiveProvider, setLocalAgentStripRefresh } from './ui/providers.js';

const LOCAL_PROVIDER_ID = { claude: 'local-claude', codex: 'local-codex', grok: 'local-grok' };

const LOCAL_LOGIN_HINT = {
  claude: 'claude login',
  codex: 'codex login',
  grok: 'grok login'
};

const DEFAULT_LOCAL_MODELS = {
  claude: [
    { id: 'default', context: 200000 },
    { id: 'opus', context: 200000 },
    { id: 'sonnet', context: 200000 },
    { id: 'haiku', context: 200000 }
  ],
  codex: [
    { id: 'default', context: 200000 },
    { id: 'gpt-5', context: 200000 },
    { id: 'o3', context: 200000 },
    { id: 'o4-mini', context: 200000 }
  ],
  grok: [
    { id: 'default', context: 256000 },
    { id: 'grok-build', context: 256000 },
    { id: 'grok-4.5', context: 256000 },
    { id: 'grok-4', context: 256000 }
  ]
};

let lastLocalAgents = [];

function makeLocalProvider(agent) {
  return {
    id: LOCAL_PROVIDER_ID[agent.id] || `local-${agent.id}`,
    kind: 'local',
    agent: agent.id,
    name: agent.label,
    baseURL: `tarka-local://${agent.id}`,
    apiKey: 'local-cli',
    models: Array.isArray(agent.models) && agent.models.length ? agent.models : DEFAULT_LOCAL_MODELS[agent.id] || [],
    ready: !!agent.ready,
    installed: !!agent.installed,
    authed: !!agent.authed,
    version: agent.version || ''
  };
}

async function fetchLocalAgents() {
  const res = await fetch('/api/agents/local');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return Array.isArray(data.agents) ? data.agents : [];
}

/**
 * Merge detected CLIs into the provider list. Ready agents become selectable
 * backends; missing ones stay listed (if already saved) but marked not ready.
 */
async function syncLocalAgentProviders() {
  let agents = [];
  try {
    agents = await fetchLocalAgents();
  } catch {
    return [];
  }
  let changed = false;
  for (const a of agents) {
    if (!isKnownLocalAgent(a.id)) continue;
    const id = LOCAL_PROVIDER_ID[a.id];
    const existing = providers.find((p) => p.id === id || p.agent === a.id);
    if (a.ready) {
      if (!existing) {
        providers.push(makeLocalProvider(a));
        changed = true;
      } else {
        existing.kind = 'local';
        existing.agent = a.id;
        existing.baseURL = `tarka-local://${a.id}`;
        if (!existing.apiKey) existing.apiKey = 'local-cli';
        existing.ready = true;
        existing.installed = true;
        existing.authed = true;
        existing.version = a.version || existing.version || '';
        if (!existing.models || !existing.models.length) {
          existing.models = DEFAULT_LOCAL_MODELS[a.id] || [];
        }
        changed = true;
      }
    } else if (existing) {
      existing.kind = 'local';
      existing.agent = a.id;
      existing.ready = false;
      existing.installed = !!a.installed;
      existing.authed = !!a.authed;
      existing.version = a.version || existing.version || '';
      changed = true;
    } else if (a.installed || a.authed) {
      // Visible but not selectable until signed in — so the API panel can say why.
      const stub = makeLocalProvider(a);
      stub.ready = false;
      stub.apiKey = '';
      providers.push(stub);
      changed = true;
    }
  }
  if (changed) {
    if (!activeProviderId && providers.some((p) => p.ready !== false)) {
      const first = providers.find((p) => p.ready !== false) || providers[0];
      if (first) setActiveProviderId(first.id);
    }
    saveProviders();
  }
  renderLocalAgentStrip(agents);
  return agents;
}

function renderLocalAgentStrip(agents) {
  if (Array.isArray(agents)) lastLocalAgents = agents;
  const list = Array.isArray(agents) ? agents : lastLocalAgents;
  const ul = $('#localAgentList');
  if (!ul) return;
  ul.innerHTML = '';
  if (!list.length) {
    ul.hidden = true;
    return;
  }
  ul.hidden = false;
  for (const a of list) {
    const id = LOCAL_PROVIDER_ID[a.id];
    const isActive = !!(id && id === activeProviderId);
    const li = document.createElement('li');
    li.className =
      'local-agent-chip' +
      (a.ready ? ' ready' : a.installed ? ' installed' : '') +
      (isActive ? ' active' : '');
    const login = LOCAL_LOGIN_HINT[a.id] || `${a.id} login`;
    const status = a.ready
      ? `signed in${a.version && a.version !== '?' ? ` · ${a.version}` : ''}`
      : a.installed
        ? `installed — run \`${login}\``
        : 'not installed';
    li.innerHTML = `<button type="button" class="local-agent-chip-btn"><span class="local-agent-name"></span><span class="local-agent-meta"></span></button>`;
    li.querySelector('.local-agent-name').textContent = a.label;
    li.querySelector('.local-agent-meta').textContent = status;
    const btn = li.querySelector('.local-agent-chip-btn');
    btn.disabled = !a.ready;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    if (a.ready) {
      btn.addEventListener('click', () => {
        const p = providers.find((x) => x.id === id || x.agent === a.id);
        if (p) setActiveProvider(p.id);
      });
    }
    ul.appendChild(li);
  }
}

setLocalAgentStripRefresh(() => renderLocalAgentStrip());

export {
  DEFAULT_LOCAL_MODELS,
  LOCAL_LOGIN_HINT,
  LOCAL_PROVIDER_ID,
  fetchLocalAgents,
  makeLocalProvider,
  renderLocalAgentStrip,
  syncLocalAgentProviders
};
