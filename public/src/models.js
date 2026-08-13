import { ingestModelContexts } from './contextStore.js';
import { modelIdsRelated, modelMatchesCatalog, splitModelId } from './modelId.js';
import { debateSettings } from './debate/settings.js';
import { activeProviderId, getActiveProvider, isLocalProvider, providers } from './providers.js';
import { $, CATALOG_FAIL_TTL_MS, CATALOG_KEY, CATALOG_TTL_MS, DEFAULT_MODELS, RECENT_MODELS_KEY, modelCatalogCache, modelCatalogInflight, recentModels, savedModels, setModelCatalogCache, setRecentModels, setSavedModels } from './state.js';
import { updateTopbar } from './ui/providers.js';

/** Normalize a favorite entry to { id, providerId } */
function normalizeFavorite(m) {
  if (typeof m === 'string') return { id: m, providerId: '' };
  if (m && typeof m === 'object' && m.id) {
    return { id: String(m.id), providerId: String(m.providerId || '') };
  }
  return null;
}

function favoriteId(m) {
  return typeof m === 'string' ? m : m?.id || '';
}

/** Favorites visible for a seat/main picker (specific provider OR any) */
function favoritesForProvider(providerId) {
  const pid = String(providerId || '');
  return savedModels
    .filter((m) => !m.providerId || m.providerId === pid)
    .map((m) => m.id);
}

function recentsForProvider(providerId) {
  const pid = String(providerId || '');
  return recentModels
    .filter((r) => !r.providerId || r.providerId === pid)
    .map((r) => r.id);
}

function rebuildModelDatalist() {
  const list = $('#modelList');
  if (!list) return;
  list.innerHTML = '';
  const ids = [
    ...new Set([
      ...DEFAULT_MODELS,
      ...savedModels.map(favoriteId).filter(Boolean),
      ...recentModels.map((r) => r.id).filter(Boolean)
    ])
  ];
  ids.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    list.appendChild(opt);
  });
}

function loadSavedModels() {
  try {
    const raw = JSON.parse(localStorage.getItem('customChatModels') || '[]');
    let migrated = false;
    setSavedModels((Array.isArray(raw) ? raw : [])
      .map((m) => {
        if (typeof m === 'string') {
          migrated = true;
          return { id: m, providerId: '' };
        }
        return normalizeFavorite(m);
      })
      .filter(Boolean));
    if (migrated) {
      try {
        localStorage.setItem('customChatModels', JSON.stringify(savedModels));
      } catch {
        /* quota */
      }
    }
  } catch (e) {
    setSavedModels([]);
  }
  loadRecentModels();
  loadModelCatalogCache();
  renderSavedModels();
  rebuildModelDatalist();
}

function saveSavedModels() {
  try {
    localStorage.setItem('customChatModels', JSON.stringify(savedModels));
  } catch {
    /* quota / storage disabled — the in-memory list still updates below */
  }
  renderSavedModels();
  rebuildModelDatalist();
}

function loadRecentModels() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) || '[]');
    setRecentModels((Array.isArray(raw) ? raw : [])
      .filter((r) => r && r.id)
      .map((r) => ({
        id: String(r.id),
        providerId: String(r.providerId || ''),
        at: Number(r.at) || 0
      }))
      .slice(0, 8));
  } catch {
    setRecentModels([]);
  }
}

/** Record a successful completion model (streamCompletion callers on success) */
function pushRecentModel(modelId, providerId) {
  const id = String(modelId || '').trim();
  if (!id) return;
  const pid = String(providerId || '');
  setRecentModels(recentModels.filter((r) => !(r.id === id && r.providerId === pid)));
  recentModels.unshift({ id, providerId: pid, at: Date.now() });
  setRecentModels(recentModels.slice(0, 8));
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(recentModels));
  } catch {
    /* quota */
  }
  rebuildModelDatalist();
}

function loadModelCatalogCache() {
  try {
    setModelCatalogCache(JSON.parse(localStorage.getItem(CATALOG_KEY) || '{}') || {});
  } catch {
    setModelCatalogCache({});
  }
  // Re-seed the shared context store from the persisted catalogs, so a reload
  // resolves every seat's window without touching the network. Failed entries
  // keep their last good model list, so they re-seed too.
  for (const [pid, cat] of Object.entries(modelCatalogCache)) {
    if (cat) ingestModelContexts(pid, catalogEntries(cat.models));
  }
}

