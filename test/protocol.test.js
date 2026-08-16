'use strict';
/**
 * The two machine-read contracts: Debate's status line and Project's handoff
 * marker + context trim. Both are pure modules; both decide whether a run
 * reaches consensus or declares itself done, so a tolerant-parse regression
 * here is a correctness regression, not a cosmetic one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (rel) =>
  import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', rel)).href);

let D;
let P;
test.before(async () => {
  D = await load('debate/protocol.js');
  P = await load('project/protocol.js');
});

/* ---------------- debate ---------------- */

test('parseDebateStatus reads the plain contract', () => {
  const r = D.parseDebateStatus('My take.\n[STATUS: AGREE | NOMINATE: Kai]');
  assert.equal(r.status, 'agree');
  assert.equal(r.nominee, 'Kai');
  assert.equal(r.cleanText, 'My take.');

  const c = D.parseDebateStatus('Still unresolved.\n[STATUS: CONTINUE]');
  assert.equal(c.status, 'continue');
  assert.equal(c.nominee, null);
  assert.equal(c.cleanText, 'Still unresolved.');
});

test('parseDebateStatus tolerates the decoration models actually emit', () => {
  const variants = [
    'x\n**[STATUS: AGREE | NOMINATE: Kai]**',
    'x\n`[STATUS: AGREE | NOMINATE: Kai]`',
    'x\n[status: agree | nominate: Kai]',
    'x\n[STATUS:AGREE|NOMINATE:Kai]',
    'x\n[STATUS: AGREE | NOMINATE: Kai]   \n\n',
    'x\nSTATUS: AGREE | NOMINATE: Kai',
    'x\n~~[STATUS: AGREE | NOMINATE: Kai]~~'
  ];
  for (const v of variants) {
    const r = D.parseDebateStatus(v);
    assert.equal(r.status, 'agree', v);
    assert.equal(r.nominee, 'Kai', v);
    assert.equal(r.cleanText, 'x', v);
  }
});

/* Silence is not agreement — the rule the consensus check leans on. */
test('an unparseable turn counts as CONTINUE', () => {
  for (const t of ['just prose', '', 'I agree with everyone!', '[STATUS: MAYBE]']) {
    assert.equal(D.parseDebateStatus(t).status, 'continue', t);
  }
});

test('a status marker buried mid-message is not read as the turn’s verdict', () => {
  const text = 'Earlier I wrote [STATUS: AGREE] but I have changed my mind.\n[STATUS: CONTINUE]';
  assert.equal(D.parseDebateStatus(text).status, 'continue');
});

test('stripStreamingStatusTail hides a marker as it is being typed', () => {
  assert.equal(D.stripStreamingStatusTail('answer\n[STAT'), 'answer');
  assert.equal(D.stripStreamingStatusTail('answer\n['), 'answer');
  assert.equal(D.stripStreamingStatusTail('answer\n**[STATUS'), 'answer');
  // ...but must not eat ordinary prose or markdown lists
  assert.equal(D.stripStreamingStatusTail('answer\nnormal line'), 'answer\nnormal line');
  assert.equal(D.stripStreamingStatusTail('answer'), 'answer');
});

/*
 * Regression: the check only ever looked at the text after the LAST newline, so
 * the moment a model finished its marker and emitted one more newline the
 * "last line" became empty and the completed [STATUS: …] line was handed back —
 * flashing the machine-read marker into the arena mid-stream.
 */
test('stripStreamingStatusTail keeps hiding a marker once it is complete', () => {
  assert.equal(D.stripStreamingStatusTail('answer\n[STATUS: AGREE | NOMINATE: Kai]\n'), 'answer');
  assert.equal(D.stripStreamingStatusTail('answer\n[STATUS: CONTINUE]\n\n'), 'answer');
  // Trailing blank lines after ordinary prose are still ordinary prose, and
  // degenerate input must terminate rather than spin (lastIndexOf clamps a
  // negative start to 0, which is an easy infinite loop here).
  assert.equal(D.stripStreamingStatusTail('answer\nnormal line\n'), 'answer\nnormal line\n');
  assert.equal(D.stripStreamingStatusTail('- a\n- b\n'), '- a\n- b\n');
  assert.equal(D.stripStreamingStatusTail('\n\n'), '\n\n');
  assert.equal(D.stripStreamingStatusTail(''), '');
});

