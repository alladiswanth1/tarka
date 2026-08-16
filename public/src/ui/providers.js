import { getConfig } from '../config.js';
import { scheduleContextDetect, updateContextUI } from '../context.js';
import { renderDebateSeats } from '../debate/ui.js';
import { updateModelWarnings } from '../models.js';
import { updateModeStrip } from '../project/state.js';
import { activeProviderId, formatDeclaredModels, getActiveProvider, isLocalProvider, newProviderId, parseDeclaredModels, providerHostname, providers, saveProviders, setActiveProviderId, setProviders } from '../providers.js';

/** Filled by localAgents.js — keeps the chip strip in sync without a cycle. */
let refreshLocalAgentStrip = () => {};
function setLocalAgentStripRefresh(fn) {
  refreshLocalAgentStrip = typeof fn === 'function' ? fn : () => {};
}
import { $, prefersReducedMotion, setDetectContextInflight } from '../state.js';
import { setSidebarPanel } from '../ui/sidebar.js';
import { flashStatus } from '../ui/transcript.js';

// ========== Provider UI ==========
/** Provider id being edited; null while adding a new one */
let editingProviderId = null;

function maskedKeyLabel(key) {
  const k = (key || '').trim();
  return k ? '•••' + k.slice(-4) : 'no key';
}

function renderProviders() {
  const ul = $('#providerList');
  if (!ul) return;
  ul.innerHTML = '';
  if (!providers.length) {
    const li = document.createElement('li');
    li.className = 'provider-empty';
    li.textContent = 'Add a provider to start';
    ul.appendChild(li);
    return;
  }
  providers.forEach((p) => {
    const li = document.createElement('li');
    li.className =
      'provider-row' +
      (p.id === activeProviderId ? ' active' : '') +
      (isLocalProvider(p) ? ' local-cli' : '') +
      (isLocalProvider(p) && p.ready === false ? ' not-ready' : '');
    li.dataset.id = p.id;
    li.innerHTML =
      `<button type="button" class="provider-row-main" title="Use this provider">` +
      `<span class="provider-name"></span>` +
      `<span class="provider-meta"></span>` +
      `</button>` +
      `<button type="button" class="icon-btn small provider-edit" title="Edit provider" aria-label="Edit provider">✎</button>`;
    const host = isLocalProvider(p)
      ? p.ready === false
        ? 'local CLI · not signed in'
        : `local CLI${p.version && p.version !== '?' ? ` · ${p.version}` : ''}`
      : providerHostname(p.baseURL) || 'no URL';
    li.querySelector('.provider-name').textContent = p.name || host;
    li.querySelector('.provider-meta').textContent = isLocalProvider(p)
      ? host
      : `${host} · ${maskedKeyLabel(p.apiKey)}`;
    li.querySelector('.provider-row-main').addEventListener('click', () => setActiveProvider(p.id));
    li.querySelector('.provider-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openProviderEditor(p.id);
    });
    ul.appendChild(li);
  });
  // Seat provider <select>s mirror the profile list (shown only with 2+ providers)
  renderDebateSeats();
}

function setActiveProvider(id) {
  if (id === activeProviderId || !providers.some((p) => p.id === id)) return;
  setActiveProviderId(id);
  saveProviders();
  setDetectContextInflight(null); // never reuse the previous provider's probe
  renderProviders();
  updateTopbar(); // refreshes chips + context badge/meter
  scheduleContextDetect();
  // Main model picker re-scopes favorites/catalog to the new active provider
  const mainModel = $('#model');
  if (mainModel && mainModel._modelPickerRefresh) mainModel._modelPickerRefresh();
  updateModelWarnings();
  refreshLocalAgentStrip();
  flashStatus(`Provider → ${getActiveProvider().name}`);
}

function openProviderEditor(id = null) {
  editingProviderId = id;
  const p = id ? providers.find((x) => x.id === id) : null;
  setSidebarPanel('api');
  $('#provName').value = p ? p.name : '';
  $('#provBaseURL').value = p ? p.baseURL : '';
  $('#provApiKey').value = p && isLocalProvider(p) ? '' : p ? p.apiKey : '';
  $('#provApiKey').type = 'password';
  const modelsBox = $('#provModels');
  if (modelsBox) modelsBox.value = p ? formatDeclaredModels(p.models) : '';
  const local = !!(p && isLocalProvider(p));
  if ($('#provBaseURL')) $('#provBaseURL').disabled = local;
  if ($('#provApiKey')) $('#provApiKey').disabled = local;
  const note = $('#provLocalNote');
  if (note) {
    note.hidden = !local;
    note.textContent = local
      ? `${p.name} uses the CLI already signed in on this machine — no API key.`
      : '';
  }
  $('#provDelete').hidden = !p;
  $('#providerEditor')?.classList.add('open');
  $('#addProviderBtn')?.setAttribute('aria-expanded', 'true');
  const editor = $('#providerEditor');
  if (editor) editor.inert = false;
  // Focus once the drawer has expanded
  setTimeout(() => $('#provName')?.focus(), prefersReducedMotion.matches ? 0 : 200);
}