function saveModelCatalogCache() {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(modelCatalogCache));
  } catch {
    /* quota */
  }
}

/** Catalog entry freshness: successes live CATALOG_TTL_MS, failures 60s */
function isCatalogFresh(cat) {
  if (!cat || !cat.at) return false;
  return Date.now() - cat.at < (cat.failed ? CATALOG_FAIL_TTL_MS : CATALOG_TTL_MS);
}

/**
 * Normalize a cached catalog to `{ id, context }[]`.
 *
 * Older builds stored a bare `string[]`, and entries may still arrive that way
 * from localStorage, so every reader goes through this rather than assuming a
 * shape. Also the single place that knows a context of 0/undefined means
 * "provider did not say", not "zero tokens".
 */
function catalogEntries(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  const seen = new Set();
  for (const m of models) {
    const id = typeof m === 'string' ? m : m && m.id ? String(m.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ctx = typeof m === 'object' && m ? Number(m.context) : NaN;
    out.push({ id, context: Number.isFinite(ctx) && ctx > 0 ? Math.round(ctx) : 0 });
  }
  return out;
}

/** Just the ids, for the picker and the catalog-membership check. */
function catalogIds(models) {
  return catalogEntries(models).map((m) => m.id);
}

/**
 * Record a failed catalog fetch WITHOUT discarding the previous good list.
 * A transient network blip used to wipe the catalog to `[]`, losing the
 * picker's model list (and, on reload, the re-ingest source for every cached
 * window) until the next successful fetch.
 */
function markCatalogFailed(pid) {
  const prev = modelCatalogCache[pid];
  modelCatalogCache[pid] = {
    models: prev && Array.isArray(prev.models) ? prev.models : [],
    at: Date.now(),
    failed: true
  };
  saveModelCatalogCache();
}

/**
 * Fetch /api/models for a provider; TTL cache + in-flight dedupe.
 *
 * Returns `{ ok, models: {id, context}[], error?, fromCache?, count?, truncated? }`.
 * The per-model `context` is the whole point of keeping it here: the context
 * meter and every debate/project seat read their window out of one shared
 * cache filled by this call, instead of each issuing its own catalog download.
 *
 * `force` bypasses the TTL for the explicit "Detect" button — a user who
 * clicks it after switching plans expects a real request, not a cache hit.
 */
async function fetchProviderModels(provider, { force = false } = {}) {
  if (!provider || !provider.id) return { ok: false, models: [], error: 'No provider' };
  const pid = provider.id;
  const cached = modelCatalogCache[pid];
  if (!force && cached && isCatalogFresh(cached) && !cached.failed) {
    return { ok: true, models: catalogEntries(cached.models), fromCache: true };
  }
  if (modelCatalogInflight[pid]) return modelCatalogInflight[pid];

  // Checked BEFORE the in-flight promise is created. An async function runs
  // synchronously up to its first await, so a branch that returns before any
  // await also runs its `finally` before the assignment below — the delete
  // would be a no-op and the settled failure would be stored as "in flight"
  // for the life of the tab, so adding a key never took effect.
  if (isLocalProvider(provider)) {
    const entries = catalogEntries(provider.models || []);
    ingestModelContexts(pid, entries);
    return { ok: true, models: entries, fromCache: true };
  }

  if (!provider.apiKey) {
    // Not cached as a failure — adding a key must work immediately
    return { ok: false, models: [], error: 'API key required' };
  }

  const promise = (async () => {
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseURL: provider.baseURL,
          apiKey: provider.apiKey
        })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && Array.isArray(data.models)) {
        const entries = catalogEntries(data.models);
        modelCatalogCache[pid] = {
          models: entries,
          at: Date.now(),
          failed: false,
          truncated: !!data.truncated
        };
        saveModelCatalogCache();
        // The single fetch point feeds the shared context store directly, so
        // a catalog pulled for the PICKER also resolves meter/seat windows —
        // callers no longer each have to remember to ingest.
        ingestModelContexts(pid, entries);
        return {
          ok: true,
          models: entries,
          count: Number(data.count) || entries.length,
          truncated: !!data.truncated
        };
      }
      const err = data.error || 'Could not load models';
      markCatalogFailed(pid);
      return { ok: false, models: [], error: err };
    } catch (e) {
      markCatalogFailed(pid);
      return { ok: false, models: [], error: e.message || 'Failed to load models' };
    } finally {
      delete modelCatalogInflight[pid];
    }
  })();

  modelCatalogInflight[pid] = promise;
  return promise;
}