test('matchSeatByName resolves exact then fuzzy, and gives up cleanly', () => {
  const seats = [{ name: 'Kai', i: 0 }, { name: 'Dr. Reyes', i: 1 }];
  assert.equal(D.matchSeatByName('Kai', seats).i, 0);
  assert.equal(D.matchSeatByName('kai', seats).i, 0);
  assert.equal(D.matchSeatByName('Reyes', seats).i, 1);
  assert.equal(D.matchSeatByName('Nobody', seats), null);
  assert.equal(D.matchSeatByName(null, seats), null);
});

test('pickDebatePresenter counts nominations and never picks a dropped seat', () => {
  const a = { name: 'A', i: 0, dropped: false };
  const b = { name: 'B', i: 1, dropped: false };
  const c = { name: 'C', i: 2, dropped: false };
  a.nominee = b; b.nominee = b; c.nominee = a;
  assert.equal(D.pickDebatePresenter([a, b, c]).name, 'B');

  // A dropped nominee is a dead endpoint — do not hand it the final answer
  const d = { name: 'D', i: 3, dropped: true };
  const e = { name: 'E', i: 4, dropped: false, nominee: null };
  e.nominee = d;
  const pick = D.pickDebatePresenter([d, e]);
  assert.equal(pick.dropped, false);

  // No nominations at all still yields someone
  assert.ok(D.pickDebatePresenter([{ name: 'Z', i: 0, dropped: false, nominee: null }]));
});

/*
 * Regression: restoring a debate from history resolved each turn's speaker as
 * `seats[turn.i]`. But `record.experts` holds only the seats still live at the
 * end while `turn.i` is the ORIGINAL seat index, so one dropout shifted every
 * later index — a three-way debate restored as a monologue by one expert.
 */
test('a restored turn is attributed to whoever actually spoke it', () => {
  // Nova (seat 0) dropped; Kai (1) and Rhea (2) finished the debate, so the
  // stored roster is two names long while the turns still carry indexes 1 and 2.
  const seats = ['Kai', 'Rhea'].map((name, i) => ({ name, i }));
  const turns = [
    { name: 'Kai', i: 1, round: 1 },
    { name: 'Rhea', i: 2, round: 1 },
    { name: 'Kai', i: 1, round: 2 }
  ];
  assert.deepEqual(
    turns.map((t) => D.debateTurnSpeaker(t, seats).name),
    ['Kai', 'Rhea', 'Kai'],
    'every turn keeps its real speaker after a dropout'
  );

  // The index still drives the colour, even when it points past the roster.
  assert.equal(D.debateTurnSpeaker({ name: 'Rhea', i: 2 }, seats).i, 2);

  // Records written before turns carried an index fall back to the name, and a
  // turn naming nobody must not throw.
  assert.equal(D.debateTurnSpeaker({ name: 'Rhea' }, seats).i, 1);
  assert.equal(D.debateTurnSpeaker({ name: 'Ghost' }, seats).i, 0);
  assert.equal(D.debateTurnSpeaker({ i: 0 }, seats).name, 'Kai');
  assert.equal(D.debateTurnSpeaker({}, []).name, '?');
});

test('formatDebateTranscript drops oldest turns and says how many', () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({ name: `S${i}`, text: 'x'.repeat(400) }));
  const full = D.formatDebateTranscript(turns);
  assert.equal(full.omitted, 0);

  const trimmed = D.formatDebateTranscript(turns, 1200);
  assert.ok(trimmed.omitted > 0, 'should have dropped turns');
  assert.match(trimmed.text, /earlier turns? omitted/);
  assert.ok(trimmed.text.includes('S7'), 'the newest turn is always kept');
});

/* ---------------- project ---------------- */

test('parseAgentResponse extracts tool blocks and leaves prose behind', () => {
  const out = P.parseAgentResponse(
    'Working on it.\n```tool\n{"tool":"read_file","path":"a.js"}\n```\nDone.\n' +
      '[TURN: HANDOFF | TO: auto | STATUS: working | NOTE: read the entry point]'
  );
  assert.equal(out.blocks.length, 1);
  assert.deepEqual(out.blocks[0].spec, { tool: 'read_file', path: 'a.js' });
  assert.equal(out.handoff.status, 'working');
  assert.equal(out.handoff.to, 'auto');
  assert.match(out.prose, /Working on it/);
  assert.doesNotMatch(out.prose, /read_file/);
});

