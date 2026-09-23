'use strict';
/**
 * Local coding-agent CLIs (Claude Code, Codex) used as Tarka providers.
 *
 * Same idea as a pasted API key: the operator already signed in on this
 * machine. We never read credential bytes — only the PRESENCE of the CLI's
 * own auth artifact — then spawn the binary and stream its reply as the
 * same SSE the HTTP proxy emits.
 *
 * Loopback-only at the route. Child env strips Tarka's own provider keys so
 * the CLI uses its native login, not whatever is in the chat request.
 */
const { execFile, execFileSync, spawn } = require('child_process');
const { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('fs');
const { homedir, tmpdir, userInfo } = require('os');
const { join } = require('path');
const { createSseCoalescer } = require('./http');
const { SSE_KEEPALIVE_MS } = require('./config');
const { scrubSpawnEnv } = require('./spawn-hygiene');

const LOCAL_AGENT_IDS = ['claude', 'codex', 'grok'];

const PROVIDER_ENV_TO_STRIP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORGANIZATION',
  'OPENROUTER_API_KEY'
];

const DEFAULT_MODELS = {
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

function agentHome() {
  const override = String(process.env.TARKA_AGENT_HOME || '').trim();
  if (override) return override;
  try {
    const real = userInfo().homedir;
    if (real) return real;
  } catch {
    /* sandboxed */
  }
  return homedir();
}

const expand = (p) => (p.startsWith('~') ? agentHome() + p.slice(1) : p);

function childEnv(opts = {}) {
  const env = scrubSpawnEnv(process.env);
  // Named Anthropic/OpenAI knobs that do not match *KEY*/*TOKEN* (e.g. BASE_URL)
  for (const k of PROVIDER_ENV_TO_STRIP) delete env[k];
  const home = agentHome();
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;
  // Grok's own API-key login is XAI_API_KEY. Scrub drops *KEY*; put only that
  // one back so the CLI can sign in the way it already does on this machine.
  if (opts.keepXaiKey && process.env.XAI_API_KEY && !process.env.TARKA_AGENT_HOME) {
    env.XAI_API_KEY = process.env.XAI_API_KEY;
  }
  // When Tarka isolated $HOME, Grok must not still read the operator's
  // real ~/.grok. Leave GROK_HOME alone otherwise — the user may have set it.
  if (process.env.TARKA_AGENT_HOME) env.GROK_HOME = join(home, '.grok');
  return env;
}

function wellKnownBinDirs(home) {
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.asdf', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.grok', 'bin'),
    '/opt/local/bin'
  ];
  try {
    for (const v of readdirSync(join(home, '.nvm', 'versions', 'node'))) {
      dirs.push(join(home, '.nvm', 'versions', 'node', v, 'bin'));
    }
  } catch {
    /* no nvm */
  }
  return dirs;
}

function envBinOverride(id) {
  if (id === 'claude') return String(process.env.TARKA_CLAUDE_BIN || '').trim();
  if (id === 'codex') return String(process.env.TARKA_CODEX_BIN || '').trim();
  if (id === 'grok') return String(process.env.TARKA_GROK_BIN || '').trim();
  return '';
}

function resolveBin(bin, id) {
  const override = id ? envBinOverride(id) : '';
  if (override) return override;
  if (bin.includes('/') || bin.includes('\\')) return bin;
  const pathEnv = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of [...pathEnv.split(sep), ...wellKnownBinDirs(agentHome())]) {
    if (!dir || (process.platform !== 'win32' && !dir.startsWith('/'))) continue;
    const cand = join(dir, bin);
    try {
      accessSync(cand, constants.X_OK);
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* keep scanning */
    }
  }
  return bin;
}

const SPECS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    // `~/.claude.json` is NOT an auth artifact: it is the CLI's config/cache,
    // created on first launch whether or not the login completed. Treating it
    // as "signed in" offered a seat that then failed at runtime.
    authArtifacts: ['~/.claude/.credentials.json'],
    keychainService: 'Claude Code-credentials',
    versionArgs: ['--version']
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    authArtifacts: ['~/.codex/auth.json', '~/.config/codex/auth.json'],
    versionArgs: ['--version']
  },
  grok: {
    id: 'grok',
    label: 'Grok Build',
    bin: 'grok',
    authArtifacts: ['~/.grok/auth.json'],
    versionArgs: ['--version']
  }
};

