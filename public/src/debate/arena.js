import { debateTurnSpeaker, joinNames } from '../debate/protocol.js';
import { formatTokenCount } from '../tokens.js';
import { createStreamRenderer } from '../ui/renderer.js';
import { createReasoningPanel, destroyReasoningPanel, finalizeReasoningPanel, formatThoughtDuration, updateReasoningStream } from '../ui/transcript.js';

// ========== DEBATE MODE — arena UI ==========
/**
 * The debate arena reuses the reasoning-panel shell (animated gradient border,
 * orb, shimmer, grid-rows drawer) with debate-specific chips/transcript inside.
 */
function createDebateArena(seats, maxRounds, { auto = false } = {}) {
  const panel = document.createElement('div');
  panel.className = 'reasoning-panel debate-panel thinking open';
  panel.dataset.open = 'true';
  panel.innerHTML = `
    <button type="button" class="reasoning-toggle" aria-expanded="true">
      <span class="reasoning-orb" aria-hidden="true">
        <span class="orb-ring"></span>
        <span class="orb-core"></span>
      </span>
      <span class="reasoning-meta">
        <span class="reasoning-label-main">
          <span class="shimmer-text debate-title">Team debating</span>
          <span class="reasoning-elapsed" aria-hidden="true">0.0s</span>
          <span class="debate-tokens" aria-hidden="true"></span>
        </span>
        <span class="reasoning-sub debate-sub">Convening the team…</span>
      </span>
      <span class="reasoning-chevron" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </span>
    </button>
    <div class="debate-chips"></div>
    <div class="reasoning-drawer">
      <div class="reasoning-drawer-inner">
        <div class="debate-body"></div>
      </div>
    </div>
  `;

  const chipsEl = panel.querySelector('.debate-chips');
  seats.forEach((s) => {
    const chip = document.createElement('span');
    chip.className = 'debate-chip';
    chip.dataset.i = s.i;
    chip.style.setProperty('--chip-c', `var(--debate-c${s.i % 5})`);
    chip.innerHTML =
      '<i class="chip-dot" aria-hidden="true"></i><span class="chip-name"></span><span class="chip-check" aria-hidden="true">✓</span>';
    chip.querySelector('.chip-name').textContent = s.name;
    chipsEl.appendChild(chip);
  });

  const toggle = panel.querySelector('.reasoning-toggle');
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    panel.dataset.open = open ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const body = panel.querySelector('.debate-body');
  let bodyStick = true;
  body.addEventListener(
    'scroll',
    () => {
      bodyStick = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    },
    { passive: true }
  );
  const bodyScroll = () => {
    if (bodyStick) body.scrollTop = body.scrollHeight;
  };

  const titleEl = panel.querySelector('.debate-title');
  const subEl = panel.querySelector('.debate-sub');
  const elapsedEl = panel.querySelector('.reasoning-elapsed');
  const tokensEl = panel.querySelector('.debate-tokens');
  const startedAt = performance.now();
  const timer = setInterval(() => {
    elapsedEl.textContent = formatThoughtDuration(performance.now() - startedAt);
  }, 100);

  return {
    el: panel,
    startedAt,
    finalized: false,
    setRound(r) {
      titleEl.textContent = auto
        ? `Team debating · Round ${r} · auto`
        : `Team debating · Round ${r}/${maxRounds}`;
    },
    setSpeaking(i) {
      panel.querySelectorAll('.debate-chip').forEach((c) => {
        c.classList.toggle('speaking', Number(c.dataset.i) === i);
      });
      const speaker = seats.find((s) => s.i === i);
      const others = seats.filter((s) => s.i !== i).map((s) => s.name);
      if (speaker) subEl.textContent = `${speaker.name} speaking · ${joinNames(others)} listening`;
    },
    setAllSpeaking() {
      panel.querySelectorAll('.debate-chip').forEach((c) => c.classList.add('speaking'));
      subEl.textContent = 'All experts writing independent takes in parallel…';
    },
    setSeatStatus(i, agreed) {
      const chip = panel.querySelector(`.debate-chip[data-i="${i}"]`);
      if (chip) chip.classList.toggle('agreed', agreed);
    },
    /** A seat whose provider failed twice: greyed out, no longer speaking. */
    setSeatDropped(i) {
      const chip = panel.querySelector(`.debate-chip[data-i="${i}"]`);
      if (!chip) return;
      chip.classList.remove('agreed', 'speaking');
      chip.classList.add('dropped');
      chip.title = 'Dropped out — provider error';
    },
    setPresenting(seat) {
      panel.querySelectorAll('.debate-chip').forEach((c) => c.classList.remove('speaking'));
      subEl.textContent = `${seat.name} is writing the final answer…`;
    },
    setJudging(label) {
      panel.querySelectorAll('.debate-chip').forEach((c) => c.classList.remove('speaking'));
      subEl.textContent = `${label || 'Judge'} is writing the final answer…`;
    },
    addRoundDivider(n, { blind = false } = {}) {
      const d = document.createElement('div');
      d.className = 'debate-round-divider';
      const span = document.createElement('span');
      span.textContent =
        blind || n === 1 ? `Round ${n} · independent takes` : `Round ${n}`;
      d.appendChild(span);
      body.appendChild(d);
      bodyScroll();
    },
    addTurn(seat) {
      const turn = document.createElement('div');
      turn.className = 'debate-turn';
      turn.style.setProperty('--turn-c', `var(--debate-c${seat.i % 5})`);
      turn.innerHTML =
        '<div class="debate-turn-name"></div><div class="bubble debate-turn-bubble"></div>';
      turn.querySelector('.debate-turn-name').textContent = seat.name;
      body.appendChild(turn);
      const bubbleEl = turn.querySelector('.debate-turn-bubble');
      const renderer = createStreamRenderer(bubbleEl, {
        announce: false,
        sweep: false
      });
      // Lazy per-turn reasoning panel — experts' chain of thought stays visible
      let rApi = null;
      let rText = '';
      const dropReasoning = () => {
        if (!rApi) return;
        rApi = destroyReasoningPanel(rApi);
        rText = '';
      };
      bodyScroll();
      return {
        el: turn,
        update(text) {
          renderer.update(text);
          bodyScroll();
        },
        updateReasoning(piece) {
          if (!rApi) {
            rApi = createReasoningPanel({ expectStream: true });
            turn.insertBefore(rApi.el, bubbleEl);
          }
          rText += piece;
          updateReasoningStream(rApi, rText);
          bodyScroll();
        },
        settleReasoning({ stopped = false } = {}) {
          if (rApi && !rApi.finalized) {
            finalizeReasoningPanel(rApi, { forceOpen: false, stopped });
          }
        },
        finish(text) {
          this.settleReasoning();
          renderer.finish(text);
          bodyScroll();
        },
        reset() {
          renderer.update('');
          dropReasoning();
        }
      };
    },
    addNote(text) {
      const n = document.createElement('div');
      n.className = 'debate-note';
      n.textContent = text;
      body.appendChild(n);
      bodyScroll();
    },
    setTokens(estimated, usage) {
      // Real provider usage when reported; token estimate otherwise
      const real = usage ? (usage.in || 0) + (usage.out || 0) : 0;
      tokensEl.textContent =
        real > 0 ? `${formatTokenCount(real)} tok` : `~${formatTokenCount(estimated)} tok`;
    },
    finalize({ rounds, presenter, consensus, stopped = false, errored = false, durText } = {}) {
      if (this.finalized) return;
      this.finalized = true;
      clearInterval(timer);
      elapsedEl.remove();
      panel.querySelectorAll('.debate-chip').forEach((c) => c.classList.remove('speaking'));
      panel.classList.remove('thinking');
      panel.classList.add('done');
      titleEl.classList.remove('shimmer-text');
      const dur = durText !== undefined ? durText : `for ${formatThoughtDuration(performance.now() - startedAt)}`;
      let label = dur ? `Debated ${dur} · ${rounds} round${rounds === 1 ? '' : 's'}` : `Team debate · ${rounds} round${rounds === 1 ? '' : 's'}`;
      if (presenter) label += ` · Presented by ${presenter}`;
      if (stopped) label += ' · stopped';
      else if (errored) label += ' · error';
      else if (!consensus) label += ' · no full consensus';
      titleEl.textContent = label;
      subEl.textContent = 'Tap to expand the team discussion';
      panel.classList.remove('open');
      panel.dataset.open = 'false';
      toggle.setAttribute('aria-expanded', 'false');
    },
    stopTimer() {
      clearInterval(timer);
    }
  };
}