function closeProviderEditor() {
  editingProviderId = null;
  if ($('#provBaseURL')) $('#provBaseURL').disabled = false;
  if ($('#provApiKey')) $('#provApiKey').disabled = false;
  const note = $('#provLocalNote');
  if (note) {
    note.hidden = true;
    note.textContent = '';
  }
  const editor = $('#providerEditor');
  if (editor) {
    editor.classList.remove('open');
    editor.inert = true;
  }
  $('#addProviderBtn')?.setAttribute('aria-expanded', 'false');
}

function saveProviderFromEditor() {
  const existing = editingProviderId ? providers.find((x) => x.id === editingProviderId) : null;
  if (existing && isLocalProvider(existing)) {
    const name = $('#provName').value.trim() || existing.name;
    existing.name = name;
    saveProviders();
    closeProviderEditor();
    renderProviders();
    updateTopbar();
    flashStatus('Provider saved ✓');
    return;
  }
  const name = $('#provName').value.trim();
  const baseURL = $('#provBaseURL').value.trim();
  const apiKey = $('#provApiKey').value.trim();
  if (!baseURL) {
    flashStatus('Base URL is required');
    $('#provBaseURL').focus();
    return;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(baseURL);
  } catch {
    flashStatus('Base URL is invalid — e.g. https://api.openai.com/v1');
    $('#provBaseURL').focus();
    return;
  }
  const finalName = name || providerHostname(baseURL) || 'Provider';
  // Declared models: the profile's own statement of each model's context
  // window, for gateways whose /models publishes none (see providers.js)
  const declared = parseDeclaredModels($('#provModels')?.value || '');
  if (editingProviderId) {
    const p = providers.find((x) => x.id === editingProviderId);
    if (p) {
      p.name = finalName;
      p.baseURL = baseURL;
      p.apiKey = apiKey;
      p.models = declared;
    }
  } else {
    const p = { id: newProviderId(), name: finalName, baseURL, apiKey, models: declared };
    providers.push(p);
    setActiveProviderId(p.id); // a newly added provider becomes active
  }
  saveProviders();
  setDetectContextInflight(null);
  closeProviderEditor();
  renderProviders();
  updateTopbar();
  scheduleContextDetect();
  flashStatus('Provider saved ✓');
}

function deleteProviderFromEditor() {
  if (!editingProviderId) return;
  const p = providers.find((x) => x.id === editingProviderId);
  if (!p) return;
  if (!confirm(`Delete provider “${p.name}”?`)) return;
  setProviders(providers.filter((x) => x.id !== editingProviderId));
  if (activeProviderId === p.id) {
    setActiveProviderId(providers.length ? providers[0].id : '');
  }
  saveProviders();
  setDetectContextInflight(null);
  closeProviderEditor();
  renderProviders();
  updateTopbar();
  scheduleContextDetect();
  flashStatus('Provider deleted');
}

/** Crossfade a topbar chip's text (old slides up out, new slides in) */
function swapChipText(chip, next, { animate = true } = {}) {
  if (!chip) return;
  let txt = chip.querySelector('.chip-text');
  if (!txt) {
    chip.textContent = '';
    txt = document.createElement('span');
    txt.className = 'chip-text';
    txt.textContent = next;
    chip.appendChild(txt);
    return;
  }
  if (txt.textContent === next) return;
  if (prefersReducedMotion.matches || !animate) {
    txt.textContent = next;
    return;
  }
  chip.querySelectorAll('.chip-text-out').forEach((n) => n.remove());
  const old = txt.cloneNode(true);
  old.classList.add('chip-text-out');
  chip.appendChild(old);
  old.addEventListener('animationend', () => old.remove(), { once: true });
  setTimeout(() => old.remove(), 400);
  txt.textContent = next;
  txt.classList.remove('chip-text-in');
  void txt.offsetWidth;
  txt.classList.add('chip-text-in');
}

function updateTopbar() {
  const cfg = getConfig();
  const provider = getActiveProvider();
  swapChipText($('#currentProviderLabel'), provider.name || 'No provider');
  // Snap while the user is typing in the model field; animate on discrete picks
  swapChipText($('#currentModelLabel'), cfg.model, {
    animate: document.activeElement !== $('#model')
  });
  const effortMap = {
    none: 'No reasoning',
    low: 'Low reasoning',
    medium: 'Medium reasoning',
    high: 'High reasoning',
    max: 'Max reasoning'
  };
  $('#currentReasoningLabel').textContent = effortMap[cfg.reasoningEffort] || cfg.reasoningEffort;
  if (typeof updateModeStrip === 'function') updateModeStrip();
  updateContextUI();
}

export { closeProviderEditor, deleteProviderFromEditor, editingProviderId, maskedKeyLabel, openProviderEditor, renderProviders, saveProviderFromEditor, setActiveProvider, setLocalAgentStripRefresh, swapChipText, updateTopbar };
