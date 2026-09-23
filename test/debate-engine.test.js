'use strict';
/**
 * The real runDebate round loop, driven against a fake provider.
 *
 * engine.js is DOM-bound through its imports, so this loads its source with
 * the import lines swapped for injected values: the pure protocol modules are
 * the real ones, every UI helper is a recording stub. What is under test is
 * the schedule — who runs concurrently, what each seat reads, and when the
 * team is considered agreed — which is exactly what the parallel turn order
 * changes and what the round-robin order must keep doing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SRC = path.join(__dirname, '..', 'public', 'src');
const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

/** Every name engine.js imports, with the module it comes from. */
function importedNames(source) {
  const out = [];
  for (const m of source.matchAll(/^import \{([^}]*)\} from '([^']+)';$/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) out.push({ name, from: m[2] });
    }
  }
  return out;
}

async function loadRunDebate(stubs) {
  const D = await load('debate/protocol.js');
  const P = await load('project/protocol.js');
  const T = await load('tokens.js');
  const real = { '../debate/protocol.js': D, '../project/protocol.js': P, '../tokens.js': T };
  let source = fs.readFileSync(path.join(SRC, 'debate', 'engine.js'), 'utf8');
  const names = importedNames(source);
  source = source.replace(/^import .*;$/gm, '').replace(/^export .*;$/gm, '');
  // abortController is a live binding the engine reassigns through its setter
  const local = new Set(['abortController', 'setAbortController']);
  const params = [];
  const values = [];
  for (const { name, from } of names) {
    if (local.has(name)) continue;
    params.push(name);
    if (real[from] && name in real[from]) values.push(real[from][name]);
    else if (name in stubs) values.push(stubs[name]);
    else values.push(() => {});
  }
  const body =
    'let abortController = null;\n' +
    'const setAbortController = (v) => (abortController = v);\n' +
    `${source}\nreturn runDebate;`;
  // eslint-disable-next-line no-new-func
  return new Function(...params, body)(...values);
}

function fakeArena() {
  const notes = [];
  const dividers = [];
  return {
    notes,
    dividers,
    el: {},
    finalized: false,
    setRound() {},
    setSpeaking() {},
    setAllSpeaking() {},
    setSeatStatus() {},
    setSeatDropped() {},
    setPresenting() {},
    setJudging() {},
    setTokens() {},
    addRoundDivider(n, opts) {
      dividers.push({ n, ...opts });
    },
    addNote(t) {
      notes.push(t);
    },
    addTurn() {
      return { el: { classList: { add() {} } }, update() {}, updateReasoning() {}, settleReasoning() {}, finish() {}, reset() {} };
    },
    finalize() {
      this.finalized = true;
    },
    stopTimer() {}
  };
}

/**
 * A provider whose experts answer from `vote(seatName, round)` and whose
 * presenter writes a fixed deliverable. Each call takes a few ms so that
 * concurrent calls genuinely overlap.
 */
async function runWith({ turnOrder, consensusMode = 'all', maxRounds = 4, vote }) {
  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  const perRoundInflight = new Map();
  const provider = { id: 'p1', baseURL: 'http://x/v1', apiKey: 'k' };
  const experts = ['Ada', 'Bo', 'Cy'].map((name, i) => ({ name, persona: 'p', model: `m${i}`, providerId: 'p1' }));
  const settings = {
    experts,
    maxRounds,
    roundMode: 'fixed',
    consensusMode,
    turnOrder,
    expertReasoning: 'off',
    finalAnswerMode: 'nominated',
    judge: {}
  };
  const history = [];
  const arena = fakeArena();
  const seatRounds = new Map();
  const streamCompletion = async ({ systemPrompt, messages, onToken }) => {
    const user = messages[0].content;
    const presenter = /The discussion is over/.test(systemPrompt);
    const who = /^You are ([^,]+),/.exec(systemPrompt)[1];
    const round = presenter ? 0 : (seatRounds.get(who) || 0) + 1;
    if (!presenter) seatRounds.set(who, round);
    calls.push({ who, round, presenter, system: systemPrompt, user });
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    perRoundInflight.set(round, Math.max(perRoundInflight.get(round) || 0, inflight));
    await new Promise((r) => setTimeout(r, 15));
    inflight--;
    const text = presenter
      ? 'Final deliverable.'
      : `${who} round ${round} take.\n${vote(who, round) === 'agree' ? '[STATUS: AGREE | NOMINATE: Bo]' : '[STATUS: CONTINUE]'}`;
    onToken(text, text);
    return { content: text, error: null, cancelled: false };
  };
  const stubs = {
    debateSettings: settings,
    providers: [provider],
    messages: [{ role: 'user', content: 'the task' }],
    chatSession: 0,
    activeSessionId: 's1',
    stickToBottom: true,
    statusText: { textContent: '', classList: { add() {}, remove() {} } },
    tokenInfo: { textContent: '' },
    userInput: { focus() {} },
    READY_STATUS: 'Ready',
    contextLimitFor: () => ({ limit: 128000 }),
    getContextUsage: () => ({ pct: 0, limit: 128000 }),
    warmProviderCatalogs: async () => {},
    appendMessage: () => ({
      msgEl: {},
      bubble: { classList: { add() {}, remove() {} }, remove() {} },
      body: { insertBefore() {} }
    }),
    createDebateArena: () => arena,
    buildDebateCredit: () => ({}),
    createStreamRenderer: () => ({ update() {}, finish() {}, finishPlain() {}, cancel() {} }),
    pushHistoryMessage: (role, content) => {
      const m = { role, content };
      history.push(m);
      return m;
    },
    localAgentId: () => null,
    sleep: async () => {},
    streamCompletion,
    streamResultError: (r) => new Error(r.error),
    isTransientProviderError: () => false
  };
  const runDebate = await loadRunDebate(stubs);
  await runDebate({ maxTokens: 800, temperature: 0.2, reasoningEffort: 'none' }, 'the task');
  return { calls, maxInflight, perRoundInflight, history, arena };
}