test('malformed tool JSON is reported, not silently swallowed', () => {
  const out = P.parseAgentResponse('```tool\n{not json}\n```');
  assert.equal(out.blocks.length, 1);
  assert.match(out.blocks[0].err, /Invalid JSON/);
});

test('write / append / edit fences require a path', () => {
  const w = P.parseAgentResponse('```write src/a.js\nhello\n```');
  assert.equal(w.blocks[0].path, 'src/a.js');
  assert.equal(w.blocks[0].content, 'hello\n');

  const missing = P.parseAgentResponse('```write\nhello\n```');
  assert.match(missing.blocks[0].err, /Missing path/);

  const e = P.parseAgentResponse(
    '```edit a.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```'
  );
  assert.deepEqual(e.blocks[0].edits, [{ find: 'old', replace: 'new' }]);

  const noSections = P.parseAgentResponse('```edit a.js\njust text\n```');
  assert.match(noSections.blocks[0].err, /No SEARCH\/REPLACE/);
});

test('the handoff marker is parsed as tolerantly as the debate one', () => {
  for (const v of [
    '**[TURN: HANDOFF | TO: Ada | STATUS: done | NOTE: shipped]**',
    '[turn: handoff | to: Ada | status: done | note: shipped]',
    '[TURN:HANDOFF|TO:Ada|STATUS:done|NOTE:shipped]'
  ]) {
    const h = P.parseAgentResponse('work\n' + v).handoff;
    assert.ok(h, v);
    assert.equal(h.status, 'done', v);
    assert.equal(h.to, 'Ada', v);
  }
  assert.equal(P.parseAgentResponse('no marker here').handoff, null);
});

/*
 * Regression: the marker was matched against a fixed 260-char tail. The prompt
 * asks for a NOTE of ≤15 words and models routinely write a paragraph, so past
 * roughly 40 words the opening "[" fell outside the window, the match failed,
 * and the turn was read as plain "working" — silently discarding the two
 * statuses that actually steer the session: `blocked` never reached the client,
 * and `done` never reached the verification gate.
 */
test('a long NOTE does not push the handoff marker out of view', () => {
  const marker = (status, words) =>
    `Work done.\n[TURN: HANDOFF | TO: Ada | STATUS: ${status} | NOTE: ${Array(words).fill('word').join(' ')}]`;
  for (const words of [10, 40, 120, 300]) {
    for (const status of ['blocked', 'done', 'working']) {
      const h = P.parseAgentResponse(marker(status, words)).handoff;
      assert.ok(h, `${status} marker with a ${words}-word note must still parse`);
      assert.equal(h.status, status);
      assert.equal(h.to, 'Ada');
    }
  }
  // The prose still loses the marker, and a turn without one is still null.
  assert.equal(P.parseAgentResponse(marker('done', 80)).prose, 'Work done.');
  assert.equal(P.parseAgentResponse('just prose').handoff, null);
});

/*
 * Regression: the marker used to be anchored to the END of the message, so one
 * trailing pleasantry, a code fence, a newline inside NOTE, or a "]" inside
 * NOTE dropped it entirely — and a markerless turn reads as plain `working`,
 * which silently discards the two statuses that steer a session.
 */
test('a handoff survives whatever the model writes after it', () => {
  const m = (extra, status = 'done', note = 'shipped') =>
    P.parseAgentResponse(
      `Work done.\n[TURN: HANDOFF | TO: Ada | STATUS: ${status} | NOTE: ${note}]${extra}`
    ).handoff;

  assert.equal(m('').status, 'done', 'marker as the last line');
  assert.equal(m('\nLet me know if you need anything else.').status, 'done', 'trailing chatter');
  assert.equal(m('\nPlease advise.', 'blocked').status, 'blocked', 'a blocked turn still reaches the client');
  assert.equal(m('\n```js\nx()\n```').status, 'done', 'a trailing code fence');
  assert.equal(m('', 'done', 'line one\nline two').status, 'done', 'a NOTE that wrapped');
  assert.equal(m('', 'done', 'see foo[1] here').status, 'done', 'a NOTE containing a bracket');

  // The LAST marker is the verdict — models quote the protocol at each other.
  const two = P.parseAgentResponse(
    'a\n[TURN: HANDOFF | TO: X | STATUS: working | NOTE: n]\nmore\n[TURN: HANDOFF | TO: Ada | STATUS: done | NOTE: n]'
  ).handoff;
  assert.equal(two.status, 'done');
  assert.equal(two.to, 'Ada');

  // ...but a marker quoted mid-sentence must not end anyone's turn.
  assert.equal(
    P.parseAgentResponse('I will write [TURN: HANDOFF | STATUS: done] when finished.').handoff,
    null
  );
  // A marker missing its optional fields degrades to the safe default.
  assert.equal(P.parseAgentResponse('x\n[TURN: HANDOFF]').handoff.status, 'working');
  assert.equal(P.parseAgentResponse('x\n[TURN: HANDOFF | STATUS: done]').handoff.to, null);
});