/**
 * Credit line above the final answer.
 * Nominated (default): "{name} presents, on behalf of …"
 * Judge: "Final answer by Judge (model-id) · debated by …"
 */

/**
 * Credit line above the final answer.
 * Nominated (default): "{name} presents, on behalf of …"
 * Judge: "Final answer by Judge (model-id) · debated by …"
 */
function buildDebateCredit(presenterName, allNames, opts = {}) {
  const div = document.createElement('div');
  div.className = 'debate-credit';
  if (opts.mode === 'judge') {
    const model = opts.model || presenterName || 'judge';
    div.appendChild(document.createTextNode('Final answer by '));
    const strong = document.createElement('strong');
    strong.textContent = `Judge (${model})`;
    div.appendChild(strong);
    div.appendChild(document.createTextNode(` · debated by ${joinNames(allNames)}`));
    return div;
  }
  const strong = document.createElement('strong');
  strong.textContent = presenterName;
  div.appendChild(strong);
  div.appendChild(document.createTextNode(` presents, on behalf of ${joinNames(allNames)}`));
  return div;
}

/** Rebuild a collapsed, frozen arena above a history-restored debate answer */
function restoreDebateArena(refs, record) {
  const { body: msgBody, bubble } = refs;
  if (!msgBody || !record || !Array.isArray(record.experts)) return;
  const seats = Array.isArray(record.roster) && record.roster.length
    ? record.roster.map((s, i) => ({
        name: String(s?.name || record.experts[i] || '?'),
        i: Number.isInteger(s?.i) ? s.i : i,
        dropped: !!s?.dropped
      }))
    : record.experts.map((name, i) => ({ name: String(name), i }));
  const arena = createDebateArena(seats, record.rounds || 1);
  arena.stopTimer();
  const turns = Array.isArray(record.turns) ? record.turns : [];
  let lastRound = 0;
  turns.forEach((t) => {
    // The record already knows who spoke — believe it, don't re-derive the name
    // from a seat index that no longer lines up. See debateTurnSpeaker().
    const seat = debateTurnSpeaker(t, seats);
    const r = t.round || 0;
    if (r && r !== lastRound) {
      arena.addRoundDivider(r, { blind: r === 1 });
      lastRound = r;
    }
    arena.addTurn(seat).finish(String(t.text || ''));
  });
  if (!turns.length) arena.addNote('(transcript unavailable — truncated in storage)');
  seats.forEach((s) => {
    if (s.dropped) arena.setSeatDropped(s.i);
  });
  if (record.consensus) {
    seats.forEach((s) => {
      if (!s.dropped) arena.setSeatStatus(s.i, true);
    });
  }
  const isJudge = record.finalAnswerMode === 'judge';
  arena.finalize({
    rounds: record.rounds || 1,
    presenter: isJudge
      ? `Judge (${record.judgeModel || record.presenter || 'judge'})`
      : record.presenter,
    consensus: !!record.consensus,
    durText: '' // no duration stored — label becomes "Team debate · …"
  });
  msgBody.insertBefore(arena.el, bubble);
  if (record.presenter || isJudge) {
    msgBody.insertBefore(
      buildDebateCredit(record.presenter, record.experts, {
        mode: isJudge ? 'judge' : 'nominated',
        model: record.judgeModel || record.presenter
      }),
      bubble
    );
  }
}

export { buildDebateCredit, createDebateArena, restoreDebateArena };
