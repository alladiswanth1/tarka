import { getConfig } from './config.js';
import { ctxCacheKey, getCachedContext, getSharedContext, ingestModelContexts, loadProviderContextCache, putCachedContext, saveProviderContextCache } from './contextStore.js';
import { estimateMessagesTokens } from './history.js';
import { modelIdsRelated } from './modelId.js';
import { catalogEntries, fetchProviderModels } from './models.js';
import { declaredContextFor, getActiveProvider } from './providers.js';
import { $, contextDetectTimer, detectContextInflight, lastCompletionTokens, lastGenStats, lastPromptTokens, messages, prefersReducedMotion, resolvedContext, setContextDetectTimer, setDetectContextInflight, setResolvedContext, tokenInfo, userInput } from './state.js';
import { estimateTokens, formatTokenCount, lookupKnownContext } from './tokens.js';
import { updateInspectorSession } from './ui/inspector.js';
import { flashStatus } from './ui/transcript.js';

/**
 * Resolve a limit for any provider+model pair (used by debate/project seats).
 * Order: the window DECLARED on the provider profile (OpenClaw-style custom
 * provider models — the user's word beats everything) → this provider's own
 * /models report → the same model as reported by another configured provider
 * (a window is a property of the model, not the reseller) → the local guess
 * table.
 */
function contextLimitFor(providerId, modelId) {
  const declared = declaredContextFor(providerId, modelId);
  if (declared > 0) return { limit: declared, source: 'declared' };
  const cached = getCachedContext(providerId, modelId);
  if (cached > 0) return { limit: cached, source: 'provider' };
  const shared = getSharedContext(modelId, providerId);
  if (shared) return { limit: shared.limit, source: 'shared' };
  const known = lookupKnownContext(modelId);
  return { limit: known.limit, source: known.source };
}

function resolveContextLimit(modelId) {
  const cfg = getConfig();
  const manual = cfg.contextLimit;
  if (manual && manual > 0) {
    return { limit: manual, source: 'manual', model: modelId };
  }
  const r = contextLimitFor(cfg.providerId, modelId);
  return { limit: r.limit, source: r.source, model: modelId };
}

function getContextUsage() {
  const cfg = getConfig();
  setResolvedContext(resolveContextLimit(cfg.model));
  const draft = userInput?.value || '';
  const estimated = estimateMessagesTokens(messages, cfg.systemPrompt) + estimateTokens(draft) + 8;

  // Prefer last real prompt_tokens + current draft growth when available
  let used = estimated;
  if (lastPromptTokens != null && Number.isFinite(lastPromptTokens)) {
    // After a turn, history grew; blend: use estimate but floor/calibrate with last measured when close
    used = Math.max(estimated, lastPromptTokens);
    // If estimate is wildly higher than last prompt (new long draft), trust estimate
    if (estimated > lastPromptTokens * 1.15) used = estimated;
  }

  const limit = resolvedContext.limit;
  const maxOut = cfg.maxTokens || 0;
  // reserved for completion if max_tokens set
  const reserved = maxOut > 0 ? Math.min(maxOut, limit) : 0;
  const remaining = Math.max(0, limit - used - reserved);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return {
    used,
    limit,
    remaining,
    pct,
    reserved,
    source: resolvedContext.source,
    model: cfg.model,
    lastIn: lastPromptTokens,
    lastOut: lastCompletionTokens
  };
}

/** Piecewise pct → hue (142 green → 4 red) for smooth meter color travel */
function meterHueFor(pct) {
  const stops = [[0, 142], [55, 95], [75, 48], [90, 22], [100, 4]];
  for (let i = 1; i < stops.length; i++) {
    if (pct <= stops[i][0]) {
      const [p0, h0] = stops[i - 1];
      const [p1, h1] = stops[i];
      return Math.round(h0 + ((h1 - h0) * (pct - p0)) / (p1 - p0));
    }
  }
  return 4;
}

/**
 * Context meter "liquid" fill: brief +2% overshoot when the value rises,
 * then settle back via the existing width transition. Skipped under reduced motion.
 */
function setMeterFillWidth(el, pct) {
  if (!el) return;
  const target = Math.min(100, Math.max(0, pct));
  const targetStr = `${target.toFixed(1)}%`;
  if (prefersReducedMotion.matches) {
    el.style.width = targetStr;
    return;
  }
  const prev = parseFloat(el.style.width);
  const prevN = Number.isFinite(prev) ? prev : 0;
  clearTimeout(el._overshootT);
  if (target > prevN + 0.15) {
    el.style.width = `${Math.min(100, target + 2).toFixed(1)}%`;
    el._overshootT = setTimeout(() => {
      el.style.width = targetStr;
    }, 180);
  } else {
    el.style.width = targetStr;
  }
}