/*
 * The evidence sets behind the done gate. Editing them changes what "done"
 * means, so the test states the intent rather than just the membership.
 */
test('the done-gate evidence sets separate work from bookkeeping', () => {
  for (const t of ['write', 'append', 'edit', 'run', 'mkdir', 'move', 'delete', 'read_file', 'list_files']) {
    assert.ok(P.PJ_WORK_TOOLS.has(t), `${t} should count as work`);
  }
  // Moving cards on the task board is not evidence that anything was built
  for (const t of ['task_add', 'task_update', 'decision', 'debate']) {
    assert.equal(P.PJ_WORK_TOOLS.has(t), false, `${t} must not count as work`);
  }
  // A verifier must have actually LOOKED at the workspace
  assert.deepEqual([...P.PJ_INSPECT_TOOLS].sort(), ['list_files', 'read_file', 'run']);
  for (const t of P.PJ_INSPECT_TOOLS) {
    assert.ok(P.PJ_WORK_TOOLS.has(t), `${t} should be a subset of the work set`);
  }
  // A directory listing cannot be the only thing the session ever did
  assert.equal(P.PJ_SESSION_WORK_TOOLS.has('list_files'), false, 'list_files is inspection, not session work');
  assert.ok(P.PJ_INSPECT_TOOLS.has('list_files'));
  for (const t of P.PJ_SESSION_WORK_TOOLS) {
    assert.ok(P.PJ_WORK_TOOLS.has(t), `${t} session-work must stay inside the work set`);
    assert.notEqual(t, 'list_files');
  }
  for (const t of ['write', 'append', 'edit', 'run', 'mkdir', 'move', 'delete', 'read_file']) {
    assert.ok(P.PJ_SESSION_WORK_TOOLS.has(t), `${t} should count as session work`);
  }
});

/*
 * The trim must preserve one user brief followed by [assistant, user] pairs.
 * Producing consecutive user turns draws the same hard 400 from role-checking
 * providers that the trimming exists to avoid.
 */
test('pjTrimConvo keeps the conversation alternating', () => {
  const convo = [{ role: 'user', content: 'BRIEF' }];
  for (let i = 0; i < 8; i++) {
    convo.push({ role: 'assistant', content: `a${i}`.repeat(500) });
    convo.push({ role: 'user', content: `r${i}`.repeat(500) });
  }
  const out = P.pjTrimConvo(convo, 4000);

  assert.ok(out.length < convo.length, 'should have dropped something');
  assert.equal(out[0].role, 'user', 'the brief stays first');
  assert.match(out[0].content, /^BRIEF/, 'the brief itself is never dropped');
  assert.match(out[0].content, /dropped to fit your context window/, 'and carries the note');

  for (let i = 1; i < out.length; i++) {
    const expected = i % 2 === 1 ? 'assistant' : 'user';
    assert.equal(out[i].role, expected, `position ${i} should be ${expected}`);
  }
  assert.equal(out[out.length - 1].role, 'user', 'the newest results are kept');
  assert.equal(out[out.length - 1].content, convo[convo.length - 1].content);
});

test('pjTrimConvo is a no-op under budget', () => {
  const convo = [
    { role: 'user', content: 'BRIEF' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'r' }
  ];
  assert.equal(P.pjTrimConvo(convo, 1_000_000), convo);
});

test('pjTrimConvo never strips the conversation below one exchange', () => {
  const convo = [
    { role: 'user', content: 'BRIEF' },
    { role: 'assistant', content: 'x'.repeat(50_000) },
    { role: 'user', content: 'y'.repeat(50_000) }
  ];
  const out = P.pjTrimConvo(convo, 10);
  assert.equal(out.length, 3, 'the last exchange survives any budget');
});

