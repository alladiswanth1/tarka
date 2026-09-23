'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const src = fs.readFileSync(path.join(__dirname, '../public/src/project/engine.js'), 'utf8');
const report = src.slice(src.indexOf('async function runProjectReport'), src.indexOf('/* ---------- work session'));

test('project reports fit their budget and do not persist a provider error as an answer', async () => {
  const { pjTrimConvo } = await import(pathToFileURL(path.join(__dirname, '../public/src/project/protocol.js')).href);
  for (const result of [{ content: 'Verified report' }, { error: 'upstream failed', content: 'partial' }, { cancelled: true }]) {
    const journal = [];
    let request;
    let failure;
    let cancelled = false;
    let removed = false;
    let saved = 0;
    const node = { classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return this; }, remove() { removed = true; } };
    const context = vm.createContext({
      getConfig: () => ({}), pjTurnBudget: () => 8000, pjTrimConvo,
      buildProjectTurnContext: async (...args) => { assert.equal(args[5], 8000); return 'context '.repeat(2000); },
      statusText: {}, pjTurnShellDom: () => node, messagesEl: node,
      document: { createElement: () => node }, scrollToBottom() {},
      createStreamRenderer: () => ({ finish() {}, finishPlain(text) { failure = text; }, cancel() { cancelled = true; } }),
      streamCompletion: async (args) => { request = args; return result; },
      streamResultError: (r) => new Error(r.error), localAgentId: () => null,
      projectJournal: journal, pjPersistJournal() { saved++; }
    });
    vm.runInContext(report, context);
    await context.runProjectReport({ name: 'Engineer', provider: {}, model: 'model', i: 0 }, 'task', { stale: () => false });
    assert.ok(request.messages[0].content.length <= 8000);
    if (result.error) {
      assert.match(failure, /report failed: upstream failed/);
      assert.equal(saved, 0); assert.equal(journal.length, 0);
    } else if (result.cancelled) {
      assert.ok(cancelled); assert.ok(removed); assert.equal(saved, 0);
    } else {
      assert.equal(journal[0].text, 'Verified report'); assert.equal(saved, 1);
    }
  }
});