/** Count-up tween state for the token line */
const tokenCountAnim = { raf: 0, current: 0 };

function setTokenLine(u, srcLabel) {
  if (!tokenInfo) return;
  const tps = lastGenStats && lastGenStats.tps > 0 ? ` @ ${lastGenStats.tps} t/s` : '';
  const extra =
    u.lastIn != null ? ` · last ${formatTokenCount(u.lastIn)}→${formatTokenCount(u.lastOut || 0)}${tps}` : '';
  const build = (usedVal) => {
    const pct = u.limit > 0 ? Math.min(100, (usedVal / u.limit) * 100) : 0;
    return `${formatTokenCount(usedVal)} / ${formatTokenCount(u.limit)} · ${Math.round(pct)}% · ${srcLabel}${extra}`;
  };
  const target = u.used;
  const from = tokenCountAnim.current || 0;
  cancelAnimationFrame(tokenCountAnim.raf);
  if (prefersReducedMotion.matches || Math.abs(target - from) <= 50) {
    tokenCountAnim.current = target;
    tokenInfo.textContent = build(target);
    return;
  }
  const startAt = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startAt) / 400);
    const eased = 1 - Math.pow(1 - t, 3);
    tokenCountAnim.current = from + (target - from) * eased;
    tokenInfo.textContent = build(Math.round(tokenCountAnim.current));
    if (t < 1) tokenCountAnim.raf = requestAnimationFrame(step);
  };
  tokenCountAnim.raf = requestAnimationFrame(step);
}

/** One-shot badge pulse the first time a level is reached this session */
const pulsedLevels = new Set();

function updateContextUI() {
  const u = getContextUsage();
  const fill = $('#contextMeterFill');
  const badgeFill = $('#contextBadgeFill');
  const badgeText = $('#contextBadgeText');
  const meter = $('#contextMeter');
  const hint = $('#contextDetectHint');

  const level =
    u.pct >= 95 ? 'critical' : u.pct >= 80 ? 'warn' : u.pct >= 60 ? 'mid' : 'ok';
  const hue = meterHueFor(u.pct);

  if (fill) {
    setMeterFillWidth(fill, Math.max(2, u.pct));
    fill.style.setProperty('--meter-hue', hue);
    fill.dataset.level = level;
  }
  if (badgeFill) {
    setMeterFillWidth(badgeFill, Math.max(4, u.pct));
    badgeFill.style.setProperty('--meter-hue', hue);
    badgeFill.dataset.level = level;
  }

  const srcLabel =
    u.source === 'provider'
      ? 'API'
      : u.source === 'declared'
        ? 'custom'
        : u.source === 'shared'
          ? 'API·other'
          : u.source === 'manual'
            ? 'manual'
            : u.source === 'known'
              ? 'known'
              : u.source === 'name-hint'
                ? 'name'
                : 'default';

  setTokenLine(u, srcLabel);
  if (badgeText) {
    badgeText.textContent = `${formatTokenCount(u.limit)} ctx`;
  }
  if (meter) {
    meter.title = `Context: ${Math.round(u.used)} / ${u.limit} tokens (${Math.round(u.pct)}%)\nSource: ${srcLabel}\nRemaining ≈ ${formatTokenCount(u.remaining)}`;
    meter.dataset.level = level;
  }
  const badge = $('#contextBadge');
  if (badge) {
    badge.dataset.level = level;
    badge.title = `Context window: ${u.limit.toLocaleString()} tokens (${srcLabel})\nUsed ≈ ${Math.round(u.used)} (${Math.round(u.pct)}%)\nClick to detect from provider`;
    // Pulse once per session when entering warn/critical
    if ((level === 'warn' || level === 'critical') && !pulsedLevels.has(level)) {
      pulsedLevels.add(level);
      if (!prefersReducedMotion.matches) {
        badge.classList.remove('level-pulse');
        void badge.offsetWidth;
        badge.classList.add('level-pulse');
      }
    }
  }
  if (hint && !hint.dataset.locked) {
    hint.innerHTML = `Limit <strong>${formatTokenCount(u.limit)}</strong> via <code>${srcLabel}</code>. Provider <code>/models</code> when available.`;
  }
  if (typeof updateInspectorSession === 'function') updateInspectorSession(u, srcLabel);
}

/**
 * Resolve the active model's context window from the provider.
 *
 * Goes through the shared model catalog rather than issuing its own
 * `/api/models` call: the catalog is TTL-cached and in-flight-deduped per
 * provider, and one fetch now records a window for EVERY model that provider
 * lists. Before this, a model the provider did not list was never cached in
 * any form, so the 700ms model-edit debounce re-downloaded the whole catalog
 * on every keystroke pause — and forever after, on every page load.
 */
