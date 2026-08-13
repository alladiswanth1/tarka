import { scheduleContextDetect, updateContextUI } from './context.js';
import { saveDebateSettings } from './debate/settings.js';
import { getActiveProvider, localAgentId } from './providers.js';
import { updateTopbar } from './ui/providers.js';
import { flashStatus } from './ui/transcript.js';
import { $ } from './state.js';

// ========== Config helpers ==========
function getConfig() {
  const provider = getActiveProvider();
  return {
    baseURL: (provider.baseURL || '').trim(),
    apiKey: (provider.apiKey || '').trim(),
    providerId: provider.id,
    providerName: provider.name,
    model: $('#model').value.trim() || 'moonshotai/kimi-k3',
    reasoningEffort: $('#reasoningEffort').value,
    // temperature 0 is valid — avoid `|| 0.7` which would coerce 0 → 0.7
    temperature: (() => {
      const t = parseFloat($('#temperature').value);
      return Number.isFinite(t) ? t : 0.7;
    })(),
    maxTokens: $('#maxTokens').value ? parseInt($('#maxTokens').value, 10) : undefined,
    contextLimit: $('#contextLimit').value ? parseInt($('#contextLimit').value, 10) : undefined,
    systemPrompt: $('#systemPrompt').value,
    agent: localAgentId(provider) || undefined
  };
}

function loadConfig() {
  try {
    const raw = localStorage.getItem('customChatConfig');
    if (!raw) return;
    const cfg = JSON.parse(raw);
    // baseURL/apiKey now live in provider profiles (legacy fields kept as backup)
    if (cfg.model) $('#model').value = cfg.model;
    if (cfg.reasoningEffort) $('#reasoningEffort').value = cfg.reasoningEffort;
    if (cfg.temperature != null) $('#temperature').value = cfg.temperature;
    if (cfg.maxTokens) $('#maxTokens').value = cfg.maxTokens;
    if (cfg.contextLimit) $('#contextLimit').value = cfg.contextLimit;
    if (cfg.systemPrompt != null) $('#systemPrompt').value = cfg.systemPrompt;
  } catch (e) {
    console.warn('Failed to load config', e);
  }
}

function writeConfigToStorage() {
  const cfg = getConfig();
  // Merge over the stored object so the legacy baseURL/apiKey backup fields
  // survive; only the global (provider-independent) settings are written.
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('customChatConfig') || '{}') || {};
  } catch {
    stored = {};
  }
  try {
    localStorage.setItem(
      'customChatConfig',
      JSON.stringify({
        ...stored,
        model: cfg.model,
        reasoningEffort: cfg.reasoningEffort,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens ?? null,
        contextLimit: cfg.contextLimit ?? null,
        systemPrompt: cfg.systemPrompt
      })
    );
  } catch {
    /* quota */
  }
}

/** Silent autosave: every settings edit survives a reload without "Save Config" */
let configSaveTimer = null;

function scheduleConfigAutosave() {
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => {
    writeConfigToStorage();
    saveDebateSettings();
  }, 600);
}

function saveConfig() {
  clearTimeout(configSaveTimer);
  writeConfigToStorage();
  updateTopbar();
  updateContextUI();
  saveDebateSettings(); // immediate flush (edits also autosave, debounced)
  flashStatus('Config saved ✓');
  scheduleContextDetect();
}

/** Normalize a favorite entry to { id, providerId } */

export { configSaveTimer, getConfig, loadConfig, saveConfig, scheduleConfigAutosave, writeConfigToStorage };
