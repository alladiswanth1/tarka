/**
 * Context-window table and token estimation.
 *
 * The estimate is deliberately rough (~4 chars/token latin, ~1 CJK) and is
 * only used for meters and prompt budgeting; real provider `usage` always
 * wins when it arrives. CONTEXT_PATTERNS is first-match-wins, so order
 * matters — put the specific pattern above the general one.
 *
 * Pure: no DOM, no app state.
 */

// ========== Context window database ==========
// Patterns checked in order (first match wins). Keys are regex strings (case-insensitive).
const CONTEXT_PATTERNS = [
  // Google Gemini
  [/gemini[-_]?3/i, 1_048_576],
  [/gemini[-_]?2\.5[-_]?pro/i, 1_048_576],
  [/gemini[-_]?2\.5[-_]?flash/i, 1_048_576],
  [/gemini[-_]?2\.0[-_]?flash/i, 1_048_576],
  [/gemini[-_]?1\.5[-_]?pro/i, 2_000_000],
  [/gemini[-_]?1\.5[-_]?flash/i, 1_000_000],
  [/gemini[-_]?pro/i, 32_768],
  // Anthropic
  [/claude[-_]?4/i, 200_000],
  [/claude[-_]?3[-_.]?7/i, 200_000],
  [/claude[-_]?3[-_.]?5[-_]?sonnet/i, 200_000],
  [/claude[-_]?3[-_.]?5[-_]?haiku/i, 200_000],
  [/claude[-_]?3[-_]?opus/i, 200_000],
  [/claude[-_]?3[-_]?sonnet/i, 200_000],
  [/claude[-_]?3[-_]?haiku/i, 200_000],
  [/claude[-_]?sonnet[-_]?4/i, 200_000],
  [/claude[-_]?opus/i, 200_000],
  [/claude/i, 200_000],
  // OpenAI
  [/gpt[-_]?5/i, 400_000],
  [/gpt[-_]?oss/i, 131_072],
  [/gpt[-_]?4\.1[-_]?nano/i, 1_047_576],
  [/gpt[-_]?4\.1[-_]?mini/i, 1_047_576],
  [/gpt[-_]?4\.1/i, 1_047_576],
  [/gpt[-_]?4o[-_]?mini/i, 128_000],
  [/gpt[-_]?4o/i, 128_000],
  [/o3[-_]?mini/i, 200_000],
  [/o4[-_]?mini/i, 200_000],
  [/\bo3\b/i, 200_000],
  [/\bo1[-_]?mini/i, 128_000],
  [/\bo1[-_]?pro/i, 200_000],
  [/\bo1\b/i, 200_000],
  [/gpt[-_]?4[-_]?turbo/i, 128_000],
  [/gpt[-_]?4[-_]?32k/i, 32_768],
  [/gpt[-_]?4/i, 8_192],
  [/gpt[-_]?3\.5[-_]?turbo[-_]?16k/i, 16_384],
  [/gpt[-_]?3\.5/i, 16_385],
  // xAI
  [/grok[-_]?4.*fast/i, 2_000_000],
  [/grok[-_]?build/i, 256_000],
  [/grok[-_]?4\.5/i, 256_000],
  [/grok[-_]?code/i, 256_000],
  [/grok[-_]?4/i, 256_000],
  [/grok[-_]?3[-_]?mini/i, 131_072],
  [/grok[-_]?3/i, 131_072],
  [/grok[-_]?2/i, 131_072],
  [/grok/i, 131_072],
  // DeepSeek
  [/deepseek[-_]?r1/i, 128_000],
  [/deepseek[-_]?v3/i, 128_000],
  [/deepseek[-_]?chat/i, 128_000],
  [/deepseek[-_]?coder/i, 128_000],
  [/deepseek/i, 128_000],
  // Moonshot / Kimi
  [/kimi[-_]?k2/i, 256_000],
  [/kimi[-_]?k3/i, 128_000],
  [/moonshot.*128k/i, 128_000],
  [/moonshot.*32k/i, 32_768],
  [/moonshot.*8k/i, 8_192],
  [/moonshot/i, 128_000],
  [/kimi/i, 128_000],
  // Meta Llama
  [/llama[-_]?4/i, 1_000_000],
  [/llama[-_]?3\.3/i, 128_000],
  [/llama[-_]?3\.2/i, 128_000],
  [/llama[-_]?3\.1[-_]?405b/i, 128_000],
  [/llama[-_]?3\.1/i, 128_000],
  [/llama[-_]?3/i, 8_192],
  [/llama[-_]?2/i, 4_096],
  // Mistral
  [/mistral[-_]?large/i, 128_000],
  [/mistral[-_]?medium/i, 131_072],
  [/mistral[-_]?small/i, 32_768],
  [/mistral[-_]?nemo/i, 128_000],
  [/magistral/i, 40_000],
  [/devstral/i, 131_072],
  [/mixtral[-_]?8x22b/i, 65_536],
  [/mixtral/i, 32_768],
  [/codestral/i, 32_768],
  [/pixtral/i, 128_000],
  // Qwen
  [/qwen[-_]?3[-_]?coder/i, 262_144],
  [/qwen[-_]?3[-_]?max/i, 262_144],
  [/qwen[-_]?3/i, 131_072],
  [/qwen[-_]?2\.5[-_]?72b/i, 131_072],
  [/qwen[-_]?2\.5/i, 131_072],
  [/qwen[-_]?2/i, 131_072],
  [/qwen[-_]?qwq/i, 131_072],
  [/qwen/i, 32_768],
  // Cohere
  [/command[-_]?r[-_]?plus/i, 128_000],
  [/command[-_]?r/i, 128_000],
  [/command[-_]?a/i, 256_000],
  // Z.ai GLM
  [/glm[-_]?4\.6/i, 200_000],
  [/glm[-_]?4\.5/i, 131_072],
  [/glm/i, 131_072],
  // MiniMax
  [/minimax[-_]?m2/i, 204_800],
  [/minimax/i, 1_000_000],
  // Others
  [/phi[-_]?4/i, 16_384],
  [/phi[-_]?3/i, 128_000],
  [/yi[-_]?large/i, 32_768],
  [/yi[-_]?1\.5/i, 16_384],
  [/nova[-_]?pro/i, 300_000],
  [/nova[-_]?lite/i, 300_000],
  [/nova[-_]?micro/i, 128_000]
];

