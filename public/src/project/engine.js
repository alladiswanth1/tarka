import { getConfig } from '../config.js';
import { localAgentId } from '../providers.js';
import { pushRecentModel, warmProviderCatalogs } from '../models.js';
import { isTransientProviderError, sleep, streamCompletion } from '../net/stream.js';
import { pjEmit, pjToolCardDom, pjToolLabel, pjTurnShellDom } from '../project/journal.js';
import { buildProjectSystemPrompt, evaluateProjectDoneClaim, parseAgentResponse, pjDisplayable, pjElide, pjJournalLineForPrompt, pjTrimConvo, recordProjectToolEvidence, resolveProjectNextSeat } from '../project/protocol.js';
import { activeProject, pjApi, pjPersistJournal, projectDecisions, projectJournal, projectRun, projectSeats, projectTasks, renderProjectTasksList, setProjectBusy, setProjectRun, updateModeStrip } from '../project/state.js';
import { executeAgentBlock } from '../project/tools.js';
import { abortController, messagesEl, setAbortController, statusText, userInput } from '../state.js';
import { refreshProjectFiles, renderProjectInspector, setProjectTurnMax, setProjectTurnNow } from '../ui/inspector.js';
import { flashMarkAgreed } from '../ui/mark.js';
import { createStreamRenderer } from '../ui/renderer.js';
import { READY_STATUS, createReasoningPanel, destroyReasoningPanel, finalizeReasoningPanel, markStreamUnread, scrollToBottom, setStreamingUi, stickToBottom, sweepReasoningTimers, updateReasoningStream } from '../ui/transcript.js';
import { contextLimitFor } from '../context.js';

async function buildProjectTurnContext(seat, instruction, turn, maxTurns, signal) {
  let treeText = '(could not list files)';
  try {
    const data = await pjApi('/api/project/fs', { id: activeProject.id, op: 'list', path: '' }, signal);
    const entries = (data.result.entries || []).slice(0, 200);
    treeText = entries.length
      ? entries.map((en) => (en.dir ? `${en.path}${en.skipped ? ' (skipped)' : ''}` : `${en.path} (${en.size}b)`)).join('\n') +
        (data.result.truncated || entries.length < (data.result.entries || []).length ? '\n…(truncated)' : '')
      : '(empty folder)';
  } catch { /* keep placeholder */ }

  const tasksText = projectTasks.length
    // Defensive: the board is plain JSON on disk and `run` has no containment,
    // so one hand-edited task without a status used to throw here and end EVERY
    // future session with "Session error" before the first turn.
    ? projectTasks.map((t) => `[${t?.id || '?'}] ${String(t?.status || 'todo').toUpperCase()}${t?.by ? ` (${t.by})` : ''} — ${t?.title || '(untitled)'}${t?.note ? ` · ${t.note}` : ''}`).join('\n')
    : '(empty — break the instruction into tasks)';

  const decText = projectDecisions.length
    ? projectDecisions.slice(-12).map((d) => `- ${d.text} (${d.by})`).join('\n')
    : '(none yet)';

  const activity = projectJournal
    .slice(-30)
    .map(pjJournalLineForPrompt)
    .filter(Boolean)
    .join('\n') || '(none yet)';

  return [
    `PROJECT: ${activeProject.name}`,
    '',
    'CURRENT INSTRUCTION from the client:',
    instruction,
    '',
    'WORKSPACE FILES:',
    treeText,
    '',
    'TASK BOARD:',
    tasksText,
    '',
    'TEAM DECISIONS:',
    decText,
    '',
    'RECENT TEAM ACTIVITY (oldest → newest):',
    activity,
    '',
    `Turn ${turn} of ${maxTurns} this session. You are ${seat.name}. Work now.`
  ].join('\n');
}

/* ---------- turn engine ---------- */
const PJ_INNER_STEPS = 8;

/**
 * Char budget for one seat's inner turn conversation, from that seat's context
 * window (provider-detected when cached, else the known-model table). Eight
 * tool steps at up to 12KB of results each will overrun a small model long
 * before the step budget runs out, and the provider answers that with a hard
 * 400 rather than a warning.
 */