/**
 * Load the catalogs of providers used by debate/project seats so their
 * prompt-trim budgets get real context windows instead of the local table's
 * guess. Fire-and-forget: seat budgets fall back gracefully either way.
 */
async function warmProviderCatalogs(providerIds) {
  const ids = [...new Set((providerIds || []).filter(Boolean))];
  await Promise.all(
    ids.map(async (pid) => {
      const p = providers.find((x) => x.id === pid);
      if (!p || (!p.apiKey && !isLocalProvider(p))) return;
      const cached = modelCatalogCache[pid];
      if (cached && isCatalogFresh(cached) && !cached.failed) {
        // Fresh catalog, but the context store may predate it (or have been
        // cleared) — re-ingesting from cache is free.
        ingestModelContexts(pid, catalogEntries(cached.models));
        return;
      }
      // fetchProviderModels ingests into the context store on success
      await fetchProviderModels(p);
    })
  );
}

/**
 * Soft pre-flight: amber outline when model not in cached catalog.
 * Never blocks send — only advisory.
 */
/**
 * Membership list for the amber "unknown model" outline: the provider catalog
 * plus the profile's DECLARED models — a model the user declared a window for
 * must never be flagged as unknown just because the gateway's /models omits
 * it. Stays null (= no warning) when no catalog exists, same as before.
 */
function warnIdsFor(providerId) {
  const cat = providerId ? modelCatalogCache[providerId] : null;
  // A failed refresh deliberately PRESERVES the last good list (markCatalogFailed),
  // and the picker goes on showing it — so gating the warning on `!failed` made
  // the amber "unknown model" hint vanish after any transient blip while a
  // perfectly usable list was still in hand. Use whatever models we have.
  const catIds = cat && cat.models?.length ? catalogIds(cat.models) : null;
  if (!catIds) return null;
  const p = providers.find((x) => x.id === providerId);
  return catIds.concat((p?.models || []).map((m) => m.id));
}

function updateModelWarnings() {
  let missingCount = 0;

  // Main model field
  const mainInput = $('#model');
  const active = getActiveProvider();
  if (mainInput) {
    const ids = warnIdsFor(active?.id);
    const match = modelMatchesCatalog(mainInput.value, ids);
    const warn = match === false;
    mainInput.classList.toggle('model-soft-warn', warn);
    if (warn) {
      mainInput.title = "Not found in provider's /models — will still be sent";
    } else if (mainInput.title && mainInput.title.includes('/models')) {
      mainInput.title = '';
    }
  }

  // Debate seats
  document.querySelectorAll('.debate-seat').forEach((card) => {
    const idx = Number(card.dataset.seatIndex);
    const e = debateSettings.experts[idx];
    if (!e) return;
    const modelInp = card.querySelector('.seat-model-input');
    if (!modelInp) return;
    const pid =
      providers.length === 1
        ? providers[0]?.id
        : e.providerId || activeProviderId;
    const ids = warnIdsFor(pid);
    const match = modelMatchesCatalog(e.model || modelInp.value, ids);
    const warn = match === false;
    modelInp.classList.toggle('model-soft-warn', warn);
    if (warn) {
      missingCount++;
      modelInp.title = "Not found in provider's /models — will still be sent";
    } else if (modelInp.title && modelInp.title.includes('/models')) {
      modelInp.title = '';
    }
  });

  // Judge model
  const judgeInput = $('#debateJudgeRow')?.querySelector('.seat-model-input');
  if (judgeInput && debateSettings.finalAnswerMode === 'judge') {
    const j = debateSettings.judge || {};
    const pid =
      providers.length === 1
        ? providers[0]?.id
        : j.providerId || activeProviderId;
    const ids = warnIdsFor(pid);
    const match = modelMatchesCatalog(j.model || judgeInput.value, ids);
    const warn = match === false;
    judgeInput.classList.toggle('model-soft-warn', warn);
    if (warn) {
      missingCount++;
      judgeInput.title = "Not found in provider's /models — will still be sent";
    } else if (judgeInput.title && judgeInput.title.includes('/models')) {
      judgeInput.title = '';
    }
  }

  const warnEl = $('#debateModelWarn');
  if (warnEl) {
    if (missingCount > 0) {
      warnEl.hidden = false;
      warnEl.textContent =
        missingCount === 1
          ? '⚠ 1 model not found in its provider catalog'
          : `⚠ ${missingCount} models not found in their provider catalogs`;
    } else {
      warnEl.hidden = true;
      warnEl.textContent = '';
    }
  }
}