async function detectContextFromProvider({ silent = false, force = false } = {}) {
  const cfg = getConfig();
  // Dedupe concurrent callers (badge + debounce + save) — keyed by
  // provider+model so a switch mid-detect never reuses the other probe
  // A forced probe must not be answered by an in-flight SILENT one: the
  // background debounce is allowed to reuse the TTL cache, so clicking Detect
  // while it was running quietly returned the cached answer the user was
  // explicitly asking to re-check. Keyed on force too, so the two never share.
  const inflightKey = `${ctxCacheKey(cfg.providerId, cfg.model)}::${force ? 'force' : 'auto'}`;
  if (detectContextInflight && detectContextInflight.key === inflightKey) {
    return detectContextInflight.promise;
  }

  const record = { key: inflightKey, promise: null };
  setDetectContextInflight(record);

  const unlockHint = () => {
    const hint = $('#contextDetectHint');
    if (hint) delete hint.dataset.locked;
  };

  record.promise = (async () => {
    if (!cfg.apiKey) {
      if (!silent) flashStatus('Set API key to detect context');
      updateContextUI();
      return null;
    }

    if (!silent) {
      flashStatus('Detecting context…', 4000);
      const hint = $('#contextDetectHint');
      if (hint) {
        hint.dataset.locked = '1';
        hint.textContent = 'Querying provider /models…';
      }
    }

    try {
      const provider = getActiveProvider();
      const data = await fetchProviderModels(provider, { force });
      unlockHint();

      if (data.ok) {
        // Record every window this provider reported, not just the active
        // model's — debate and project seats read the same cache.
        ingestModelContexts(cfg.providerId, data.models);

        const entries = catalogEntries(data.models);
        const want = String(cfg.model || '').toLowerCase();
        const exact = entries.find((m) => m.id.toLowerCase() === want);
        const hit =
          (exact && exact.context ? exact : null) ||
          entries.find((m) => m.context && modelIdsRelated(m.id, cfg.model));

        if (hit) {
          // Also key the window under the id the user actually typed, so an
          // alias ("kimi-k3" for "moonshotai/kimi-k3") resolves without a
          // catalog scan on every meter repaint.
          if (hit.id !== cfg.model) {
            putCachedContext(cfg.providerId, cfg.model, hit.context, { matchedId: hit.id });
            saveProviderContextCache();
          }
          updateContextUI();
          // A declared window outranks the catalog's — say so instead of
          // flashing a number the meter will not show
          const declared = declaredContextFor(cfg.providerId, cfg.model);
          if (!silent) {
            flashStatus(
              declared > 0 && declared !== hit.context
                ? `Provider says ${formatTokenCount(hit.context)} — using your declared ${formatTokenCount(declared)}`
                : `Context: ${formatTokenCount(hit.context)} (${hit.id})`
            );
          }
          return declared > 0 ? declared : hit.context;
        }
      }

      // No window from THIS provider. Another configured provider may have
      // reported one for the same model (contextLimitFor checks the shared
      // store before the local guess table).
      const fallback = contextLimitFor(cfg.providerId, cfg.model);
      updateContextUI();
      if (!silent) {
        const via =
          fallback.source === 'shared'
            ? "another provider's catalog"
            : fallback.source === 'declared'
              ? "this profile's declared models"
              : fallback.source;
        flashStatus(
          data.ok
            ? `Provider lists no window for this model — using ${formatTokenCount(fallback.limit)} (${via})`
            : `No API context — using ${formatTokenCount(fallback.limit)} (${via})`
        );
      }
      return fallback.limit;
    } catch (e) {
      unlockHint();
      updateContextUI();
      if (!silent) flashStatus('Context detect failed — using local table');
      return null;
    } finally {
      // Identity check: only clear our own record (a provider/model switch may
      // have started a fresh probe meanwhile)
      if (detectContextInflight === record) setDetectContextInflight(null);
    }
  })();

  return record.promise;
}

function scheduleContextDetect() {
  clearTimeout(contextDetectTimer);
  setContextDetectTimer(setTimeout(() => {
    const cfg = getConfig();
    if (!cfg.apiKey) {
      updateContextUI();
      return;
    }
    // Only auto-hit provider when nothing authoritative answers already —
    // a declared window is the user's explicit word, no probe needed
    const r = resolveContextLimit(cfg.model);
    if (r.source === 'provider' || r.source === 'manual' || r.source === 'declared') {
      updateContextUI();
      return;
    }
    detectContextFromProvider({ silent: true });
  }, 700));
}

export { contextLimitFor, ctxCacheKey, detectContextFromProvider, getContextUsage, loadProviderContextCache, lookupKnownContext, meterHueFor, pulsedLevels, resolveContextLimit, saveProviderContextCache, scheduleContextDetect, setMeterFillWidth, setTokenLine, tokenCountAnim, updateContextUI };
