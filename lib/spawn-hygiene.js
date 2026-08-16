'use strict';
/**
 * Spawn and exit hygiene borrowed in spirit from DeepSeek Harness
 * (defensive-patterns: scrub names matching KEY, SECRET, TOKEN, PASSWORD;
 * report timedOut / signal / exitCode independently). Pure — no DOM, no spawn.
 */

const SECRET_ENV_RE = /KEY|SECRET|TOKEN|PASSWORD/i;

/**
 * Copy `env` without names that typically hold credentials.
 * PATH, HOME, LANG, and other ordinary process facts stay.
 */
function scrubSpawnEnv(env) {
  const src = env && typeof env === 'object' ? env : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (SECRET_ENV_RE.test(k)) continue;
    if (v == null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Orthogonal facts about a finished command. A process can time out AND
 * still exit 0 (it trapped the kill). Callers must not treat that as success.
 */
function commandExitFacts({ timedOut = false, signal = null, exitCode = null, aborted = false } = {}) {
  const code = exitCode == null || exitCode === '' ? null : Number(exitCode);
  const sig = signal || null;
  const timed = !!timedOut;
  const stop = !!aborted;
  return {
    timedOut: timed,
    signal: sig,
    exitCode: Number.isFinite(code) ? code : null,
    aborted: stop,
    cleanSuccess: !timed && !stop && !sig && code === 0
  };
}

module.exports = { SECRET_ENV_RE, scrubSpawnEnv, commandExitFacts };
