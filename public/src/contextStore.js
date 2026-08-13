/*
 * The provider-reported context-window cache.
 *
 * This lives in its own module because TWO features need it and neither may
 * import the other: `context.js` (the meter) and `models.js` (the catalog).
 * Both used to call `/api/models` separately — the catalog cached the response
 * for an hour but threw the per-model context away, while the meter kept the
 * context but cached nothing, so every model edit re-downloaded a multi-MB
 * catalog and debate seats never got a real window at all. One store, written
 * once per catalog fetch, fixes both.
 *
 * Imports only state.js (which imports nothing) and modelId.js (pure), so it
 * cannot introduce an evaluation-order cycle. See ARCHITECTURE.md.
 */
import { modelIdsRelated } from './modelId.js';
import { providerContextCache, setProviderContextCache } from './state.js';

const CONTEXT_CACHE_KEY = 'customChatContextCache';
/**
 * Entries are tiny ({limit, at}); the cap only bounds localStorage. It has to
 * clear a whole catalog comfortably — a big gateway lists several hundred
 * models and one ingest writes them all, so a tight cap would evict the
 * previous provider on every switch and re-fetch forever.
 */
const CONTEXT_CACHE_MAX = 2000;
/** A provider can change a model's window; re-check weekly. */
const CONTEXT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache key: the same model id can report different limits on different gateways. */
function ctxCacheKey(providerId, modelId) {
  return `${providerId}::${modelId}`;
}

function loadProviderContextCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTEXT_CACHE_KEY) || '{}');
    setProviderContextCache(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  } catch {
    setProviderContextCache({});
  }
}

function saveProviderContextCache() {
  try {
    // Cap growth — keep the most recently written entries
    const entries = Object.entries(providerContextCache);
    if (entries.length > CONTEXT_CACHE_MAX) {
      entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
      setProviderContextCache(Object.fromEntries(entries.slice(0, CONTEXT_CACHE_MAX)));
    }
    localStorage.setItem(CONTEXT_CACHE_KEY, JSON.stringify(providerContextCache));
  } catch {
    /* quota / storage disabled — the in-memory cache still works this session */
  }
}

/** A cache entry that is present, positive, and not past its TTL. */
function isFresh(hit) {
  if (!hit || !(hit.limit > 0)) return 0;
  if (hit.at && Date.now() - hit.at >= CONTEXT_CACHE_TTL_MS) return 0;
  return hit.limit;
}

/**
 * Cached limit for provider+model, or 0 when absent or stale.
 *
 * Exact key first, then the same equivalence `getSharedContext` uses — because
 * this lookup is keyed on the id the USER typed while the cache is keyed on the
 * ids the CATALOG listed, and those differ constantly ("tuned-writer-v2" vs
 * "acme/tuned-writer-v2", "gpt-4o" vs "openai:gpt-4o"). Exact-string-only meant
 * an alias missed here and then hit `getSharedContext`, which deliberately
 * EXCLUDES this provider — so a window resolved against every provider except
 * the one that actually reported it, and the seat silently fell back to the
 * 128k default. A debate seat on a 32k model then trims against a budget four
 * times too large and draws the hard 400 the trim exists to prevent.
 */
function getCachedContext(providerId, modelId) {
  const exact = isFresh(providerContextCache[ctxCacheKey(providerId, modelId)]);
  if (exact) return exact;
  const want = String(modelId || '');
  if (!want) return 0;
  const prefix = `${String(providerId || '')}::`;
  let best = 0;
  let bestAt = -1;
  for (const [key, hit] of Object.entries(providerContextCache)) {
    if (!key.startsWith(prefix)) continue;
    const limit = isFresh(hit);
    if (!limit) continue;
    const mid = key.slice(prefix.length);
    if (mid.toLowerCase() === want.toLowerCase() || !modelIdsRelated(mid, want)) continue;
    if ((hit.at || 0) > bestAt) {
      best = limit;
      bestAt = hit.at || 0;
    }
  }
  return best;
}

/**
 * A window for this model reported by ANY other configured provider.
 *
 * Gateways in the one-api family (TokenRouter et al.) publish no context
 * fields in /models, so their models used to fall straight to the local
 * guess table — while the same model, listed by an OpenRouter profile one
 * click away, had its real window sitting in this cache. A window is a
 * property of the model, not of who resells it, so borrowing across
 * providers beats guessing from the id. Exact-id matches outrank
 * prefix/tag-equivalent ones ("gpt-4o" over "openai:gpt-4o"); newest wins
 * within a rank. Returns { limit, providerId, modelId } or null.
 */
function getSharedContext(modelId, excludeProviderId) {
  const want = String(modelId || '');
  if (!want) return null;
  const wantLower = want.toLowerCase();
  const now = Date.now();
  let best = null;
  for (const [key, hit] of Object.entries(providerContextCache)) {
    if (!hit || !(hit.limit > 0)) continue;
    if (hit.at && now - hit.at >= CONTEXT_CACHE_TTL_MS) continue;
    const sep = key.indexOf('::');
    if (sep < 0) continue;
    const pid = key.slice(0, sep);
    if (pid === String(excludeProviderId || '')) continue;
    const mid = key.slice(sep + 2);
    const exact = mid.toLowerCase() === wantLower;
    if (!exact && !modelIdsRelated(mid, want)) continue;
    const rank = exact ? 1 : 0;
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank && (hit.at || 0) > (best.at || 0))
    ) {
      best = { limit: hit.limit, providerId: pid, modelId: mid, rank, at: hit.at || 0 };
    }
  }
  return best ? { limit: best.limit, providerId: best.providerId, modelId: best.modelId } : null;
}

function putCachedContext(providerId, modelId, limit, extra) {
  if (!modelId || !(limit > 0)) return;
  providerContextCache[ctxCacheKey(providerId, modelId)] = {
    limit: Math.round(limit),
    at: Date.now(),
    ...(extra || {})
  };
}

/**
 * Record every context window a provider reported in one pass.
 *
 * This is what makes debate and project seats work: their prompt-trim budgets
 * read this cache, but nothing ever wrote a seat's model into it, because only
 * the active solo model was ever probed. One catalog fetch now covers every
 * model that provider offers. Returns how many entries were written.
 */
function ingestModelContexts(providerId, models) {
  if (!Array.isArray(models) || !models.length) return 0;
  let n = 0;
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const limit = Number(m.context);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    putCachedContext(providerId, String(m.id), limit);
    n++;
  }
  if (n) saveProviderContextCache();
  return n;
}

export {
  CONTEXT_CACHE_KEY,
  CONTEXT_CACHE_MAX,
  CONTEXT_CACHE_TTL_MS,
  ctxCacheKey,
  getCachedContext,
  getSharedContext,
  ingestModelContexts,
  loadProviderContextCache,
  putCachedContext,
  saveProviderContextCache
};