function pjTurnBudget(seat, cfg) {
  const { limit } = contextLimitFor(seat.provider?.id || '', seat.model);
  const reserveTokens = (cfg.maxTokens || 1600) + 3000; // completion + system prompt
  return Math.max(8000, (limit - reserveTokens) * 3); // ~3 chars/token, deliberately conservative
}

/**
 * Keep the inner turn conversation under budget by dropping the OLDEST
 * tool exchanges. The turn context (message 0) and the most recent exchanges
 * are what the model actually needs; a note marks what was dropped so it can
 * re-read anything it still wants.
 */

async function runProjectAgentTurn(seat, seats, instruction, turn, maxTurns, opts) {
  const cfg = getConfig();
  const sys = buildProjectSystemPrompt(seat, seats, { verify: opts.verify });
  const ctx = await buildProjectTurnContext(seat, instruction, turn, maxTurns, opts.signal);
  if (opts.stale()) return { aborted: true };
  const convo = [{ role: 'user', content: ctx }];
  const turnBudget = pjTurnBudget(seat, cfg);
  // What this turn actually accomplished — the session uses it to decide
  // whether a "done" claim has anything behind it.
  const did = { work: 0, inspect: 0 };

  for (let step = 1; step <= PJ_INNER_STEPS; step++) {
    statusText.textContent = `${seat.name} · turn ${turn}/${maxTurns}${step > 1 ? ` · step ${step}` : ''}…`;
    statusText.classList.add('thinking-status');

    // Live streaming turn shell
    const shell = pjTurnShellDom(seat.name, seat.i);
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
    messagesEl.appendChild(shell);
    const body = shell.querySelector('.pj-turn-body');
    const bubble = document.createElement('div');
    bubble.className = 'bubble pj-bubble streaming';
    body.appendChild(bubble);
    const renderer = createStreamRenderer(bubble, { announce: false, sweep: false });
    scrollToBottom();

    let rApi = null;
    let rText = '';
    let result = null;
    let lastErr = null;
    /** Drop this turn's UI, stopping the thought panel's timer with it */
    const dropTurnShell = () => {
      rApi = destroyReasoningPanel(rApi);
      shell.remove();
    };
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try {
        if (attempt > 1) {
          await sleep(1100);
          if (opts.stale() || opts.signal.aborted) break;
          renderer.update('');
        }
        const r = await streamCompletion({
          baseURL: seat.provider.baseURL,
          apiKey: seat.provider.apiKey,
          model: seat.model,
          agent: localAgentId(seat.provider),
          reasoningEffort: opts.effort,
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
          systemPrompt: sys,
          messages: pjTrimConvo(convo, turnBudget),
          signal: opts.signal,
          shouldCancel: opts.stale,
          onToken: (chunk, full) => {
            if (opts.stale()) return;
            if (rApi && !rApi.finalized) finalizeReasoningPanel(rApi, { forceOpen: false });
            renderer.update(pjDisplayable(full));
            if (!stickToBottom) markStreamUnread();
            scrollToBottom();
          },
          onReasoningToken: (piece) => {
            if (opts.stale()) return;
            if (!rApi) {
              rApi = createReasoningPanel({ expectStream: true });
              body.insertBefore(rApi.el, bubble);
            }
            rText += piece;
            updateReasoningStream(rApi, rText);
            scrollToBottom();
          }
        });
        if (opts.stale() || r.cancelled) {
          dropTurnShell();
          return { aborted: true };
        }
        if (r.error) throw new Error(r.error);
        result = r;
      } catch (err) {
        if (err.name === 'AbortError') {
          dropTurnShell();
          return { aborted: true };
        }
        if (opts.stale()) {
          dropTurnShell();
          return { aborted: true };
        }
        lastErr = err;
        if (attempt >= 2 || !isTransientProviderError(err.message || '')) {
          dropTurnShell();
          return { ok: false, err: lastErr };
        }
      }
    }
    if (!result) {
      dropTurnShell();
      return opts.signal.aborted ? { aborted: true } : { ok: false, err: lastErr || new Error('no response') };
    }
    if (rApi && !rApi.finalized) finalizeReasoningPanel(rApi, { forceOpen: false });

    const parsed = parseAgentResponse(result.content);

    // Finalize the prose bubble (fences removed) or drop it if empty
    if (parsed.prose) {
      renderer.finish(parsed.prose);
      bubble.classList.remove('streaming');
      pjEmit({ type: 'say', name: seat.name, seat: seat.i, text: parsed.prose }, { persist: true });
      // The live shell already shows it; remove the duplicate emitted node
      const dupe = messagesEl.lastElementChild;
      if (dupe && dupe !== shell && dupe.classList.contains('pj-turn')) dupe.remove();
    } else {
      bubble.remove();
      if (!rText && !parsed.blocks.length) shell.remove();
    }

    if (!parsed.blocks.length) {
      const h = parsed.handoff || { to: null, status: 'working', note: '' };
      return { ok: true, status: h.status, to: h.to, note: h.note, did };
    }

    // Execute tool blocks sequentially, streaming cards into the shell.
    //
    // Tool output is elided against THIS SEAT's budget, not a fixed 12k. The
    // trim always keeps the newest exchange whole, so a single result larger
    // than the budget could never be trimmed back under it — a seat on a small
    // model read one medium file and drew the hard 400 the trim exists to
    // prevent, which ends the session. Big-context seats still get the full 12k.
    const resultCap = Math.min(
      12_000,
      Math.max(1200, Math.floor(turnBudget / (2 * Math.max(1, parsed.blocks.length))))
    );
    const convoResults = [];
    for (let bi = 0; bi < parsed.blocks.length; bi++) {
      if (opts.stale() || opts.signal.aborted) return { aborted: true };
      const block = parsed.blocks[bi];
      const out = await executeAgentBlock(block, seat, opts);
      // Stop landed mid-tool — drop the half-finished card rather than
      // journalling a failure the user caused on purpose.
      if (opts.stale() || out.aborted || opts.signal.aborted) return { aborted: true };
      const ev = {
        t: Date.now(),
        type: 'tool', name: seat.name, seat: seat.i,
        tool: out.tool, args: out.args, ok: out.ok, ms: out.ms,
        detail: out.detail.slice(0, 4000)
      };
      projectJournal.push(ev);
      pjPersistJournal([ev]);
      const card = pjToolCardDom(ev);
      (shell.isConnected ? shell.querySelector('.pj-turn-body') : (() => { messagesEl.appendChild(shell); return shell.querySelector('.pj-turn-body'); })()).appendChild(card);
      scrollToBottom();
      // A command that RAN and exited non-zero is still evidence of work —
      // a verifier's `grep` finding no matches exits 1 (the good outcome) and
      // used to earn a false "confirmed done without inspecting anything".
      // Only blocked / failed-to-start runs carry no evidence.
      // Listing counts as looking, but not as having built anything — see
      // recordProjectToolEvidence / PJ_SESSION_WORK_TOOLS.
      recordProjectToolEvidence(out, did);
      convoResults.push(`[${bi + 1}] ${pjToolLabel(out.tool, out.args)} → ${out.ok ? 'OK' : 'ERROR'}\n${pjElide(out.convo, resultCap)}`);
    }

    convo.push({ role: 'assistant', content: result.content });
    convo.push({
      role: 'user',
      content:
        `TOOL RESULTS:\n\n${convoResults.join('\n\n')}\n\n` +
        (parsed.handoff
          ? 'You already ended your turn — results are recorded for the team.'
          : `Continue your turn (${PJ_INNER_STEPS - step} steps left), or end it with the [TURN: …] line.`)
    });

    if (parsed.handoff) {
      return { ok: true, status: parsed.handoff.status, to: parsed.handoff.to, note: parsed.handoff.note, did };
    }
  }
  return { ok: true, status: 'working', to: null, note: 'tool-step budget reached', did };
}