/*
 * Regression: the newest exchange is never DROPPED, so when it alone exceeded
 * the budget nothing above could help and the provider answered with the hard
 * 400 the trim exists to avoid — one medium file read on a small-context seat
 * ended the session. Elide the content instead: losing the middle of one tool
 * result beats losing the turn.
 */
test('pjTrimConvo brings an oversized final exchange under budget', () => {
  const convo = [
    { role: 'user', content: 'BRIEF' },
    { role: 'assistant', content: 'a'.repeat(500) },
    { role: 'user', content: 'y'.repeat(60_000) }
  ];
  const out = P.pjTrimConvo(convo, 8000);
  const total = out.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= 8000, `expected <= 8000, got ${total}`);
  assert.equal(out.length, 3, 'the exchange is kept, just shortened');
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[2].role, 'user');
  assert.match(out[2].content, /elided/, 'and says so, so the agent can re-read');

  // Nothing to do under budget → the very same array back (callers rely on it).
  const small = [
    { role: 'user', content: 'B' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'r' }
  ];
  assert.equal(P.pjTrimConvo(small, 1_000_000), small);
});

/*
 * Regression: the write-fence terminator matched ``` ANYWHERE, so content
 * containing markdown fences was truncated at the first inner ``` and the
 * rest spilled into prose. The closing fence must be a bare fence line.
 */
