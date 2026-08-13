/**
 * Model-id equivalence. Pure — no DOM, no app state, unit-testable in Node.
 *
 * This MUST agree with `splitModelId` / `modelIdsRelated` in lib/proxy.js: the
 * server uses them to pick a context window out of a provider catalog, the
 * client uses them to match the same catalog for the meter and the "unknown
 * model" warning. If the two drift, the badge and the warning disagree about
 * the same id. test/model-id.test.js runs one case table through both.
 */

/**
 * Split a model id into { base, tag }, stripping any provider prefix.
 *
 * Two conventions collide on the same character:
 *   OpenRouter   "moonshotai/kimi-k3"   provider before "/"; ":free" is a TAG
 *   TokenRouter  "openai:gpt-4o"        provider before ":"
 * So the side that looks model-shaped (digit, hyphen or dot) decides: bare
 * words are providers or tags, never model ids. Ambiguous pairs — including
 * TokenRouter's "auto:balance" routing modes — are left intact so unrelated
 * ids never collapse together.
 */
/**
 * Ollama-style variant tags: parameter counts ("7b", "1.5b", "70b"),
 * quantizations ("q4_0", "fp16", "int8") and the stock rollout names. These are
 * the only right-hand sides that are model-shaped yet are NOT the model.
 */
const MODEL_SIZE_TAG_RE =
  /^(?:\d+(?:\.\d+)?[bkm]|q\d+[a-z0-9_-]*|k_[a-z0-9_]+|fp\d+|bf\d+|int\d+|latest)$/;

function splitModelId(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return { base: '', tag: '' };
  if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1);
  const modelish = (v) => /[0-9]/.test(v) || v.includes('-') || v.includes('.');
  const c = s.indexOf(':');
  if (c > 0 && c < s.length - 1) {
    const left = s.slice(0, c);
    const right = s.slice(c + 1);
    // Ollama's ":7b" / ":q4_0" are VARIANT tags, and they are model-shaped
    // (they carry a digit), so the provider-prefix rule below would read them
    // as the model and throw the name away — collapsing "codellama:7b" and
    // "mistral:7b" to the same base "7b".
    if (MODEL_SIZE_TAG_RE.test(right)) return { base: left, tag: right };
    if (!modelish(left) && modelish(right)) return { base: right, tag: '' }; // provider prefix
    if (modelish(left) && !modelish(right)) return { base: left, tag: right }; // ":tag" variant
  }
  return { base: s, tag: '' };
}

/**
 * True when two ids name the same model: exact, the same id under a different
 * provider prefix ("kimi-k3" ↔ "moonshotai/kimi-k3" ↔ "openai:gpt-4o"), or a
 * ":tag" variant of the same base when exactly one side is tagged
 * ("deepseek-r1" ↔ "deepseek-r1:free"). Never matches mere substrings, so
 * "gpt-4o" does NOT match "gpt-4o-mini", and two different tags stay distinct.
 */
function modelIdsRelated(a, b) {
  const na = String(a || '').trim().toLowerCase();
  const nb = String(b || '').trim().toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const pa = splitModelId(na);
  const pb = splitModelId(nb);
  if (!pa.base || !pb.base) return false;
  if (pa.base !== pb.base) return false;
  return pa.tag === pb.tag || !pa.tag || !pb.tag;
}

/**
 * Soft catalog membership for the advisory amber outline.
 * Returns true / false, or null when no catalog is available to check against.
 */
function modelMatchesCatalog(modelId, catalogIds) {
  if (!catalogIds || !catalogIds.length) return null;
  const want = String(modelId || '').trim();
  if (!want) return null;
  return catalogIds.some((id) => modelIdsRelated(id, want));
}

export { modelIdsRelated, modelMatchesCatalog, splitModelId };
