import { contextLimitFor, getContextUsage, updateContextUI } from '../context.js';
import { buildDebateCredit, createDebateArena } from '../debate/arena.js';
import { DEBATE_DEFAULT_PERSONA, DEBATE_MAX_SEATS, applyDebateVote, buildDebateTurnMessage, debateAnswerAttribution, debateHasConsensus, debateLiveSeats, discardOpeningVotes, dropDebateSeat, expertSystemPrompt, formatDebateTranscript, joinNames, judgeSystemPrompt, parseDebateStatus, pickDebatePresenter, presenterSystemPrompt, stripStreamingStatusTail } from '../debate/protocol.js';
import { debateSettings } from '../debate/settings.js';
import { validateDebateSetup } from '../debate/ui.js';
import { pushHistoryMessage, scheduleHistorySave } from '../history.js';
import { pushRecentModel, warmProviderCatalogs } from '../models.js';
import { sleep, streamCompletion } from '../net/stream.js';
import { localAgentId, providers } from '../providers.js';
import { abortController, chatSession, messages, setAbortController, statusText, tokenInfo, userInput } from '../state.js';
import { estimateTokens, formatTokenCount } from '../tokens.js';
import { dockArenaIntoMessage, mountArena } from '../ui/inspector.js';
import { flashMarkAgreed } from '../ui/mark.js';
import { createStreamRenderer } from '../ui/renderer.js';
import { openSidebar, setSidebarPanel } from '../ui/sidebar.js';
import { READY_STATUS, addMessageActions, appendError, appendMessage, createReasoningPanel, destroyReasoningPanel, finalizeReasoningPanel, flashStatus, markOrphanMessage, markStreamUnread, retryLastTurn, scrollToBottom, setStreamingUi, stickToBottom, unwindLastUserExchange, updateReasoningStream } from '../ui/transcript.js';

/** Prior chat history (final answers only), capped so debate calls stay lean */
function buildDebatePriorContext() {
  const prior = messages.slice(0, -1); // everything before the just-pushed task
  if (!prior.length) return '';
  const lines = prior.map(
    (m) => `${m.role === 'user' ? 'Client' : "Team's previous answer"}: ${m.content}`
  );
  let block = lines.join('\n\n');
  if (block.length > 8000) block = '…\n' + block.slice(-8000);
  return block;
}

/**
 * Format the debate transcript, dropping OLDEST turns first when it exceeds
 * charBudget (the newest turn is always kept). Returns { text, omitted }.
 */

/**
 * Char budget for a seat's transcript block, from the seat model's context
 * limit (provider-detected when cached, else the known-model table).
 * ~3 chars/token is deliberately conservative; generous reserve covers the
 * system prompt, task, prior-chat block, and the completion itself.
 */
function seatTranscriptBudget(seat, cfg) {
  const { limit } = contextLimitFor(seat.provider?.id || '', seat.model);
  const reserveTokens = (cfg.maxTokens || 1600) + 2400;
  return Math.max(3000, (limit - reserveTokens) * 3);
}

// ========== DEBATE MODE — engine ==========
/**
 * Orchestrates a full debate: round-robin expert turns → peer consensus →
 * presentation turn streamed into a normal assistant bubble. isStreaming is
 * true for the whole run; abort kills the current fetch and the loop; the
 * chatSession guard is checked between every await.
 */
