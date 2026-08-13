import { DRAFT_KEY } from './compose.js';
import { getContextUsage, updateContextUI } from './context.js';
import { pushHistoryMessage, scheduleHistorySave } from './history.js';
import { pushRecentModel } from './models.js';
import { shouldRetryStream, sleep, soloAssistantDisposition, streamCompletion } from './net/stream.js';
import { chatSession, messages, setAbortController, setLastCompletionTokens, setLastGenStats, setLastPromptTokens, setLastThinkMs, statusText, tokenInfo, userInput } from './state.js';
import { formatTokenCount } from './tokens.js';
import { createStreamRenderer } from './ui/renderer.js';
import { autoResize } from './ui/sidebar.js';
import { READY_STATUS, addMessageActions, appendError, appendMessage, createReasoningPanel, destroyReasoningPanel, finalizeReasoningPanel, flashStatus, markOrphanMessage, markStreamUnread, retryLastTurn, scrollToBottom, setStreamingUi, stickToBottom, unwindLastUserExchange, updateReasoningStream } from './ui/transcript.js';

function restoreComposerDraft() {
  try {
    const v = localStorage.getItem(DRAFT_KEY);
    if (v && !userInput.value) {
      userInput.value = v;
      autoResize();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Core streaming pipeline. Assumes the latest user turn is already in
 * `messages`. Shared by sendMessage() and regenerate() so the logic isn't
 * duplicated.
 */
async function streamAssistantReply(cfg) {
  // Capture session so New Chat during stream cannot corrupt the next conversation
  const mySession = chatSession;

  setStreamingUi(true);
  statusText.textContent = 'Thinking…';
  statusText.classList.add('thinking-status');
  tokenInfo.textContent = '';
  updateContextUI();

  // Soft-block if clearly over context (still allow send, but warn hard)
  const usage = getContextUsage();
  if (usage.pct >= 98) {
    appendError(
      `Context nearly full (~${Math.round(usage.pct)}% of ${formatTokenCount(usage.limit)}). Start a new chat or raise the limit.`
    );
  } else if (usage.pct >= 85) {
    flashStatus(`Context high · ${Math.round(usage.pct)}% of ${formatTokenCount(usage.limit)}`, 2500);
  }

  const { msgEl, bubble, body: msgBody } = appendMessage('assistant', '', true);
  const renderer = createStreamRenderer(bubble);
  let fullContent = '';
  let reasoningContent = '';
  let reasoningApi = null;
  let answerStarted = false;

  // Show thinking shell immediately when reasoning is requested
  const wantsReasoning = cfg.reasoningEffort && cfg.reasoningEffort !== 'none';
  if (wantsReasoning && msgBody) {
    reasoningApi = createReasoningPanel({ expectStream: true });
    msgBody.insertBefore(reasoningApi.el, bubble);
    bubble.classList.add('hidden-until-content');
  }

  // Keep a local handle: Stop (stopStreaming) NULLS the live binding, so a
  // retry attempt that re-read `abortController.signal` after the backoff
  // crashed with a TypeError instead of cancelling cleanly.
  const myAc = setAbortController(new AbortController());

  const isStale = () => mySession !== chatSession;

  const ensureReasoningPanel = () => {
    if (isStale() || reasoningApi || !msgBody) return;
    reasoningApi = createReasoningPanel({ expectStream: true });
    msgBody.insertBefore(reasoningApi.el, bubble);
    if (!fullContent) bubble.classList.add('hidden-until-content');
  };

  let genStartAt = 0;
  let lastTpsPaint = 0;
  /** completion_tokens reported for THIS turn only — the cross-turn binding
   * still holds the PREVIOUS turn's figure when this provider reports none,
   * which inflated t/s by whatever the last model happened to emit. */
  let turnOutTokens = null;

  const onAnswerToken = (chunk) => {
    if (isStale()) return;
    const now = performance.now();
    if (!answerStarted) {
      answerStarted = true;
      genStartAt = now;
      bubble.classList.remove('hidden-until-content');
      // Soft-close the thought panel once the answer begins
      if (reasoningApi && !reasoningApi.finalized) {
        finalizeReasoningPanel(reasoningApi, { forceOpen: false });
      }
      statusText.textContent = 'Writing…';
    }
    fullContent += chunk;
    renderer.update(fullContent);
    // Live throughput readout (rough chars/4 estimate, refreshed ~1.5×/s)
    if (now - lastTpsPaint > 650 && now - genStartAt > 900) {
      lastTpsPaint = now;
      const tps = Math.round(fullContent.length / 4 / ((now - genStartAt) / 1000));
      if (tps > 0) statusText.textContent = `Writing… · ~${tps} tok/s`;
    }
    if (!stickToBottom) markStreamUnread();
    scrollToBottom();
  };

  try {
    // Transparent single retry on transient failures (429/5xx/network) —
    // only when nothing has streamed yet, so content never duplicates.
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        statusText.textContent = 'Provider hiccup — retrying…';
        statusText.classList.add('thinking-status');
        await sleep(1200);
        if (isStale()) return;
        // Stop pressed during the backoff — unwind exactly like a mid-attempt
        // abort instead of starting attempt 2 against an aborted signal
        if (myAc.signal.aborted) {
          const e = new Error('The user aborted a request.');
          e.name = 'AbortError';
          throw e;
        }
        // Reset any partial reasoning from the failed attempt
        if (reasoningApi && !reasoningContent) {
          /* keep shell */
        } else if (reasoningApi) {
          reasoningApi = destroyReasoningPanel(reasoningApi);
          reasoningContent = '';
        }
      }
      try {
        result = await streamCompletion({
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          model: cfg.model,
          agent: cfg.agent,
          reasoningEffort: cfg.reasoningEffort,
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
          systemPrompt: cfg.systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          signal: myAc.signal,
          shouldCancel: isStale,
          onToken: (chunk) => onAnswerToken(chunk),
          onReasoningToken: (piece) => {
            if (isStale()) return;
            ensureReasoningPanel();
            reasoningContent += piece;
            updateReasoningStream(reasoningApi, reasoningContent);
            if (!stickToBottom) markStreamUnread();
            if (!answerStarted) {
              statusText.textContent = 'Thinking…';
              statusText.classList.add('thinking-status');
            }
            scrollToBottom();
          },
          onUsage: (u) => {
            if (isStale()) return;
            // Keep null when the provider reported no figure: null means "not
            // measured" and leaves the meter on its estimate, whereas 0 would
            // be read as a real measurement and print "last 0→0".
            const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
            const inTok = num(u.prompt_tokens) ?? num(u.input_tokens);
            const outTok = num(u.completion_tokens) ?? num(u.output_tokens);
            if (inTok != null) setLastPromptTokens(inTok);
            if (outTok != null) {
              setLastCompletionTokens(outTok);
              turnOutTokens = outTok;
            }
            updateContextUI();
          }
        });
      } catch (err) {
        if (
          shouldRetryStream({
            attempt,
            streamedAnswer: fullContent,
            error: err,
            stale: isStale(),
            aborted: err.name === 'AbortError'
          })
        ) {
          continue;
        }
        throw err;
      }
      if (
        shouldRetryStream({
          attempt,
          streamedAnswer: fullContent || result.content,
          error: result.error,
          cancelled: result.cancelled,
          stale: isStale()
        })
      ) {
        continue;
      }
      break;
    }

    if (isStale() || result.cancelled) return;

    if (result.error) {
      throw new Error(result.error);
    }

    if (isStale()) return;

    // Final throughput stats: THIS turn's usage when reported, estimate otherwise
    if (genStartAt) {
      const ms = Math.max(1, Math.round(performance.now() - genStartAt));
      const outTok = turnOutTokens || Math.round(fullContent.length / 4);
      setLastGenStats({ ms, tps: Math.round(outTok / (ms / 1000)) });
    }

    // Drop empty shell if model never streamed reasoning tokens
    if (reasoningApi && !reasoningContent) {
      reasoningApi = destroyReasoningPanel(reasoningApi);
      setLastThinkMs(null);
    } else if (reasoningApi && !reasoningApi.finalized) {
      // Finalize if answer never started (reasoning-only models)
      finalizeReasoningPanel(reasoningApi, {
        forceOpen: !fullContent && !!reasoningContent
      });
    }

    bubble.classList.remove('streaming', 'hidden-until-content');
    const disposition = soloAssistantDisposition({ fullContent, reasoningContent });
    if (disposition.display === 'content') {
      renderer.finish(fullContent);
      addMessageActions(msgEl, msgBody, fullContent);
    } else {
      renderer.finishPlain(disposition.content);
    }

    // Never push empty assistant content — some providers reject it next turn
    if (disposition.persist) {
      const m = pushHistoryMessage('assistant', fullContent);
      // Chain of thought survives reloads (restored as a collapsed panel)
      if (reasoningContent) {
        m.reasoning = reasoningContent;
        if (reasoningApi?.durationMs) m.reasoningMs = reasoningApi.durationMs;
        setLastThinkMs(reasoningApi?.durationMs || null);
      }
      pushRecentModel(cfg.model, cfg.providerId);
    }
    statusText.classList.remove('thinking-status');
    statusText.textContent = READY_STATUS;
    updateContextUI();
  } catch (err) {
    if (isStale()) return;
    statusText.classList.remove('thinking-status');
    if (err.name === 'AbortError') {
      if (isStale()) return;
      bubble.classList.remove('streaming', 'hidden-until-content');
      if (reasoningApi) finalizeReasoningPanel(reasoningApi, { stopped: true, forceOpen: !!reasoningContent && !fullContent });
      if (fullContent) {
        renderer.finish(fullContent + '\n\n*[stopped]*');
        addMessageActions(msgEl, msgBody, fullContent);
        const m = pushHistoryMessage('assistant', fullContent);
        if (reasoningContent) {
          m.reasoning = reasoningContent;
          if (reasoningApi?.durationMs) m.reasoningMs = reasoningApi.durationMs;
        }
        pushRecentModel(cfg.model, cfg.providerId);
        statusText.textContent = 'Stopped';
      } else if (reasoningContent) {
        // Keep the thought panel so user can read what was streamed; do not push empty assistant
        bubble.remove();
        markOrphanMessage(msgEl);
        statusText.textContent = 'Stopped';
      } else {
        unwindLastUserExchange(msgEl, true);
        statusText.textContent = 'Cancelled';
      }
    } else {
      if (isStale()) return;
      console.error(err);
      bubble.classList.remove('streaming', 'hidden-until-content');
      if (reasoningApi && !reasoningApi.finalized) {
        finalizeReasoningPanel(reasoningApi, { forceOpen: false, stopped: true });
      }
      if (fullContent) {
        renderer.finish(fullContent);
        addMessageActions(msgEl, msgBody, fullContent);
        pushHistoryMessage('assistant', fullContent);
      } else {
        // Keep the user's message in history AND view — what you see is what
        // the model receives next turn; drop only the empty assistant shell
        if (msgEl && msgEl.parentNode) msgEl.remove();
      }
      const canRetry =
        !fullContent && messages.length > 0 && messages[messages.length - 1].role === 'user';
      appendError(`Error: ${err.message || String(err)}`, {
        onRetry: canRetry ? () => retryLastTurn() : null
      });
      statusText.textContent = 'Error — fix config and try again';
    }
  } finally {
    // Timers stop even when the session went stale (New Chat mid-stream):
    // the panel is detached by then, but its interval would tick forever.
    if (reasoningApi && !reasoningApi.finalized) {
      reasoningApi = destroyReasoningPanel(reasoningApi, { remove: isStale() });
    }
    // Only clear streaming UI if this session still owns it
    if (!isStale()) {
      setAbortController(null);
      statusText.classList.remove('thinking-status');
      setStreamingUi(false);
      userInput.focus();
      // Persist after stream ends (skipped while streaming)
      scheduleHistorySave();
    }
  }
}

export { restoreComposerDraft, streamAssistantReply };
