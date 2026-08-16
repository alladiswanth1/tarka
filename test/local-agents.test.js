'use strict';
/**
 * Local Claude / Codex / Grok Build agents: detect, parse, and the real
 * /api/chat branch that spawns the CLI (a fake binary — never the live tools).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  parseLocalAgentRequest,
  formatConversation,
  interpretClaudeEvent,
  interpretGrokEvent,
  consumeClaudeStream,
  consumeGrokStream,
  detectLocalAgents,
  isPassThroughModel
} = require('../lib/local-agents');
const { startTarka, readSse } = require('./helpers/harness');

const FAKE_CLAUDE = path.join(__dirname, 'helpers', 'fake-claude.js');
const FAKE_CODEX = path.join(__dirname, 'helpers', 'fake-codex.js');
const FAKE_GROK = path.join(__dirname, 'helpers', 'fake-grok.js');

test('parseLocalAgentRequest reads agent or tarka-local:// URL', () => {
  assert.equal(parseLocalAgentRequest({ agent: 'claude' }), 'claude');
  assert.equal(parseLocalAgentRequest({ agent: 'CODEX' }), 'codex');
  assert.equal(parseLocalAgentRequest({ baseURL: 'tarka-local://claude' }), 'claude');
  assert.equal(parseLocalAgentRequest({ baseURL: 'tarka-local://codex/' }), 'codex');
  assert.equal(parseLocalAgentRequest({ agent: 'grok' }), 'grok');
  assert.equal(parseLocalAgentRequest({ baseURL: 'tarka-local://grok' }), 'grok');
  assert.equal(parseLocalAgentRequest({ baseURL: 'https://api.openai.com/v1' }), null);
  assert.equal(parseLocalAgentRequest({ agent: 'hermes' }), null);
  assert.equal(parseLocalAgentRequest({}), null);
});

test('formatConversation prepends system and keeps roles', () => {
  const text = formatConversation(
    [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' }
    ],
    'Be brief.'
  );
  assert.match(text, /### SYSTEM\nBe brief/);
  assert.match(text, /### USER\nHi/);
  assert.match(text, /### ASSISTANT\nHello/);
});

test('consumeClaudeStream yields text and thinking deltas', () => {
  const chunks = [];
  const rest = consumeClaudeStream(
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }) +
      '\n' +
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hmm' }
      }) +
      '\npartial',
    (ev) => chunks.push(ev)
  );
  assert.deepEqual(chunks, [
    { kind: 'content', text: 'Hi' },
    { kind: 'reasoning', text: 'hmm' }
  ]);
  assert.equal(rest, 'partial');
  assert.equal(interpretClaudeEvent({ type: 'result', is_error: true, result: 'nope' }).kind, 'error');
});

test('consumeGrokStream yields text and thought events', () => {
  const chunks = [];
  const rest = consumeGrokStream(
    JSON.stringify({ type: 'thought', data: 'hmm' }) +
      '\n' +
      JSON.stringify({ type: 'text', data: 'Hi' }) +
      '\npartial',
    (ev) => chunks.push(ev)
  );
  assert.deepEqual(chunks, [
    { kind: 'reasoning', text: 'hmm' },
    { kind: 'content', text: 'Hi' }
  ]);
  assert.equal(rest, 'partial');
  assert.equal(interpretGrokEvent({ type: 'error', message: 'nope' }).kind, 'error');
});

test('isPassThroughModel skips the CLI default aliases', () => {
  assert.equal(isPassThroughModel('default', 'claude'), true);
  assert.equal(isPassThroughModel('claude', 'claude'), true);
  assert.equal(isPassThroughModel('opus', 'claude'), false);
  assert.equal(isPassThroughModel('gpt-5', 'codex'), false);
  assert.equal(isPassThroughModel('default', 'grok'), true);
  assert.equal(isPassThroughModel('grok-build', 'grok'), false);
});

test('detectLocalAgents reports a fake signed-in Grok Build', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-grok-'));
  await fsp.mkdir(path.join(home, '.grok'), { recursive: true });
  await fsp.writeFile(path.join(home, '.grok', 'auth.json'), '{}');
  const prevHome = process.env.TARKA_AGENT_HOME;
  const prevBin = process.env.TARKA_GROK_BIN;
  process.env.TARKA_AGENT_HOME = home;
  process.env.TARKA_GROK_BIN = FAKE_GROK;
  try {
    fs.chmodSync(FAKE_GROK, 0o755);
  } catch {
    /* windows */
  }
  try {
    const agents = await detectLocalAgents();
    const grok = agents.find((a) => a.id === 'grok');
    assert.ok(grok.installed, 'fake grok must count as installed');
    assert.equal(grok.authed, true);
    assert.equal(grok.ready, true);
    assert.equal(grok.version, '1.0.4');
  } finally {
    if (prevHome == null) delete process.env.TARKA_AGENT_HOME;
    else process.env.TARKA_AGENT_HOME = prevHome;
    if (prevBin == null) delete process.env.TARKA_GROK_BIN;
    else process.env.TARKA_GROK_BIN = prevBin;
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('detectLocalAgents reports a fake signed-in Claude', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-agent-'));
  await fsp.writeFile(path.join(home, '.claude.json'), '{}');
  const prevHome = process.env.TARKA_AGENT_HOME;
  const prevBin = process.env.TARKA_CLAUDE_BIN;
  process.env.TARKA_AGENT_HOME = home;
  process.env.TARKA_CLAUDE_BIN = process.execPath;
  // resolveBin uses TARKA_CLAUDE_BIN as the executable — that is node, which
  // has no --version matching claude. Point at the fake script instead.
  process.env.TARKA_CLAUDE_BIN = FAKE_CLAUDE;
  try {
    fs.chmodSync(FAKE_CLAUDE, 0o755);
  } catch {
    /* windows */
  }
  try {
    const agents = await detectLocalAgents();
    const claude = agents.find((a) => a.id === 'claude');
    assert.ok(claude.installed, 'fake claude must count as installed');
    assert.equal(claude.authed, true);
    assert.equal(claude.ready, true);
    assert.equal(claude.version, '1.2.3');
  } finally {
    if (prevHome == null) delete process.env.TARKA_AGENT_HOME;
    else process.env.TARKA_AGENT_HOME = prevHome;
    if (prevBin == null) delete process.env.TARKA_CLAUDE_BIN;
    else process.env.TARKA_CLAUDE_BIN = prevBin;
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('GET /api/agents/local and a Claude chat go through the shipped server', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-agent-'));
  await fsp.writeFile(path.join(home, '.claude.json'), '{}');
  await fsp.mkdir(path.join(home, '.grok'), { recursive: true });
  await fsp.writeFile(path.join(home, '.grok', 'auth.json'), '{}');
  try {
    fs.chmodSync(FAKE_GROK, 0o755);
  } catch {
    /* windows */
  }
  const tarka = await startTarka({
    TARKA_AGENT_HOME: home,
    TARKA_CLAUDE_BIN: FAKE_CLAUDE,
    TARKA_CODEX_BIN: FAKE_CODEX,
    TARKA_GROK_BIN: FAKE_GROK
  });
  try {
    const det = await fetch(`${tarka.origin}/api/agents/local`);
    assert.equal(det.status, 200);
    assert.match(det.headers.get('content-type') || '', /json/);
    const body = await det.json();
    assert.ok(Array.isArray(body.agents));
    assert.ok(body.agents.some((a) => a.id === 'claude'));
    assert.ok(body.agents.some((a) => a.id === 'codex'));
    assert.ok(body.agents.some((a) => a.id === 'grok'));

    const missing = await tarka.post('/api/chat', { agent: 'claude', messages: [] });
    assert.equal(missing.status, 400);

    const res = await tarka.post('/api/chat', {
      agent: 'claude',
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const out = await readSse(res);
    assert.equal(out.content, 'Hello from Claude');
    assert.equal(out.errors.length, 0);
    assert.ok(out.sawDone);

    const viaUrl = await readSse(
      await tarka.post('/api/chat', {
        baseURL: 'tarka-local://codex',
        model: 'default',
        messages: [{ role: 'user', content: 'hi' }]
      })
    );
    assert.equal(viaUrl.content, 'Hello from Codex');
    assert.ok(viaUrl.sawDone);

    const grok = await readSse(
      await tarka.post('/api/chat', {
        agent: 'grok',
        model: 'grok-build',
        messages: [{ role: 'user', content: 'hi' }]
      })
    );
    assert.equal(grok.content, 'Hello from Grok');
    assert.equal(grok.reasoning, 'planning');
    assert.ok(grok.sawDone);
  } finally {
    await tarka.close();
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('frontend helpers treat local profiles as keyless and refuse unsigned ones', async () => {
  const P = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', 'providers.js')).href);
  const ready = {
    id: 'local-claude',
    kind: 'local',
    agent: 'claude',
    name: 'Claude Code',
    baseURL: 'tarka-local://claude',
    apiKey: 'local-cli',
    ready: true
  };
  const dead = { ...ready, ready: false, apiKey: '' };
  const stale = { ...ready, ready: undefined };
  assert.equal(P.isLocalProvider(ready), true);
  assert.equal(P.localAgentId(ready), 'claude');
  assert.equal(P.localAgentId({ baseURL: 'tarka-local://codex' }), 'codex');
  assert.equal(P.localAgentId({ baseURL: 'tarka-local://grok' }), 'grok');
  assert.equal(P.isKnownLocalAgent('grok'), true);
  assert.equal(P.localProfileReady(ready), true);
  assert.equal(P.localProfileReady(stale), false, 'missing ready is not signed in');
  assert.equal(P.providerAccessIssue(ready, 'Nova'), null);
  assert.match(P.providerAccessIssue(dead, 'Nova'), /not signed in/);
  assert.match(P.providerAccessIssue(stale, 'Nova'), /not signed in/);
  assert.match(P.providerAccessIssue({ name: 'OpenRouter', apiKey: '' }, 'Kai'), /API key/);
  assert.equal(P.providerAccessIssue({ name: 'OpenRouter', apiKey: 'sk' }, 'Kai'), null);
  assert.equal(P.isLocalProvider({ baseURL: 'https://api.openai.com/v1' }), false);
  assert.equal(
    P.isLocalProvider({ kind: 'local', name: 'spoof', baseURL: 'https://api.openai.com/v1' }),
    false,
    'kind:local on a remote URL is not a local agent'
  );
});

test('auth detection is presence-only — credential files are never read', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local-agents.js'), 'utf8');
  assert.match(src, /existsSync\(expand\(a\)\)/);
  const reads = [...src.matchAll(/readFileSync\s*\(/g)];
  assert.equal(reads.length, 1, 'only the Codex reply temp file is read');
  assert.match(src, /readFileSync\(outFile/);
  assert.match(src, /writeFileSync\(promptFile/);
  assert.doesNotMatch(src, /readFileSync\(expand/);
  assert.doesNotMatch(src, /readFileSync\([^)]*credentials/);
  assert.doesNotMatch(src, /readFileSync\([^)]*auth\.json/);
});

test('an installed but unsigned CLI is not ready', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarka-agent-unsigned-'));
  const prevHome = process.env.TARKA_AGENT_HOME;
  const prevBin = process.env.TARKA_CLAUDE_BIN;
  process.env.TARKA_AGENT_HOME = home;
  process.env.TARKA_CLAUDE_BIN = FAKE_CLAUDE;
  try {
    fs.chmodSync(FAKE_CLAUDE, 0o755);
  } catch {
    /* windows */
  }
  try {
    const agents = await detectLocalAgents();
    const claude = agents.find((a) => a.id === 'claude');
    assert.ok(claude.installed);
    assert.equal(claude.authed, false);
    assert.equal(claude.ready, false);
  } finally {
    if (prevHome == null) delete process.env.TARKA_AGENT_HOME;
    else process.env.TARKA_AGENT_HOME = prevHome;
    if (prevBin == null) delete process.env.TARKA_CLAUDE_BIN;
    else process.env.TARKA_CLAUDE_BIN = prevBin;
    await fsp.rm(home, { recursive: true, force: true });
  }
});
