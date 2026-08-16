'use strict';
/**
 * Composer dispatch: Project / Debate / Solo stay three distinct paths, and a
 * setup rejection must not consume the typed draft. Reads the shipped
 * compose.js — a re-implementation of sendMessage would not catch a reorder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'compose.js'), 'utf8');
const send = SRC.slice(SRC.indexOf('async function sendMessage'), SRC.indexOf('const DRAFT_KEY'));

test('sendMessage still dispatches Project, then Debate, then Solo', () => {
  const proj = send.indexOf('projectMode.enabled');
  const runProj = send.indexOf('runProjectInstruction');
  const debate = send.indexOf('debateSettings.enabled');
  const runDeb = send.indexOf('runDebate');
  const solo = send.indexOf('streamAssistantReply');

  assert.ok(proj !== -1 && runProj !== -1, 'Project path must stay wired');
  assert.ok(debate !== -1 && runDeb !== -1, 'Debate path must stay wired');
  assert.ok(solo !== -1, 'Solo path must stay wired');
  assert.ok(proj < debate, 'Project is checked before Debate');
  assert.ok(runProj < runDeb, 'Project runs before Debate');
  assert.ok(runDeb < solo, 'Debate runs before the Solo fallback');
});

test('the three engines call the shipped decision helpers, not a private copy', () => {
  const debate = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'src', 'debate', 'engine.js'),
    'utf8'
  );
  const project = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'src', 'project', 'engine.js'),
    'utf8'
  );
  const solo = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'solo.js'), 'utf8');

  for (const name of [
    'applyDebateVote',
    'debateHasConsensus',
    'discardOpeningVotes',
    'dropDebateSeat',
    'debateAnswerAttribution',
    'parseDebateStatus',
    'pickDebatePresenter'
  ]) {
    assert.match(debate, new RegExp(`\\b${name}\\b`), `debate engine must call ${name}`);
  }
  for (const name of [
    'evaluateProjectDoneClaim',
    'resolveProjectNextSeat',
    'recordProjectToolEvidence',
    'parseAgentResponse',
    'projectToolCallKey',
    'projectToolCallPayload',
    'noteRepeatToolCall'
  ]) {
    assert.match(project, new RegExp(`\\b${name}\\b`), `project engine must call ${name}`);
  }
  for (const name of ['shouldRetryStream', 'soloAssistantDisposition']) {
    assert.match(solo, new RegExp(`\\b${name}\\b`), `solo must call ${name}`);
  }
});

test('UI chrome still has the local-agent list and distinct Solo / Debate / Project strips', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="localAgentList"/);
  assert.match(html, /id="soloStrip"/);
  assert.match(html, /id="modeStrip"/);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'localAgents.js'), 'utf8');
  assert.match(agents, /#localAgentList/);
  assert.match(agents, /local-grok/);
  const strip = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'project', 'state.js'), 'utf8');
  assert.match(strip, /soloStrip/);
  assert.match(strip, /modeStrip/);
  const stream = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'net', 'stream.js'), 'utf8');
  assert.match(stream, /localProfileReady/);
  assert.match(stream, /grok/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /setDebateMode/);
  assert.match(app, /reconcileExclusiveModes/);
  assert.match(app, /initViewportInsets/);
});

test('setup failures return before the composer draft is cleared', () => {
  const projBlock = send.slice(send.indexOf('projectMode.enabled'), send.indexOf('runProjectInstruction'));
  const vProj = projBlock.indexOf('validateProjectSetup');
  const clearProj = projBlock.indexOf("userInput.value = ''");
  assert.ok(vProj !== -1 && clearProj !== -1, 'Project must validate, then clear');
  assert.ok(vProj < clearProj, 'validate Project before wiping the input');
  assert.match(projBlock.slice(vProj, clearProj), /if\s*\(\s*issue\s*\)[\s\S]*return/);
  assert.match(send.slice(send.indexOf('projectMode.enabled'), send.indexOf('runProjectInstruction')), /setStickToBottom/);

  const beforeCommit = send.slice(0, send.indexOf('pushHistoryMessage'));
  const vDeb = beforeCommit.indexOf('validateDebateSetup');
  assert.ok(vDeb !== -1, 'Debate setup is checked before the user turn is committed');
  const debCheck = beforeCommit.slice(beforeCommit.indexOf('debateSettings.enabled'), beforeCommit.length);
  assert.match(debCheck, /validateDebateSetup/);
  assert.match(debCheck, /if\s*\(\s*issue\s*\)[\s\S]*return/);

  // Solo config failure also returns before the Solo turn is committed.
  // Debate must NOT go through getValidatedConfig — seats have their own
  // providers, and a missing solo key must not block a valid team.
  const solo = send.slice(send.lastIndexOf('getValidatedConfig'));
  assert.match(solo, /if\s*\(\s*!cfg\s*\)\s*return/);
  assert.match(solo, /streamAssistantReply/);
  const debateBlock = send.slice(
    send.indexOf('debateSettings.enabled'),
    send.indexOf('getValidatedConfig')
  );
  assert.match(debateBlock, /validateDebateSetup/);
  assert.match(debateBlock, /runDebate/);
  assert.doesNotMatch(debateBlock, /getValidatedConfig/);
});