function authState(spec) {
  for (const a of spec.authArtifacts) {
    if (existsSync(expand(a))) return { authed: true, method: 'file' };
  }
  // Grok also honors GROK_HOME/auth.json and XAI_API_KEY. Presence only.
  // Skip those fallbacks when TARKA_AGENT_HOME is set so tests stay isolated.
  if (spec.id === 'grok' && !String(process.env.TARKA_AGENT_HOME || '').trim()) {
    const grokHome = String(process.env.GROK_HOME || '').trim();
    if (grokHome && existsSync(join(grokHome, 'auth.json'))) {
      return { authed: true, method: 'file' };
    }
    if (String(process.env.XAI_API_KEY || '').trim()) {
      return { authed: true, method: 'env' };
    }
  }
  if (spec.keychainService && process.platform === 'darwin') {
    try {
      execFileSync('security', ['find-generic-password', '-s', spec.keychainService], {
        stdio: 'ignore',
        timeout: 2000
      });
      return { authed: true, method: 'keychain' };
    } catch {
      /* not in keychain */
    }
  }
  return { authed: false };
}

function parseVersion(out) {
  return (String(out || '').match(/[\d]+\.[\d]+(?:\.[\d]+)?/) || ['?'])[0];
}

function detectOne(spec) {
  const exe = resolveBin(spec.bin, spec.id);
  return new Promise((resolve) => {
    const base = {
      id: spec.id,
      label: spec.label,
      bin: spec.bin,
      installed: false,
      authed: false,
      ready: false
    };
    try {
      execFile(exe, spec.versionArgs, { timeout: 8000, env: childEnv() }, (err, stdout) => {
        if (err && err.code === 'ENOENT') {
          resolve(base);
          return;
        }
        const auth = authState(spec);
        resolve({
          ...base,
          installed: true,
          path: exe !== spec.bin ? exe : undefined,
          version: parseVersion(stdout),
          authed: auth.authed,
          authMethod: auth.method,
          ready: auth.authed,
          models: DEFAULT_MODELS[spec.id]
        });
      });
    } catch {
      const auth = authState(spec);
      resolve({
        ...base,
        installed: true,
        version: '?',
        authed: auth.authed,
        authMethod: auth.method,
        ready: auth.authed,
        models: DEFAULT_MODELS[spec.id]
      });
    }
  });
}

async function detectLocalAgents() {
  const settled = await Promise.allSettled(LOCAL_AGENT_IDS.map((id) => detectOne(SPECS[id])));
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const spec = SPECS[LOCAL_AGENT_IDS[i]];
    return {
      id: spec.id,
      label: spec.label,
      bin: spec.bin,
      installed: false,
      authed: false,
      ready: false
    };
  });
}

/**
 * Which local CLI a chat/models request is asking for.
 * Accepts `agent: "claude"|"codex"|"grok"` or `baseURL: "tarka-local://claude"`.
 */
function parseLocalAgentRequest(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const raw = String(body.agent || '').trim().toLowerCase();
  if (LOCAL_AGENT_IDS.includes(raw)) return raw;
  const base = String(body.baseURL || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
  const m = /^tarka-local:\/\/([a-z0-9-]+)$/.exec(base);
  if (m && LOCAL_AGENT_IDS.includes(m[1])) return m[1];
  return null;
}

function isPassThroughModel(id, agent) {
  const m = String(id || '').trim();
  if (!m) return true;
  const lower = m.toLowerCase();
  return (
    lower === 'default' ||
    lower === agent ||
    lower === `local-${agent}` ||
    lower === SPECS[agent].label.toLowerCase()
  );
}

function formatConversation(messages, systemPrompt) {
  const parts = [];
  const sys = String(systemPrompt || '').trim();
  const list = Array.isArray(messages) ? messages : [];
  const hasSystem = list.some((m) => m && m.role === 'system' && String(m.content || '').trim());
  if (sys && !hasSystem) parts.push(`### SYSTEM\n${sys}`);
  for (const m of list) {
    if (!m) continue;
    const role = String(m.role || 'user').toUpperCase();
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    parts.push(`### ${role}\n${content}`);
  }
  return parts.join('\n\n');
}

function interpretClaudeEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'content_block_delta') {
    const d = obj.delta || {};
    if (d.type === 'text_delta' && d.text) return { kind: 'content', text: String(d.text) };
    if (d.type === 'thinking_delta' && (d.thinking || d.text)) {
      return { kind: 'reasoning', text: String(d.thinking || d.text) };
    }
  }
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    const text = obj.message.content
      .filter((p) => p && p.type === 'text')
      .map((p) => p.text || '')
      .join('');
    const think = obj.message.content
      .filter((p) => p && (p.type === 'thinking' || p.type === 'reasoning'))
      .map((p) => p.thinking || p.text || '')
      .join('');
    if (text || think) return { kind: 'snapshot', text, think };
  }
  if (obj.type === 'result') {
    if (obj.is_error) return { kind: 'error', text: String(obj.result || obj.error || 'claude error') };
    if (obj.result) return { kind: 'final', text: String(obj.result) };
  }
  return null;
}

function interpretGrokEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'text' && obj.data) return { kind: 'content', text: String(obj.data) };
  if (obj.type === 'thought' && obj.data) return { kind: 'reasoning', text: String(obj.data) };
  if (obj.type === 'error') {
    return { kind: 'error', text: String(obj.message || obj.error || 'grok error') };
  }
  if (obj.type === 'end' && obj.text && !obj.is_error) {
    return { kind: 'final', text: String(obj.text) };
  }
  return null;
}

function consumeNdjsonStream(buffer, interpret, onEvent) {
  let rest = String(buffer || '');
  let nl;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = interpret(obj);
    if (ev) onEvent(ev);
  }
  return rest;
}

function consumeClaudeStream(buffer, onEvent) {
  return consumeNdjsonStream(buffer, interpretClaudeEvent, onEvent);
}

function consumeGrokStream(buffer, onEvent) {
  return consumeNdjsonStream(buffer, interpretGrokEvent, onEvent);
}

function timeoutMs() {
  const n = Number(process.env.TARKA_LOCAL_AGENT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

function beginSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const keepAlive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
  }, SSE_KEEPALIVE_MS);
  keepAlive.unref();
  return keepAlive;
}

function finishSse(res, keepAlive, kill) {
  clearInterval(keepAlive);
  if (typeof kill === 'function') kill();
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/**
 * Spawn the local CLI and stream its reply as Tarka SSE
 * (`content` / `reasoning` / `error` / `done`).
 */
function streamLocalAgentChat(res, { agent, messages, systemPrompt, model }) {
  const spec = SPECS[agent];
  const prompt = formatConversation(messages, systemPrompt);
  const exe = resolveBin(spec.bin, spec.id);
  const env = childEnv({ keepXaiKey: agent === 'grok' });
  const limit = timeoutMs();
  const isWin = process.platform === 'win32';

  // Everything that can throw (a full or unwritable tmpdir) happens BEFORE the
  // SSE headers go out. Once beginSse has run, a throw reaches route()'s catch
  // with headersSent already true: the client gets a 200 stream with no
  // error event and the keep-alive interval is never cleared.
  let workDir = null;
  let outFile = null;
  let args;
  let viaStdin = true;
  try {
    // Every CLI gets a throwaway working directory. The prompt is the debate
    // transcript — text produced by OTHER models — so the seat must not treat
    // Tarka's own checkout (or wherever `node server.js` was launched) as its
    // project: Claude Code walks up for .claude/settings and .mcp.json, Codex
    // and Grok look for .git. This seat is a language model, not a second
    // Project Mode.
    workDir = mkdtempSync(join(tmpdir(), `tarka-${agent}-`));
    if (agent === 'claude') {
      args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        // Deltas only arrive with this flag; without it the whole reply lands
        // in one `assistant` snapshot at the end.
        '--include-partial-messages',
        '--max-turns',
        '1',
        // "" disables every built-in tool. With --max-turns 1 a tool call
        // would end the run as error_max_turns anyway, so the model deciding a
        // question deserved a lookup used to come back as a blank seat.
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        'user'
      ];
      if (!isPassThroughModel(model, 'claude')) args.push('--model', String(model).trim());
    } else if (agent === 'grok') {
      // grok -p does not read stdin. --prompt-file keeps long debates off argv.
      const promptFile = join(workDir, 'prompt.txt');
      writeFileSync(promptFile, prompt);
      viaStdin = false;
      args = [
        '--prompt-file',
        promptFile,
        '--output-format',
        'streaming-json',
        '--max-turns',
        '1',
        '--no-auto-update',
        '--disable-web-search',
        '--disallowed-tools',
        'run_terminal_cmd,search_replace,write',
        '--cwd',
        workDir
      ];
      if (!isPassThroughModel(model, 'grok')) args.push('-m', String(model).trim());
    } else {
      outFile = join(workDir, 'reply.txt');
      args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--color',
        'never',
        '-C',
        workDir,
        '--output-last-message',
        outFile
      ];
      if (!isPassThroughModel(model, 'codex')) args.push('-m', String(model).trim());
    }
  } catch (e) {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Could not prepare ${spec.label}: ${e.message}` }));
    return;
  }

  const keepAlive = beginSse(res);
  // A stdout chunk can hold many partial-message deltas; each chunk's text
  // leaves as one event per type, flushed before anything else is written.
  const out = createSseCoalescer(res);

  // Its own process group, like projectExec: Claude's MCP servers and Codex's
  // sandbox helper are grandchildren, and child.kill() never reaches them —
  // after Stop or the timeout they lived on holding the inherited stdout pipe.
  const child = spawn(exe, args, {
    env,
    cwd: workDir,
    detached: !isWin,
    stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
  });
  let outTail = '';
  let errOut = '';
  let lineBuf = '';
  let streamed = '';
  let usedDeltas = false;
  let lastEventText = '';
  let done = false;
  let killTimer = null;

  const signalTree = (sig) => {
    try {
      if (!isWin && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  // TERM first so Claude Code can flush its session file; KILL if it lingers.
  const killTree = () => {
    if (child.exitCode != null || child.signalCode != null) return;
    signalTree('SIGTERM');
    killTimer = setTimeout(() => signalTree('SIGKILL'), 1500);
    killTimer.unref();
  };

  const cleanupDir = () => {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };

  const finish = (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cleanupDir();
    if (err) out.write({ type: 'error', error: String(err).slice(0, 800) });
    else out.write({ type: 'done' });
    finishSse(res, keepAlive, killTree);
  };

  const timer = setTimeout(() => {
    finish(`${agent} timed out after ${limit}ms`);
  }, limit);

  res.on('close', () => {
    if (!done) {
      done = true;
      clearTimeout(timer);
      killTree();
      cleanupDir();
      clearInterval(keepAlive);
    }
  });

  const emitContent = (text) => {
    if (!text) return;
    streamed += text;
    out.push('content', text);
  };

  child.stdout.on('data', (chunk) => {
    const s = String(chunk);
    // Only ever shown as an error excerpt — keep a tail, not the whole stream.
    outTail = (outTail + s).slice(-64_000);
    if (agent !== 'claude' && agent !== 'grok') return;
    lineBuf += s;
    // The line buffer only shrinks on a newline. A CLI build that ignores the
    // output-format flag and prints plain text would grow it without bound.
    if (lineBuf.length > 1_000_000) {
      lineBuf = '';
      finish(`${spec.label} sent 1MB without a line break — is --output-format supported by this version?`);
      killTree();
      return;
    }
    const consume = agent === 'grok' ? consumeGrokStream : consumeClaudeStream;
    lineBuf = consume(lineBuf, (ev) => {
      if (ev.kind === 'content') {
        usedDeltas = true;
        emitContent(ev.text);
      } else if (ev.kind === 'reasoning') {
        out.push('reasoning', ev.text);
      } else if (ev.kind === 'snapshot' && !usedDeltas) {
        if (ev.think) out.push('reasoning', ev.think);
        if (ev.text && ev.text.length > streamed.length) {
          emitContent(ev.text.slice(streamed.length));
        }
      } else if (ev.kind === 'final') {
        lastEventText = ev.text;
        if (!streamed) emitContent(ev.text);
      } else if (ev.kind === 'error') {
        lastEventText = ev.text;
        finish(ev.text);
      }
    });
    out.flush();
  });
  child.stderr.on('data', (chunk) => {
    if (errOut.length < 200_000) errOut += String(chunk);
  });
  child.on('error', (e) => {
    const msg =
      e.code === 'ENOENT'
        ? `${spec.label} is not installed (no \`${spec.bin}\` on PATH)`
        : e.message;
    finish(msg);
  });
  child.on('close', (code, signal) => {
    clearTimeout(killTimer);
    if (done) return;
    // Codex writes its answer to a file rather than stdout.
    if (outFile) {
      let content = '';
      try {
        content = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* fall back to whatever streamed */
      }
      if (content.length > streamed.length) emitContent(content.slice(streamed.length));
    }
    if (code === 0) {
      finish(streamed ? null : `${spec.label} returned an empty reply`);
      return;
    }
    // stderr first; then the CLI's own result/error text; never the raw NDJSON
    // (it starts with an init event listing the cwd and tool set).
    const why =
      errOut.trim() ||
      lastEventText.trim() ||
      (/^\s*\{/.test(outTail) ? '' : outTail.trim()) ||
      `${spec.label} exited ${code == null ? `on ${signal || 'signal'}` : code}`;
    finish(why.slice(0, 800));
  });

  if (child.stdin) {
    // A CLI that exits before draining stdin (not signed in, bad --model, an
    // unknown flag after an upgrade) makes the queued write fail with EPIPE,
    // which is an 'error' EVENT on the stream — not a rejection route() can
    // catch. Unhandled, it took the whole process down; 'close' reports why.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  }
}

function localAgentModels(id) {
  return DEFAULT_MODELS[id] ? DEFAULT_MODELS[id].slice() : [];
}

module.exports = {
  LOCAL_AGENT_IDS,
  DEFAULT_MODELS,
  agentHome,
  detectLocalAgents,
  parseLocalAgentRequest,
  formatConversation,
  interpretClaudeEvent,
  interpretGrokEvent,
  consumeClaudeStream,
  consumeGrokStream,
  isPassThroughModel,
  streamLocalAgentChat,
  localAgentModels,
  resolveBin
};