async function runDebate(cfg, task) {
  const mySession = chatSession;
  const isStale = () => mySession !== chatSession;
  const ds = debateSettings;

  // Seat model/provider are explicit user choices, validated by
  // validateDebateSetup() before this runs — no silent fallbacks here.
  const seats = ds.experts.slice(0, DEBATE_MAX_SEATS).map((e, i) => ({
    i,
    name: (e.name || `Expert ${i + 1}`).trim() || `Expert ${i + 1}`,
    persona: (e.persona || '').trim() || DEBATE_DEFAULT_PERSONA,
    model: (e.model || '').trim(),
    provider: providers.length === 1 ? providers[0] : providers.find((p) => p.id === e.providerId),
    status: 'continue',
    nominee: null,
    /** Set when the seat's provider fails twice — it sits out the rest of the debate */
    dropped: false
  }));
  // Callers pre-validate via validateDebateSetup(); this is a last-resort guard
  if (seats.length < 2 || seats.some((s) => !s.model || !s.provider)) {
    appendError(`Debate setup: ${validateDebateSetup() || 'incomplete expert configuration.'}`);
    openSidebar();
    setSidebarPanel('debate');
    return;
  }
  const expertEffort = ds.expertReasoning === 'inherit' ? cfg.reasoningEffort : 'none';

  // Learn every seat model's real context window before the first trim decision
  // is made. Cached per provider for an hour, so this is usually free; without
  // it a seat on an unfamiliar model is trimmed against the local table's
  // 128k default, which is a guess the provider can answer exactly.
  warmProviderCatalogs(seats.map((s) => s.provider?.id).concat(ds.judge?.providerId)).catch(
    () => {}
  );

  setStreamingUi(true);
  statusText.textContent = 'Team debating…';
  statusText.classList.add('thinking-status');
  tokenInfo.textContent = '';
  updateContextUI();

  const usage = getContextUsage();
  if (usage.pct >= 98) {
    appendError(
      `Context nearly full (~${Math.round(usage.pct)}% of ${formatTokenCount(usage.limit)}). Start a new chat or raise the limit.`
    );
  } else if (usage.pct >= 85) {
    flashStatus(`Context high · ${Math.round(usage.pct)}% of ${formatTokenCount(usage.limit)}`, 2500);
  }

  const { msgEl, bubble, body: msgBody } = appendMessage('assistant', '', true);
  bubble.classList.add('hidden-until-content');
  const arena = createDebateArena(seats, ds.maxRounds);
  // Live arena goes to the inspector (falls back inline when it isn't visible)
  mountArena(arena.el, msgBody, bubble);
  scrollToBottom();

  setAbortController(new AbortController());
  const signal = abortController.signal;

  const prior = buildDebatePriorContext();
  const transcript = []; // { name, text, seatIdx, round }
  let transcriptTokens = 0;
  /** Real provider-reported usage summed across every debate call */
  const debateUsage = { in: 0, out: 0 };
  let contextTrimWarned = false;
  let consensus = false;
  let stopped = false;
  let errored = false;
  let roundsRun = 0;
  let presenter = null;
  let finalContent = '';
  /** Final answer's chain-of-thought panel (function-scoped so `finally` can stop its timer) */
  let finalRApi = null;

  const addDebateUsage = (u) => {
    if (isStale() || !u) return;
    debateUsage.in += u.prompt_tokens ?? u.input_tokens ?? 0;
    debateUsage.out += u.completion_tokens ?? u.output_tokens ?? 0;
    arena.setTokens(transcriptTokens, debateUsage);
  };

  /**
   * Record a finished turn's vote. An AGREE is only valid while nothing
   * contentious follows it: when a seat raises open problems (CONTINUE),
   * every earlier agreement predates those problems, so those seats must
   * re-confirm. Consensus therefore needs an unbroken all-seats run of AGREEs.
   */
  const applyStatus = (seat, status, nominee) => {
    applyDebateVote(seats, seat, status, nominee);
    for (const s of seats) arena.setSeatStatus(s.i, s.status === 'agree');
  };

  /** Seats still able to speak — a dropped seat's provider failed twice. */
  const liveSeats = () => debateLiveSeats(seats);
  /**
   * Consensus = every live seat agrees. Only meaningful once the round is
   * informed: in the blind opening round nobody has read anyone else, so an
   * AGREE is an opinion about one's own answer, not about the team's.
   */
  const hasConsensus = () => debateHasConsensus(seats);
  /**
   * Retire a seat whose provider failed twice. The debate continues as long as
   * two experts remain — a team of models exists precisely so one bad endpoint
   * does not decide the answer. Returns false when too few seats are left.
   */
  const dropSeat = (seat, err) => {
    dropDebateSeat(seat);
    arena.setSeatDropped(seat.i);
    const left = liveSeats();
    arena.addNote(
      left.length >= 2
        ? `⚠ ${seat.name} dropped out (${err?.message || 'provider error'}) — ${joinNames(left.map((s) => s.name))} continue without ${seat.name}.`
        : `⚠ ${seat.name} dropped out (${err?.message || 'provider error'}) — too few experts left to keep debating.`
    );
    return left.length >= 2;
  };

  /** Transcript block sized to this seat's model context; warns once on trim */
  const transcriptForSeat = (seat) => {
    const { text, omitted } = formatDebateTranscript(transcript, seatTranscriptBudget(seat, cfg));
    if (omitted > 0 && !contextTrimWarned) {
      contextTrimWarned = true;
      arena.addNote(
        "ℹ The discussion no longer fits every model's context window — oldest turns are omitted from prompts (the arena still shows everything)."
      );
    }
    return text;
  };

  /** One expert/presenter completion; retried once by callers on failure */
  const callSeat = (seat, sys, userMsg, onToken, onReasoningToken, effortOverride) =>
    streamCompletion({
      baseURL: seat.provider.baseURL,
      apiKey: seat.provider.apiKey,
      model: seat.model,
      agent: localAgentId(seat.provider),
      reasoningEffort: effortOverride != null ? effortOverride : expertEffort,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      systemPrompt: sys,
      messages: [{ role: 'user', content: userMsg }],
      signal,
      shouldCancel: isStale,
      onToken,
      onReasoningToken,
      onUsage: addDebateUsage
    });

  /**
   * One seat's complete turn: prompt build, streamed call with one retry
   * (short backoff so rate-limited providers get room to recover), status
   * parse. Returns { ok, status, nominee, cleanText } on success,
   * { aborted: true } on user stop / stale session, { ok: false, err } on
   * failure after retry. Shared by the parallel blind round and serial rounds.
   */
  const runSeatTurn = async (seat, round, turnUi) => {
    const blind = round === 1;
    const finalRound = !blind && round === ds.maxRounds;
    // Address only the experts still in the room — a dropped seat is not
    // a colleague whose silence needs explaining.
    const roster = liveSeats().length >= 2 ? liveSeats() : seats;
    const sys = expertSystemPrompt(seat, roster, { blind, finalRound });
    const userMsg = buildDebateTurnMessage({
      task,
      prior,
      transcript: [],
      transcriptText: blind ? null : transcriptForSeat(seat),
      seat,
      blind
    });

    let result = null;
    let turnErr = null;
    let lastFull = '';
    // Stop/stale mid-turn: settle the thought panel — its elapsed interval
    // otherwise ticks for the rest of the page's life and the card sits in
    // "Thinking…" forever — and close the caret over whatever text arrived.
    const abandon = () => {
      turnUi.settleReasoning({ stopped: true });
      turnUi.finish(stripStreamingStatusTail(lastFull));
      return { aborted: true };
    };
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try {
        if (attempt > 1) {
          await sleep(900);
          if (isStale() || signal.aborted) return abandon();
          turnUi.reset();
        }
        const r = await callSeat(
          seat,
          sys,
          userMsg,
          (chunk, full) => {
            lastFull = full;
            if (isStale()) return;
            turnUi.settleReasoning();
            turnUi.update(stripStreamingStatusTail(full));
            if (!stickToBottom) markStreamUnread();
            scrollToBottom();
          },
          (piece) => {
            if (isStale()) return;
            turnUi.updateReasoning(piece);
            if (!stickToBottom) markStreamUnread();
            scrollToBottom();
          }
        );
        if (isStale() || r.cancelled) return abandon();
        if (r.error) throw new Error(r.error);
        result = r;
      } catch (err) {
        if (err.name === 'AbortError' || isStale()) return abandon();
        turnErr = err;
      }
    }
    if (!result) {
      // Close the card out explicitly — otherwise the seat that just failed
      // sits there with a blinking caret, looking like it is still thinking.
      turnUi.finish(`(no answer — ${turnErr?.message || 'provider error'})`);
      turnUi.el.classList.add('debate-turn-failed');
      return { ok: false, err: turnErr };
    }

    // Success — remember model for recents
    pushRecentModel(seat.model, seat.provider?.id);
    const { status, nominee, cleanText } = parseDebateStatus(result.content);
    // Immediate visual feedback; applyStatus() later settles cross-seat
    // vote resets in deterministic seat order
    arena.setSeatStatus(seat.i, status === 'agree');
    turnUi.finish(cleanText);
    return { ok: true, status, nominee, cleanText };
  };

  const useJudge = ds.finalAnswerMode === 'judge';
  let judgeSeat = null;
  if (useJudge) {
    const j = ds.judge || {};
    const jProv =
      providers.length === 1
        ? providers[0]
        : providers.find((p) => p.id === j.providerId);
    judgeSeat = {
      name: 'Judge',
      model: String(j.model || '').trim(),
      provider: jProv
    };
  }

  try {
    // ---- Turn loop: up to maxRounds full rounds ----
    // Round 1 is BLIND and PARALLEL: no seat sees the others, so all experts
    // stream their independent takes concurrently (≈N× faster wall-clock).
    // Later rounds are strict round-robin over the shared transcript.
    outer: for (let round = 1; round <= ds.maxRounds; round++) {
      roundsRun = round;
      arena.setRound(round);
      // Always show a divider; round 1 labeled "independent takes"
      arena.addRoundDivider(round, { blind: round === 1 });

      if (round === 1) {
        arena.setAllSpeaking();
        statusText.textContent = 'Experts writing independent takes…';
        // addTurn runs synchronously before the first await, so the arena
        // lays the turn cards out in seat order regardless of finish order
        const turnUis = seats.map((seat) => arena.addTurn(seat));
        const outcomes = await Promise.all(
          seats.map((seat, k) => runSeatTurn(seat, 1, turnUis[k]))
        );
        if (isStale()) return;
        // Harvest BEFORE reacting to a stop. Seats run in parallel here, so
        // pressing Esc while the slowest is still writing used to throw away
        // takes that had already arrived complete — and with an empty
        // transcript the stop path unwinds the user's message too, erasing an
        // exchange they watched happen.
        const abortedRound = outcomes.some((o) => o && o.aborted);
        for (let k = 0; k < seats.length; k++) {
          const out = outcomes[k];
          if (out && out.ok) {
            applyStatus(seats[k], out.status, out.nominee);
            transcript.push({ name: seats[k].name, text: out.cleanText, seatIdx: seats[k].i, round: 1 });
            transcriptTokens += estimateTokens(out.cleanText);
            continue;
          }
          // A stop cancelled the rest — that is the user's doing, not a bad
          // endpoint, so those seats are not dropped or blamed in the arena.
          if (abortedRound) continue;
          errored = true;
          dropSeat(seats[k], out?.err);
        }
        arena.setTokens(transcriptTokens, debateUsage);
        if (abortedRound) {
          stopped = true;
          break outer;
        }

        if (liveSeats().length < 2) {
          arena.addNote('⚠ Fewer than two experts are answering — ending the debate early.');
          break outer;
        }
        // Blind agreement is not agreement: every seat wrote without reading a
        // word of anyone else's take. Clear the opening votes so consensus can
        // only be earned in a round where the whole transcript was on the table.
        discardOpeningVotes(seats);
        for (const s of liveSeats()) {
          arena.setSeatStatus(s.i, false);
        }
        if (ds.maxRounds > 1) {
          arena.addNote(
            'Independent takes are in. Nobody has read anyone else yet, so agreement starts counting from the next round.'
          );
        }
        continue;
      }

      for (const seat of liveSeats()) {
        if (isStale()) return;
        arena.setSpeaking(seat.i);
        statusText.textContent = `${seat.name} speaking…`;

        const turnUi = arena.addTurn(seat);
        const out = await runSeatTurn(seat, round, turnUi);
        if (isStale()) return;
        if (out.aborted) {
          stopped = true;
          break outer;
        }
        if (!out.ok) {
          errored = true;
          if (!dropSeat(seat, out.err)) break outer;
          // A drop redefines who "everyone" is. Consensus is only ever tested
          // after a SUCCESSFUL turn, so without this an already-agreed team
          // whose last seat dies is recorded as "no full consensus" — and,
          // mid-schedule, pays for another whole round to rediscover it.
          if (hasConsensus()) {
            consensus = true;
            break outer;
          }
          continue;
        }

        applyStatus(seat, out.status, out.nominee);
        transcript.push({ name: seat.name, text: out.cleanText, seatIdx: seat.i, round });
        transcriptTokens += estimateTokens(out.cleanText);
        arena.setTokens(transcriptTokens, debateUsage);

        if (hasConsensus()) {
          consensus = true;
          break outer;
        }
      }
    }

    if (isStale()) return;

    // ---- No usable discussion at all → existing error path ----
    if (!stopped && transcript.length === 0) {
      throw new Error('debate produced no turns');
    }

    if (!stopped && transcript.length > 0) {
      const live = liveSeats();
      arena.addNote(
        consensus
          ? `✓ Full consensus — ${joinNames(live.map((s) => s.name))} agree. Moving to the final answer.`
          : live.length < 2
            ? 'The final answer will be written from the takes that did arrive.'
            : `Round limit reached (${roundsRun}/${ds.maxRounds}) without full consensus — the final answer will resolve the remaining disagreements.`
      );
    }

    // ---- Abort before any answer: keep transcript when one exists ----
    if (stopped) {
      arena.finalize({ rounds: roundsRun, presenter: null, consensus, stopped: true });
      statusText.classList.remove('thinking-status');
      if (transcript.length === 0) {
        // Nothing completed — unwind like a normal-chat cancel
        unwindLastUserExchange(msgEl, true);
        statusText.textContent = 'Cancelled';
      } else {
        bubble.remove();
        markOrphanMessage(msgEl);
        statusText.textContent = 'Stopped';
      }
      return;
    }

    // ---- Final answer: nominated expert (default) OR neutral judge ----
    const judgeUsed = !!(useJudge && judgeSeat?.provider && judgeSeat.model);
    if (useJudge && !judgeUsed) {
      // validateDebateSetup() should make this unreachable — never fall back silently
      arena.addNote('⚠ Judge model/provider unavailable — falling back to a team-nominated presenter.');
    }
    // Credit and brief the final writer with the experts who actually spoke —
    // naming a seat that dropped out would overstate who stands behind this answer.
    const finalRoster = liveSeats().length ? liveSeats() : seats;
    let attribution = debateAnswerAttribution({
      judgeDelivered: judgeUsed,
      judgeSeat,
      seats
    });
    const creditNames = attribution.creditNames;
    let finalLabel = '';
    let creditOpts = { mode: attribution.mode };
    let callFinal;
    /** The credit line above the answer — replaced if the final writer changes */
    let creditEl = null;
    const setCredit = (label, opts) => {
      const el = buildDebateCredit(label, creditNames, opts);
      if (creditEl && creditEl.parentNode) creditEl.replaceWith(el);
      else msgBody.insertBefore(el, bubble);
      creditEl = el;
    };

    /**
     * Hand the final answer to the expert the team nominated. This is the
     * default path, and also the judge's fallback: a judge whose endpoint dies
     * is one bad endpoint, and a team of models exists precisely so one of those
     * cannot decide the answer. The alternative is discarding a finished N-seat
     * debate — the most expensive thing this app does — over a single 500.
     */
    const useNominatedPresenter = () => {
      presenter = pickDebatePresenter(seats);
      finalLabel = presenter.name;
      creditOpts = { mode: 'nominated' };
      arena.setPresenting(presenter);
      statusText.textContent = `${presenter.name} writing the final answer…`;
      setCredit(presenter.name, creditOpts);
      const presSys = presenterSystemPrompt(presenter, finalRoster, { consensus });
      const presMsg = buildDebateTurnMessage({
        task,
        prior,
        transcript,
        transcriptText: transcriptForSeat(presenter),
        seat: presenter,
        presenter: true
      });
      callFinal = (onToken, onReasoningToken) =>
        callSeat(presenter, presSys, presMsg, onToken, onReasoningToken, cfg.reasoningEffort);
    };

    if (judgeUsed) {
      finalLabel = `Judge (${judgeSeat.model})`;
      arena.setJudging(finalLabel);
      statusText.textContent = `${finalLabel} writing the final answer…`;
      creditOpts = { mode: 'judge', model: judgeSeat.model };
      setCredit(finalLabel, creditOpts);
      const judgeSys = judgeSystemPrompt(finalRoster);
      const judgeMsg = buildDebateTurnMessage({
        task,
        prior,
        transcript,
        transcriptText: transcriptForSeat(judgeSeat),
        seat: { name: 'Judge' },
        presenter: true,
        judge: true
      });
      callFinal = (onToken, onReasoningToken) =>
        streamCompletion({
          baseURL: judgeSeat.provider.baseURL,
          apiKey: judgeSeat.provider.apiKey,
          model: judgeSeat.model,
          agent: localAgentId(judgeSeat.provider),
          // The final deliverable is what the user reads — it always gets the
          // global reasoning effort, independent of the expert setting.
          reasoningEffort: cfg.reasoningEffort,
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
          systemPrompt: judgeSys,
          messages: [{ role: 'user', content: judgeMsg }],
          signal,
          shouldCancel: isStale,
          onToken,
          onReasoningToken,
          onUsage: addDebateUsage
        });
      presenter = { name: finalLabel, model: judgeSeat.model };
    } else {
      useNominatedPresenter();
    }

    bubble.classList.remove('hidden-until-content');
    const renderer = createStreamRenderer(bubble);
    scrollToBottom();

    // Final answer's chain of thought — same panel treatment as normal chat
    let finalRText = '';
    const onFinalReasoning = (piece) => {
      if (isStale()) return;
      if (!finalRApi) {
        finalRApi = createReasoningPanel({ expectStream: true });
        msgBody.insertBefore(finalRApi.el, bubble);
      }
      finalRText += piece;
      updateReasoningStream(finalRApi, finalRText);
      if (!stickToBottom) markStreamUnread();
      scrollToBottom();
    };
    const settleFinalReasoning = (stoppedNow = false) => {
      if (finalRApi && !finalRApi.finalized) {
        finalizeReasoningPanel(finalRApi, { forceOpen: false, stopped: stoppedNow });
      }
    };

    /** Clear any partial answer/thinking so a new attempt starts on a clean slate */
    const resetFinalStream = () => {
      finalContent = '';
      renderer.update('');
      if (finalRApi) {
        finalRApi = destroyReasoningPanel(finalRApi);
        finalRText = '';
      }
    };

    let presResult = null;
    let presErr = null;
    /** True once a failed judge has handed the final answer to the team's nominee */
    let fellBackFromJudge = false;
    for (let attempt = 1; attempt <= 2 && !presResult; attempt++) {
      try {
        if (attempt > 1) {
          await sleep(1100);
          if (isStale()) return;
          // A stop landed inside the backoff. Returning here skipped every
          // settle path: the bubble kept its streaming caret, the status bar
          // stayed "…writing the final answer", the message shell was never
          // orphaned (so history and the transcript fell out of step) and the
          // arena collapsed claiming a presenter that never presented. Fall
          // through to the normal stopped handling instead.
          if (signal.aborted) {
            stopped = true;
            break;
          }
          // Clean slate: drop any partial text/reasoning from the failed try
          resetFinalStream();
        }
        const r = await callFinal((chunk, full) => {
          if (isStale()) return;
          settleFinalReasoning();
          finalContent = full;
          renderer.update(full);
          if (!stickToBottom) markStreamUnread();
          scrollToBottom();
        }, onFinalReasoning);
        if (isStale() || r.cancelled) return;
        if (r.error) throw new Error(r.error);
        presResult = r;
      } catch (err) {
        if (err.name === 'AbortError') {
          stopped = true;
          break;
        }
        if (isStale()) return;
        presErr = err;
      }
      // The judge has now spent both its attempts. Rather than discard a
      // finished debate because one endpoint is down, hand the write-up to the
      // expert the team nominated — the same fallback already applied when the
      // judge is misconfigured — and give that writer its own two attempts.
      if (
        !presResult &&
        !stopped &&
        judgeUsed &&
        !fellBackFromJudge &&
        attempt >= 2 &&
        liveSeats().length > 0
      ) {
        fellBackFromJudge = true;
        attribution = debateAnswerAttribution({
          judgeDelivered: false,
          judgeSeat,
          seats
        });
        arena.addNote(
          `⚠ ${finalLabel} could not deliver (${presErr?.message || 'provider error'}) — the team's nominee writes the final answer instead.`
        );
        useNominatedPresenter();
        resetFinalStream();
        attempt = 0; // the new writer starts its own attempt budget
      }
    }

    /** Did the judge actually write this answer? A fallback makes it nominated. */
    const judgeDelivered = attribution.mode === 'judge' && !fellBackFromJudge;

    // A blank deliverable is a failure, not a success to push into history
    if (presResult && !String(presResult.content || '').trim()) {
      presErr = presErr || new Error('provider returned an empty final answer');
      presResult = null;
    }

    settleFinalReasoning(stopped);
    bubble.classList.remove('streaming', 'hidden-until-content');

    if (presResult) {
      // Defensive: some models leak the status marker despite instructions
      finalContent = parseDebateStatus(presResult.content).cleanText || presResult.content;
      renderer.finish(finalContent);
      transcriptTokens += estimateTokens(finalContent);
      arena.setTokens(transcriptTokens, debateUsage);
      if (judgeDelivered) {
        pushRecentModel(judgeSeat.model, judgeSeat.provider?.id);
      } else if (presenter?.model) {
        pushRecentModel(presenter.model, presenter.provider?.id);
      }
    } else if (stopped && finalContent) {
      // Aborted mid-presentation with partial text — keep it, but do not
      // treat it as a finished consensus answer (reload / next debate
      // would otherwise inherit a truncated deliverable).
      renderer.finish(finalContent + '\n\n*[stopped]*');
    } else if (stopped) {
      arena.finalize({ rounds: roundsRun, presenter: finalLabel, consensus, stopped: true });
      bubble.remove();
      markOrphanMessage(msgEl);
      statusText.classList.remove('thinking-status');
      statusText.textContent = 'Stopped';
      return;
    } else {
      // Presentation failed twice — keep the transcript, surface the error
      arena.finalize({ rounds: roundsRun, presenter: finalLabel, consensus, errored: true });
      bubble.remove();
      markOrphanMessage(msgEl);
      appendError(`Debate presentation failed: ${presErr?.message || 'provider error'}`, {
        onRetry: () => retryLastTurn({ debate: true }),
        retryLabel: '↻ Retry debate'
      });
      statusText.classList.remove('thinking-status');
      statusText.textContent = 'Error — fix config and try again';
      return;
    }

    // ---- Success: only the final answer enters history ----
    const stored = stopped && finalContent ? `${finalContent}\n\n*[stopped]*` : finalContent;
    const m = pushHistoryMessage('assistant', stored);
    // The final writer's chain of thought is restored from history exactly like
    // a solo reply's (sessions.js rebuilds the panel when `reasoning` is set) —
    // it just was never saved, so it silently vanished on reload.
    if (finalRText) {
      m.reasoning = finalRText;
      if (finalRApi?.durationMs) m.reasoningMs = finalRApi.durationMs;
    }
    if (consensus && !stopped) flashMarkAgreed();
    m.debate = {
      experts: creditNames,
      // Original indexes so restore can keep chip/turn colours after a dropout.
      roster: seats.map((s) => ({ name: s.name, i: s.i, dropped: !!s.dropped })),
      rounds: roundsRun,
      presenter: finalLabel,
      consensus: !!(consensus && !stopped),
      stopped: !!stopped,
      // `i` = seat index — restores colors/attribution even with duplicate names
      turns: transcript.map((t) => ({ name: t.name, text: t.text, round: t.round, i: t.seatIdx })),
      finalAnswerMode: judgeDelivered ? 'judge' : 'nominated',
      judgeModel: judgeDelivered ? judgeSeat?.model || '' : undefined
    };
    addMessageActions(msgEl, msgBody, stored);
    arena.finalize({
      rounds: roundsRun,
      presenter: finalLabel,
      consensus,
      stopped,
      errored
    });
    statusText.classList.remove('thinking-status');
    statusText.textContent = stopped ? 'Stopped' : READY_STATUS;
    updateContextUI();
  } catch (err) {
    if (isStale()) return;
    statusText.classList.remove('thinking-status');
    if (err.name === 'AbortError') {
      arena.finalize({ rounds: roundsRun, presenter: null, consensus, stopped: true });
      if (transcript.length === 0) {
        unwindLastUserExchange(msgEl, true);
        statusText.textContent = 'Cancelled';
      } else {
        bubble.remove();
        markOrphanMessage(msgEl);
        statusText.textContent = 'Stopped';
      }
    } else {
      console.error(err);
      if (transcript.length === 0) {
        arena.el.remove();
        // Keep the user's message in history AND view — what you see is what
        // the model receives next turn; only the empty assistant shell goes
        if (msgEl && msgEl.parentNode) msgEl.remove();
      } else {
        // Keep the partial discussion readable instead of vaporizing it
        if (!arena.finalized) {
          arena.finalize({ rounds: roundsRun, presenter: null, consensus, errored: true });
        }
        bubble.remove();
        markOrphanMessage(msgEl);
      }
      appendError(`Debate error: ${err.message || String(err)}`, {
        onRetry:
          messages.length > 0 && messages[messages.length - 1].role === 'user'
            ? () => retryLastTurn({ debate: true })
            : null,
        retryLabel: '↻ Retry debate'
      });
      statusText.textContent = 'Error — fix config and try again';
    }
  } finally {
    // Always stop the clocks: a stale session (New Chat mid-debate) detaches
    // the arena but its interval would otherwise keep firing forever.
    arena.stopTimer();
    // The finished transcript belongs with the answer, not in the inspector
    dockArenaIntoMessage();
    if (finalRApi && !finalRApi.finalized) {
      finalRApi = destroyReasoningPanel(finalRApi, { remove: isStale() });
    }
    if (!isStale()) {
      if (!arena.finalized) {
        arena.finalize({ rounds: roundsRun, presenter: presenter?.name, consensus, stopped, errored });
      }
      setAbortController(null);
      statusText.classList.remove('thinking-status');
      setStreamingUi(false);
      userInput.focus();
      scheduleHistorySave(); // runs after isStreaming=false so the save isn't skipped
    }
  }
}

export { buildDebatePriorContext, runDebate, seatTranscriptBudget };