/**
 * Searchable model combo: free-type + grouped dropdown (Favorites / Recent / Catalog).
 * Dropdown is position:fixed so it is not clipped by the sidebar scroll container.
 */
function attachModelPicker(input, opts = {}) {
  if (!input || input.dataset.pickerAttached === '1') return;
  input.dataset.pickerAttached = '1';
  input.classList.add('model-picker-input');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  input.removeAttribute('list');

  let wrap = input.closest('.model-picker');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'model-picker';
    if (input.parentNode) {
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
    } else {
      wrap.appendChild(input);
    }
  }

  let drop = wrap.querySelector('.model-picker-drop');
  if (!drop) {
    drop = document.createElement('div');
    drop.className = 'model-picker-drop';
    drop.hidden = true;
    drop.setAttribute('role', 'listbox');
    wrap.appendChild(drop);
  }

  let items = [];
  let activeIdx = -1;
  let loading = false;
  let open = false;

  const getProvider = () => {
    const id = opts.getProviderId ? opts.getProviderId() : activeProviderId;
    if (id) {
      const p = providers.find((x) => x.id === id);
      if (p) return p;
    }
    return getActiveProvider();
  };

  const buildGroups = (query) => {
    const provider = getProvider();
    const pid = provider?.id || '';
    const q = String(query || '')
      .trim()
      .toLowerCase();
    const seen = new Set();
    const groups = [];

    const push = (label, ids) => {
      const out = [];
      for (const id of ids || []) {
        if (!id || seen.has(id)) continue;
        if (q && !String(id).toLowerCase().includes(q)) continue;
        seen.add(id);
        out.push(id);
      }
      if (out.length) groups.push({ label, ids: out });
    };

    push('Favorites', favoritesForProvider(pid));
    push('Recent', recentsForProvider(pid));
    // Models declared on the profile itself (with their context windows)
    push('Declared models', (provider?.models || []).map((m) => m.id));
    // A failed refresh keeps the last good list — show it (the status row
    // below the list says the refresh failed) rather than an empty picker.
    const cat = modelCatalogCache[pid];
    if (cat) {
      const ids = catalogIds(cat.models);
      if (ids.length) push('Provider models', ids);
    }

    // Examples only when nothing else to show
    if (!groups.length) {
      push('Examples', DEFAULT_MODELS);
    }
    return groups;
  };

  const setActive = (i) => {
    if (!items.length) {
      activeIdx = -1;
      return;
    }
    activeIdx = ((i % items.length) + items.length) % items.length;
    items.forEach((it, j) => it.el.classList.toggle('active', j === activeIdx));
    items[activeIdx]?.el.scrollIntoView({ block: 'nearest' });
  };

  const positionDrop = () => {
    const r = input.getBoundingClientRect();
    drop.style.position = 'fixed';
    drop.style.left = `${Math.max(4, r.left)}px`;
    drop.style.width = `${Math.max(r.width, 180)}px`;
    drop.style.zIndex = '220';
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < 200 && r.top > 200) {
      drop.style.top = 'auto';
      drop.style.bottom = `${window.innerHeight - r.top + 4}px`;
      drop.style.maxHeight = `${Math.min(280, r.top - 12)}px`;
    } else {
      drop.style.bottom = 'auto';
      drop.style.top = `${r.bottom + 4}px`;
      drop.style.maxHeight = `${Math.min(280, spaceBelow - 12)}px`;
    }
  };

  const renderDrop = () => {
    const groups = buildGroups(input.value);
    drop.innerHTML = '';
    items = [];
    activeIdx = -1;

    if (loading) {
      const row = document.createElement('div');
      row.className = 'model-picker-status';
      row.innerHTML =
        '<span class="model-picker-spin" aria-hidden="true"></span> Loading models…';
      drop.appendChild(row);
    }

    for (const g of groups) {
      const lab = document.createElement('div');
      lab.className = 'model-picker-group-label';
      lab.textContent = g.label;
      drop.appendChild(lab);
      for (const id of g.ids) {
        const el = document.createElement('div');
        el.className = 'model-picker-item';
        el.setAttribute('role', 'option');
        el.textContent = id;
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectId(id);
        });
        drop.appendChild(el);
        items.push({ id, el });
      }
    }

    const provider = getProvider();
    const cat = provider?.id ? modelCatalogCache[provider.id] : null;
    if (cat?.failed && !loading) {
      const row = document.createElement('div');
      row.className = 'model-picker-status warn';
      row.textContent = "couldn't load — type the model id";
      drop.appendChild(row);
    }

    if (!items.length && !loading) {
      const row = document.createElement('div');
      row.className = 'model-picker-status';
      const v = input.value.trim();
      row.textContent = v ? `Press Enter to use “${v}”` : 'Type a model id';
      drop.appendChild(row);
    }

    if (items.length) setActive(0);
  };

  const closeDrop = () => {
    open = false;
    drop.hidden = true;
    drop.classList.remove('open');
  };

  const openDrop = async () => {
    open = true;
    drop.hidden = false;
    drop.classList.add('open');
    positionDrop();
    renderDrop();
    const provider = getProvider();
    if (provider && provider.apiKey) {
      const cached = modelCatalogCache[provider.id];
      if (!isCatalogFresh(cached)) {
        loading = true;
        renderDrop();
        await fetchProviderModels(provider);
        loading = false;
        if (open) {
          renderDrop();
          positionDrop();
        }
        updateModelWarnings();
      }
    }
  };

  const selectId = (id) => {
    input.value = id;
    if (opts.onChange) opts.onChange(id);
    closeDrop();
    updateModelWarnings();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  input.addEventListener('focus', () => {
    openDrop();
  });
  input.addEventListener('input', () => {
    if (opts.onChange) opts.onChange(input.value);
    if (!open) openDrop();
    else renderDrop();
    updateModelWarnings();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openDrop();
      else setActive(activeIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setActive(activeIdx - 1);
    } else if (e.key === 'Enter') {
      if (open && activeIdx >= 0 && items[activeIdx]) {
        e.preventDefault();
        selectId(items[activeIdx].id);
      } else {
        closeDrop();
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        closeDrop();
      }
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!wrap.contains(document.activeElement)) closeDrop();
    }, 160);
  });

  // Provider switch / external refresh
  input._modelPickerRefresh = () => {
    if (open) openDrop();
    updateModelWarnings();
  };
  input._modelPickerReposition = () => {
    if (open) positionDrop();
  };
}