async function runProjectReport(seat, instruction, opts) {
  const cfg = getConfig();
  const sys =
    `You are ${seat.name}, an AI engineer whose team just completed the client's instruction. ` +
    'Write the final report to the client in concise markdown: what was built/changed, the key files, how to run or verify it, and anything left open. No tools, no TURN line.';
  const ctx = await buildProjectTurnContext(seat, instruction, 0, 0, opts.signal);
  if (opts.stale()) return;
  statusText.textContent = `${seat.name} writing the report…`;

  const shell = pjTurnShellDom(seat.name, seat.i);
  shell.classList.add('pj-report');
  messagesEl.appendChild(shell);
  const bubble = document.createElement('div');
  bubble.className = 'bubble pj-bubble streaming';
  shell.querySelector('.pj-turn-body').appendChild(bubble);
  const renderer = createStreamRenderer(bubble, { announce: true, sweep: true });
  scrollToBottom();
  try {
    const r = await streamCompletion({
      baseURL: seat.provider.baseURL,
      apiKey: seat.provider.apiKey,
      model: seat.model,
      agent: localAgentId(seat.provider),
      // opts.effort honours the project's `reasoning: 'none'` setting — the
      // report request must not burn reasoning tokens the setting turned off.
      reasoningEffort: opts.effort,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      systemPrompt: sys,
      messages: [{ role: 'user', content: ctx + '\n\nWrite the final report now.' }],
      signal: opts.signal,
      shouldCancel: opts.stale,
      onToken: (chunk, full) => {
        if (opts.stale()) return;
        renderer.update(full);
        scrollToBottom();
      }
    });
    if (opts.stale() || r.cancelled) return;
    const text = (r.content || '').trim() || '(the team finished but produced no report)';
    renderer.finish(text);
    bubble.classList.remove('streaming');
    projectJournal.push({ t: Date.now(), type: 'report', name: seat.name, seat: seat.i, text });
    pjPersistJournal([projectJournal[projectJournal.length - 1]]);
  } catch (e) {
    if (e.name !== 'AbortError' && !opts.stale()) {
      renderer.finishPlain(`(report failed: ${e.message})`);
    }
  }
}