test('a write fence tolerates inline and language-tagged backticks in its content', () => {
  // Inline ``` mid-line must not terminate the fence
  const r1 = P.parseAgentResponse('```write doc.md\nuse ``` to fence code\ndone\n```\ntrailing prose');
  assert.equal(r1.blocks.length, 1);
  assert.equal(r1.blocks[0].path, 'doc.md');
  assert.equal(r1.blocks[0].content, 'use ``` to fence code\ndone\n');

  // A language-tagged inner opener (```sh) is not a terminator either
  const r2 = P.parseAgentResponse('```write doc.md\n# Demo\n```sh — has a tag, not a closer\nmore\n```');
  assert.equal(r2.blocks.length, 1);
  assert.match(r2.blocks[0].content, /```sh — has a tag/, 'inner tagged line survives');
  assert.match(r2.blocks[0].content, /more\n$/);
});

test('a plain write fence still parses exactly as before', () => {
  const r = P.parseAgentResponse('```write src/app.js\nconsole.log(1);\n```\n[TURN: HANDOFF | TO: auto | STATUS: working | NOTE: ok]');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].content, 'console.log(1);\n');
  assert.equal(r.handoff.status, 'working');
});

/*
 * The debate lineup is adaptive from 2 seats up to a single shared ceiling,
 * and an empty persona falls back to one shared default — both constants live
 * in protocol.js so the editor UI, settings loader, and engine cannot drift.
 */
test('debate seat ceiling and default persona are the shared constants', () => {
  assert.equal(D.DEBATE_MAX_SEATS, 5);
  assert.equal(D.debateSeatRangeLabel(), `2–${D.DEBATE_MAX_SEATS}`);
  assert.ok(
    typeof D.DEBATE_DEFAULT_PERSONA === 'string' && D.DEBATE_DEFAULT_PERSONA.trim().length > 0,
    'the default persona the UI advertises must exist'
  );
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'debate', 'ui.js'), 'utf8');
  const engine = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'src', 'debate', 'engine.js'),
    'utf8'
  );
  assert.match(ui, /DEBATE_MAX_SEATS/);
  assert.match(ui, /debateSeatRangeLabel/);
  assert.match(engine, /DEBATE_MAX_SEATS/);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /2–5 AI experts/);
  assert.doesNotMatch(readme, /2–4 AI experts/);
});

/* ---------- debate consensus / drop / presenter (shipped helpers) ---------- */

function seat(name, i, extra = {}) {
  return { name, i, dropped: false, status: 'continue', nominee: null, ...extra };
}

test('parseDebateStatus reads the last line-start STATUS even with trailing chatter', () => {
  const chatter = D.parseDebateStatus(
    'My take.\n[STATUS: AGREE | NOMINATE: Kai]\nLet me know if you need anything else.'
  );
  assert.equal(chatter.status, 'agree');
  assert.equal(chatter.nominee, 'Kai');
  assert.equal(chatter.cleanText, 'My take.');

  const blocked = D.parseDebateStatus(
    'Still open.\n[STATUS: CONTINUE]\nPlease advise.'
  );
  assert.equal(blocked.status, 'continue');
  assert.equal(blocked.cleanText, 'Still open.');

  // Last marker wins when the model quotes the protocol at itself
  const two = D.parseDebateStatus(
    'First pass.\n[STATUS: AGREE | NOMINATE: Kai]\nOn second thought.\n[STATUS: CONTINUE]'
  );
  assert.equal(two.status, 'continue');
  assert.match(two.cleanText, /On second thought/);
});

test('a mid-sentence STATUS quote is not the turn’s verdict', () => {
  assert.equal(
    D.parseDebateStatus('I will write [STATUS: AGREE | NOMINATE: Kai] when finished.').status,
    'continue'
  );
  assert.equal(
    D.parseDebateStatus('see the protocol STATUS: AGREE | NOMINATE: Kai at the end of this sentence').status,
    'continue'
  );
});

test('stripStreamingStatusTail hides a finished marker plus trailing chatter', () => {
  assert.equal(
    D.stripStreamingStatusTail('answer\n[STATUS: AGREE | NOMINATE: Kai]\nThanks.'),
    'answer'
  );
  assert.equal(D.stripStreamingStatusTail('answer\nSTATUS: CONTINUE'), 'answer');
});

test('informed consensus requires an unbroken AGREE from every live seat', () => {
  const a = seat('A', 0);
  const b = seat('B', 1);
  const c = seat('C', 2);

  D.applyDebateVote([a, b, c], a, 'agree', 'B');
  D.applyDebateVote([a, b, c], b, 'agree', 'B');
  assert.equal(D.debateHasConsensus([a, b, c]), false, 'one silent seat is not consensus');

  D.applyDebateVote([a, b, c], c, 'agree', 'A');
  assert.equal(D.debateHasConsensus([a, b, c]), true);

  // A later CONTINUE invalidates earlier AGREEs
  D.applyDebateVote([a, b, c], a, 'continue', null);
  assert.equal(a.status, 'continue');
  assert.equal(b.status, 'continue', 'prior AGREE must be cleared');
  assert.equal(c.status, 'continue', 'prior AGREE must be cleared');
  assert.equal(D.debateHasConsensus([a, b, c]), false);
});

test('opening-round votes are discarded before they can count', () => {
  const a = seat('A', 0, { status: 'agree' });
  const b = seat('B', 1, { status: 'agree' });
  D.discardOpeningVotes([a, b]);
  assert.equal(a.status, 'continue');
  assert.equal(b.status, 'continue');
  assert.equal(D.debateHasConsensus([a, b]), false);
});

test('a dropped seat cannot present and consensus is re-tested after the drop', () => {
  const a = seat('A', 0, { status: 'agree' });
  const b = seat('B', 1, { status: 'agree' });
  const c = seat('C', 2, { status: 'continue' });
  assert.equal(D.debateHasConsensus([a, b, c]), false);

  D.dropDebateSeat(c);
  assert.equal(c.dropped, true);
  assert.equal(D.debateHasConsensus([a, b, c]), true, 'remaining pair already agrees');

  // Presenter pick never returns the dropped seat, even if everyone nominated it
  a.nominee = c;
  b.nominee = c;
  const pick = D.pickDebatePresenter([a, b, c]);
  assert.equal(pick.dropped, false);
  assert.notEqual(pick.name, 'C');
});

test('fewer than two live seats cannot claim consensus', () => {
  const a = seat('A', 0, { status: 'agree' });
  const b = seat('B', 1, { status: 'agree', dropped: true });
  assert.equal(D.debateHasConsensus([a, b]), false);
  assert.equal(D.debateHasConsensus([a]), false);
  assert.equal(D.debateHasConsensus([]), false);
});

test('a failed judge does not throw away the debate — the nominee writes, credit says so', () => {
  const a = seat('A', 0);
  const b = seat('B', 1);
  const c = seat('C', 2, { dropped: true });
  a.nominee = b;
  b.nominee = b;

  const judge = D.debateAnswerAttribution({
    judgeDelivered: true,
    judgeSeat: { model: 'judge-model' },
    seats: [a, b, c]
  });
  assert.equal(judge.mode, 'judge');
  assert.match(judge.label, /judge-model/);
  assert.deepEqual(judge.creditNames, ['A', 'B'], 'dropped seats stay off the credit line');

  const fallback = D.debateAnswerAttribution({
    judgeDelivered: false,
    judgeSeat: { model: 'judge-model' },
    seats: [a, b, c]
  });
  assert.equal(fallback.mode, 'nominated');
  assert.equal(fallback.presenter.name, 'B');
  assert.equal(fallback.label, 'B');
  assert.deepEqual(fallback.creditNames, ['A', 'B']);
  assert.equal(fallback.presenter.dropped, false);
});

/* ---------- project done-gate / self-handoff (shipped helpers) ---------- */

test('recordProjectToolEvidence treats list_files as inspect-only', () => {
  const did = { work: 0, inspect: 0 };
  P.recordProjectToolEvidence({ ok: true, tool: 'list_files' }, did);
  assert.equal(did.work, 0, 'listing is not session work');
  assert.equal(did.inspect, 1);

  P.recordProjectToolEvidence({ ok: true, tool: 'read_file' }, did);
  assert.equal(did.work, 1);
  assert.equal(did.inspect, 2);

  P.recordProjectToolEvidence({ ok: true, tool: 'task_add' }, did);
  assert.equal(did.work, 1, 'bookkeeping must not increment work');
  assert.equal(did.inspect, 2);

  // A run that executed and exited non-zero still counts (grep with no matches)
  P.recordProjectToolEvidence({ ok: false, tool: 'run', ran: true }, did);
  assert.equal(did.work, 2);
  assert.equal(did.inspect, 3);

  P.recordProjectToolEvidence({ ok: false, tool: 'run' }, did);
  assert.equal(did.work, 2, 'a blocked run is not evidence');
  assert.equal(did.inspect, 3);
});

test('the done gate refuses no session work and a verifier who inspected nothing', () => {
  const none = P.evaluateProjectDoneClaim({
    status: 'done',
    did: { work: 0, inspect: 1 },
    sessionWork: 0,
    verifying: false,
    seatName: 'Ada'
  });
  assert.equal(none.accept, false);
  assert.match(none.refusal, /nobody has read, written, or run anything/);

  const listOnly = P.evaluateProjectDoneClaim({
    status: 'done',
    did: { work: 0, inspect: 1 },
    sessionWork: 0,
    verifying: true,
    seatName: 'Ada'
  });
  assert.equal(listOnly.accept, false);
  assert.equal(listOnly.sessionWork, 0);

  const noLook = P.evaluateProjectDoneClaim({
    status: 'done',
    did: { work: 0, inspect: 0 },
    sessionWork: 3,
    verifying: true,
    seatName: 'Ada'
  });
  assert.equal(noLook.accept, false);
  assert.match(noLook.refusal, /without inspecting anything/);

  const ok = P.evaluateProjectDoneClaim({
    status: 'done',
    did: { work: 1, inspect: 1 },
    sessionWork: 2,
    verifying: true,
    seatName: 'Ada'
  });
  assert.equal(ok.accept, true);
  assert.equal(ok.refusal, '');
  assert.equal(ok.sessionWork, 3);

  const working = P.evaluateProjectDoneClaim({
    status: 'working',
    did: { work: 2, inspect: 1 },
    sessionWork: 0
  });
  assert.equal(working.accept, false);
  assert.equal(working.resetStreak, true);
  assert.equal(working.sessionWork, 2);
  assert.equal(working.refusal, '');
});

test('a self-handoff on a pending done claim is not independent verification', () => {
  const ada = { name: 'Ada', i: 0 };
  const bev = { name: 'Bev', i: 1 };
  const seats = [ada, bev];

  const self = P.resolveProjectNextSeat({
    to: 'Ada',
    seats,
    currentIndex: 0,
    currentSeat: ada,
    doneStreak: 1
  });
  assert.equal(self.selfHandoffIgnored, true);
  assert.equal(self.nextIndex, 1, 'round-robin must pick the other seat');

  const named = P.resolveProjectNextSeat({
    to: 'Bev',
    seats,
    currentIndex: 0,
    currentSeat: ada,
    doneStreak: 1
  });
  assert.equal(named.selfHandoffIgnored, false);
  assert.equal(named.nextIndex, 1);

  const idle = P.resolveProjectNextSeat({
    to: 'Ada',
    seats,
    currentIndex: 0,
    currentSeat: ada,
    doneStreak: 0
  });
  assert.equal(idle.selfHandoffIgnored, false, 'self-handoff is fine when nothing is pending');
  assert.equal(idle.nextIndex, 0);
});

test('pjElide keeps a locator so the model can re-read the omitted middle', () => {
  const big = 'HEAD'.repeat(100) + 'MIDDLE'.repeat(2000) + 'TAIL'.repeat(100);
  const out = P.pjElide(big, 800);
  assert.ok(out.length < big.length);
  assert.match(out, /^HEAD/);
  assert.match(out, /TAIL$/);
  assert.match(out, /elided/);
  assert.match(out, /re-read|narrower/);
  assert.equal(P.pjElide('short', 800), 'short');
});

test('a repeated identical tool call is not fresh progress', () => {
  const a = P.projectToolCallKey('read_file', { path: 'a.js' });
  const b = P.projectToolCallKey('read_file', { path: 'a.js' });
  const c = P.projectToolCallKey('read_file', { path: 'b.js' });
  const shuffled = P.projectToolCallKey('read_file', { z: 1, path: 'a.js' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, shuffled);

  const seen = new Map();
  const first = P.noteRepeatToolCall(seen, a, 'ok 12 lines');
  assert.equal(first.repeat, false);
  const again = P.noteRepeatToolCall(seen, a, 'ignored');
  assert.equal(again.repeat, true);
  assert.match(String(again.prior), /ok 12 lines/);
  const other = P.noteRepeatToolCall(seen, c, 'other');
  assert.equal(other.repeat, false);
});

test('write/edit identity uses the full fence payload, not just the path', () => {
  const twoWrites = P.parseAgentResponse(
    '```write src/a.js\nfirst\n```\n```write src/a.js\nsecond\n```'
  );
  assert.equal(twoWrites.blocks.length, 2);
  const k1 = P.projectToolCallKey(twoWrites.blocks[0].kind, P.projectToolCallPayload(twoWrites.blocks[0]));
  const k2 = P.projectToolCallKey(twoWrites.blocks[1].kind, P.projectToolCallPayload(twoWrites.blocks[1]));
  assert.notEqual(k1, k2, 'different contents at the same path are different calls');

  const same = P.parseAgentResponse(
    '```write src/a.js\nsame\n```\n```write src/a.js\nsame\n```'
  );
  assert.equal(
    P.projectToolCallKey(same.blocks[0].kind, P.projectToolCallPayload(same.blocks[0])),
    P.projectToolCallKey(same.blocks[1].kind, P.projectToolCallPayload(same.blocks[1]))
  );

  const edits = P.parseAgentResponse(
    '```edit a.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```\n' +
      '```edit a.js\n<<<<<<< SEARCH\nold\n=======\nother\n>>>>>>> REPLACE\n```'
  );
  assert.notEqual(
    P.projectToolCallKey('edit', P.projectToolCallPayload(edits.blocks[0])),
    P.projectToolCallKey('edit', P.projectToolCallPayload(edits.blocks[1])),
    'different SEARCH/REPLACE on the same path are different calls'
  );

  // Journal-facing {path} alone must not be what the engine keys — that was the bug.
  const pathOnly = P.projectToolCallKey('write', { path: 'src/a.js' });
  assert.notEqual(k1, pathOnly);
  assert.notEqual(k2, pathOnly);

  const engine = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'src', 'project', 'engine.js'),
    'utf8'
  );
  assert.match(engine, /projectToolCallPayload\(\s*block\s*\)/);
});

test('commandExitFacts does not treat a timeout or signal as a clean success', () => {
  assert.equal(P.commandExitFacts({ exitCode: 0 }).cleanSuccess, true);
  assert.equal(P.commandExitFacts({ exitCode: 1 }).cleanSuccess, false);
  assert.equal(
    P.commandExitFacts({ timedOut: true, exitCode: 0 }).cleanSuccess,
    false,
    'timed out + exit 0 is not success'
  );
  assert.equal(P.commandExitFacts({ signal: 'SIGKILL', exitCode: 0 }).cleanSuccess, false);
  assert.equal(P.commandExitFacts({ aborted: true, exitCode: 0 }).cleanSuccess, false);
  const facts = P.commandExitFacts({ timedOut: true, signal: 'SIGKILL', exitCode: 0 });
  assert.equal(facts.timedOut, true);
  assert.equal(facts.signal, 'SIGKILL');
  assert.equal(facts.exitCode, 0);
});