test('parallel turn order runs every round concurrently over the previous rounds only', async () => {
  const r = await runWith({
    turnOrder: 'parallel',
    vote: (who, round) => (round >= 2 ? 'agree' : 'continue')
  });
  const experts = r.calls.filter((c) => !c.presenter);
  assert.equal(experts.length, 6, 'two rounds of three, then consensus');
  assert.equal(r.perRoundInflight.get(2), 3, 'round 2 must run all three seats at once');
  for (const c of experts.filter((x) => x.round === 2)) {
    for (const name of ['Ada', 'Bo', 'Cy']) {
      assert.match(c.user, new RegExp(`${name} round 1 take`), `${c.who} reads ${name}'s round-1 take`);
      assert.doesNotMatch(c.user, new RegExp(`${name} round 2 take`), 'nobody reads a simultaneous turn');
    }
    assert.match(c.system, /same time/, 'the prompt says how the round works');
  }
  const record = r.history.at(-1).debate;
  assert.equal(record.turnOrder, 'parallel');
  assert.equal(record.consensus, true);
  assert.equal(record.rounds, 2);
  assert.ok(r.arena.dividers.some((d) => d.n === 2 && d.parallel));
});

test('in a parallel round one CONTINUE does not erase simultaneous AGREEs', async () => {
  const r = await runWith({
    turnOrder: 'parallel',
    consensusMode: 'majority',
    // Cy — LAST in seat order, so a round-robin reset would wipe the other
    // two — holds out while Ada and Bo agree in the same round
    vote: (who, round) => (round >= 2 && who !== 'Cy' ? 'agree' : 'continue')
  });
  const record = r.history.at(-1).debate;
  assert.equal(record.consensus, true, '2 of 3 agreeing in one round is a majority');
  assert.equal(record.rounds, 2);
});

test('round-robin order is unchanged: one seat at a time, each reading this round so far', async () => {
  const r = await runWith({
    turnOrder: 'sequential',
    vote: (who, round) => (round >= 2 ? 'agree' : 'continue')
  });
  assert.equal(r.perRoundInflight.get(1), 3, 'the blind opening round is still parallel');
  assert.equal(r.perRoundInflight.get(2), 1, 'later rounds take turns');
  const cy2 = r.calls.find((c) => c.who === 'Cy' && c.round === 2);
  assert.match(cy2.user, /Ada round 2 take/, 'a later seat reads the earlier turns of its own round');
  assert.doesNotMatch(cy2.system, /same time/);
  const record = r.history.at(-1).debate;
  assert.equal(record.turnOrder, undefined, 'round-robin records stay as they were');
  assert.equal(record.consensus, true);
});

test('parallel rounds finish the schedule in far fewer sequential waits', async () => {
  const vote = () => 'continue';
  const par = await runWith({ turnOrder: 'parallel', maxRounds: 3, vote });
  const seq = await runWith({ turnOrder: 'sequential', maxRounds: 3, vote });
  // Same number of calls either way; the difference is what waits on what
  assert.equal(par.calls.length, seq.calls.length);
  assert.equal(par.calls.filter((c) => !c.presenter).length, 9);
  assert.equal(par.perRoundInflight.get(3), 3);
  assert.equal(seq.perRoundInflight.get(3), 1);
});