/* ---------- work session ---------- */
async function runProjectSession(instruction) {
  const my = setProjectRun(projectRun + 1);
  sweepReasoningTimers();
  const stale = () => my !== projectRun;
  setProjectBusy(true);
  setStreamingUi(true);
  updateModeStrip();
  const myAc = setAbortController(new AbortController());
  const opts = {
    signal: myAc.signal,
    stale,
    effort: activeProject.settings?.reasoning === 'none' ? 'none' : getConfig().reasoningEffort,
    verify: false
  };
  const seats = projectSeats();
  // Same reason as Debate Mode: pjTurnBudget trims eight steps of tool output
  // against the seat's context window, and the provider knows that number
  // exactly while the local table only guesses. Cached per provider per hour.
  warmProviderCatalogs(seats.map((s) => s.provider?.id)).catch(() => {});
  const maxTurns = Math.min(80, Math.max(4, Number(activeProject.settings?.maxTurns) || 24));
  let cur = Number.isInteger(activeProject.lastSeat) ? (activeProject.lastSeat + 1) % seats.length : 0;
  let doneStreak = 0;
  /** Successful workspace operations this session — the evidence behind "done" */
  let sessionWork = 0;
  let stopped = false;
  let finished = false;

  pjEmit({ type: 'session', phase: 'start' });

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (stale()) return;
      const seat = seats[cur % seats.length];
      opts.verify = doneStreak > 0;
      setProjectTurnNow(turn);
      setProjectTurnMax(maxTurns);
      renderProjectInspector();
      const out = await runProjectAgentTurn(seat, seats, instruction, turn, maxTurns, opts);
      if (stale()) return;
      refreshProjectFiles();
      renderProjectInspector();
      if (out.aborted) { stopped = true; break; }
      if (!out.ok) {
        pjEmit({ type: 'sys', kind: 'error', text: `${seat.name}'s turn failed: ${out.err?.message || 'provider error'} — session ended.` });
        break;
      }
      activeProject.lastSeat = seat.i;
      pjApi('/api/projects/update', { id: activeProject.id, patch: { lastSeat: seat.i } }).catch(() => {});
      pushRecentModel(seat.model, seat.provider?.id);

      // "Done" is a claim about the workspace, so it has to be answerable from
      // the workspace. Two failure modes are worth refusing outright:
      // a team that declares victory without having touched anything, and a
      // verifier who signs off without looking. Both end sessions that produced
      // nothing but a confident final report.
      const gate = evaluateProjectDoneClaim({
        status: out.status,
        did: out.did,
        sessionWork,
        verifying: opts.verify,
        seatName: seat.name
      });
      sessionWork = gate.sessionWork;
      if (out.status === 'done') {
        if (gate.refusal) {
          doneStreak = 0;
          pjEmit({ type: 'sys', kind: 'error', text: gate.refusal });
          cur = (cur + 1) % seats.length;
          continue;
        }
        doneStreak++;
      } else {
        doneStreak = 0;
      }

      if (out.status === 'blocked') {
        pjEmit({ type: 'sys', text: `${seat.name} needs your input${out.note ? `: ${out.note}` : ''} — reply below to continue.` });
        finished = true;
        break;
      }
      if (doneStreak >= Math.min(seats.length, 2)) {
        // Two independent confirmations end the session (the claimer plus one
        // verifier), which on a 2-member team IS the whole team. Larger teams
        // deliberately do not need every seat to re-verify the same work.
        await runProjectReport(seat, instruction, opts);
        if (stale()) return;
        pjEmit({ type: 'session', phase: 'end', reason: 'complete ✓' });
        flashMarkAgreed();
        finished = true;
        break;
      }
      // A pending "done" claim is verified by SOMEONE ELSE. A member that ends
      // its turn with `TO: <its own name>` resolved straight back to itself, so
      // the claimer ran the verification turn — one inspect call satisfied the
      // gate and it signed off on its own work, which is precisely what the
      // independent-verifier rule exists to prevent. Self-handoff is ignored
      // here (there are always ≥2 members, so round-robin finds another seat).
      const handoff = resolveProjectNextSeat({
        to: out.to,
        seats,
        currentIndex: cur,
        currentSeat: seat,
        doneStreak
      });
      if (handoff.selfHandoffIgnored) {
        pjEmit({
          type: 'sys',
          text: `${seat.name} claimed done and asked to continue — a teammate verifies instead.`
        });
      }
      cur = handoff.nextIndex;
    }

    if (!finished && !stopped && !stale()) {
      pjEmit({ type: 'session', phase: 'end', reason: `turn limit (${maxTurns}) reached — say "continue" to keep going` });
    }
    if (stopped && !stale()) {
      pjEmit({ type: 'session', phase: 'end', reason: 'stopped' });
    }
  } catch (err) {
    if (!stale() && err.name !== 'AbortError') {
      pjEmit({ type: 'sys', kind: 'error', text: `Session error: ${err.message || err}` });
    } else if (!stale()) {
      pjEmit({ type: 'session', phase: 'end', reason: 'stopped' });
    }
  } finally {
    // The global stream/UI resets must survive a stale run: toggling Project
    // Mode off or switching projects mid-session bumps projectRun WITHOUT
    // starting a new stream, and gating these on !stale() left isStreaming
    // stuck true — Enter only ever reached stopStreaming() and the app was
    // bricked until reload. Skip them only when a NEWER stream has already
    // installed its own controller and therefore owns the UI.
    const takenOver = abortController && abortController !== myAc;
    if (!takenOver) {
      setProjectBusy(false);
      if (abortController === myAc) setAbortController(null);
      statusText.classList.remove('thinking-status');
      statusText.textContent = READY_STATUS;
      setStreamingUi(false);
      updateModeStrip();
    }
    // Project-specific re-renders still belong to the run that owns the data
    if (!stale()) {
      renderProjectTasksList();
      refreshProjectFiles();
      renderProjectInspector();
      userInput.focus();
    }
  }
}

export { PJ_INNER_STEPS, buildProjectTurnContext, pjTurnBudget, runProjectAgentTurn, runProjectReport, runProjectSession };