const DEFAULT_CONTEXT = 128_000;

/** Largest window a "-1m"-style name hint may claim, so a typo can't say 900M. */
const MAX_HINTED_CONTEXT = 20_000_000;

/**
 * Best-effort context window for a model id, without asking the provider.
 * Returns { limit, source } where source is 'name-hint' | 'known' | 'default'.
 *
 * The explicit size in an id is checked FIRST and beats the family table:
 * "deepseek-r1-distill-32k" states 32k about itself, but the deepseek family
 * pattern claims 128k, and first-match-wins used to return the family's answer
 * and throw away the model's own. Provider-reported windows still outrank
 * everything here — see contextStore.js.
 */
function lookupKnownContext(modelId) {
  const id = String(modelId || '');
  // trailing context hints: model-128k, :32k, /1m
  const hint = id.match(/(?:^|[-_/:])(\d+(?:\.\d+)?)(k|m)\b/i);
  if (hint) {
    const n = parseFloat(hint[1]);
    const mult = hint[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
    const limit = Math.round(n * mult);
    if (limit >= 1024 && limit <= MAX_HINTED_CONTEXT) {
      return { limit, source: 'name-hint' };
    }
  }
  for (const [re, limit] of CONTEXT_PATTERNS) {
    if (re.test(id)) return { limit, source: 'known' };
  }
  return { limit: DEFAULT_CONTEXT, source: 'default' };
}

function formatTokenCount(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  // The ".0" trim matters at 1M: Gemini's 1,048,576-token window rounds to
  // "1.0M" without it, next to a plain "128k" everywhere else.
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

/**
 * Rough tokenizer estimate (≈ GPT-family).
 * CJK denser; code slightly denser than prose.
 */
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // CJK Unified + Hangul + Hiragana/Katakana ranges (approx)
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  // ~1 token per CJK char; ~4 chars per token for latin; +overhead
  return Math.ceil(cjk * 1.0 + other / 4 + 2);
}

export { CONTEXT_PATTERNS, DEFAULT_CONTEXT, MAX_HINTED_CONTEXT, formatTokenCount, estimateTokens, lookupKnownContext };