function renderSavedModels() {
  const ul = $('#savedModels');
  if (!ul) return;
  ul.innerHTML = '';
  if (!savedModels.length) {
    ul.innerHTML =
      '<li style="justify-content:center;color:var(--text-dim);cursor:default">No custom models yet</li>';
    return;
  }
  savedModels.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = 'saved-model-row';
    const id = favoriteId(m);
    const pid = m.providerId || '';
    const prov = pid ? providers.find((p) => p.id === pid) : null;
    const chipLabel = pid ? prov?.name || 'provider' : 'any';
    li.innerHTML =
      `<span class="model-name"></span>` +
      `<button type="button" class="fav-provider-chip" title="Cycle provider scope: specific → any → specific"></button>` +
      `<span class="remove" data-i="${i}">✕</span>`;
    li.querySelector('.model-name').textContent = id;
    const chip = li.querySelector('.fav-provider-chip');
    chip.textContent = chipLabel;
    chip.classList.toggle('any', !pid);
    li.querySelector('.model-name').addEventListener('click', () => {
      $('#model').value = id;
      updateTopbar();
      updateModelWarnings();
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      // Cycle: specific provider → any → active (or first) provider
      if (m.providerId) {
        m.providerId = '';
      } else {
        m.providerId = activeProviderId || providers[0]?.id || '';
      }
      saveSavedModels();
    });
    li.querySelector('.remove').addEventListener('click', (e) => {
      e.stopPropagation();
      savedModels.splice(i, 1);
      saveSavedModels();
    });
    ul.appendChild(li);
  });
}

export { attachModelPicker, catalogEntries, catalogIds, splitModelId, favoriteId, favoritesForProvider, fetchProviderModels, isCatalogFresh, loadModelCatalogCache, loadRecentModels, loadSavedModels, modelIdsRelated, modelMatchesCatalog, normalizeFavorite, pushRecentModel, rebuildModelDatalist, recentsForProvider, renderSavedModels, saveModelCatalogCache, saveSavedModels, updateModelWarnings, warmProviderCatalogs };
