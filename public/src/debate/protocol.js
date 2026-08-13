/**
 * Debate Mode's protocol: the prompts each seat receives and the machine-read
 * status line they answer with.
 *
 * The contract every expert turn must satisfy:
 *   [STATUS: CONTINUE]                       open problems remain
 *   [STATUS: AGREE | NOMINATE: <ExpertName>] this seat is satisfied
 *
 * parseDebateStatus is deliberately tolerant — models bold it, backtick it,
 * and trail whitespace after it. The last line-start STATUS is the verdict
 * (a mid-sentence quote is not; chatter after the marker is ignored). A turn
 * with no parseable marker counts as CONTINUE, because silence is not agreement.
 *
 * Pure: no DOM, no app state. Safe to unit test in plain Node.
 */

// ========== DEBATE MODE — prompts & status protocol ==========
/**
 * Seat-count ceiling. The debate is fully adaptive from 2 up to this many
 * seats — the round loop, consensus rules, arena, and cost hint all derive
 * from the live experts array — so this constant is the ONLY place the
 * ceiling lives. Everything that caps a lineup imports it from here.
 */
const DEBATE_MAX_SEATS = 5;
/** Visible range the editor, cost hint, and docs must use — never a hardcoded 2–4. */
function debateSeatRangeLabel() {
  return `2–${DEBATE_MAX_SEATS}`;
}

/**
 * What an empty persona means. The UI shows this as the field's placeholder
 * and the engine applies it at runtime — one constant so the two can't drift
 * and the "optional" promise in the editor stays honest.
 */
const DEBATE_DEFAULT_PERSONA = 'Generalist: contributes broadly.';

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
}

function expertSystemPrompt(seat, seats, { blind = false, finalRound = false } = {}) {
  const names = seats.map((s) => s.name).join(', ');
  const lines = [
    `You are ${seat.name}, one of ${seats.length} AI experts (${names}) working together to solve a client's task.`,
    `Your role — ${seat.persona}`,
    '',
    'Debate rules:',
    '- Speak in first person to your colleagues, like a focused working meeting.',
    '- Be concrete and substantive. No filler, no pleasantries, no summarizing what everyone already agrees on.',
    "- Build on, challenge, or correct what has been said, from your role's perspective.",
    '- Engage specifics: name the colleague and quote or paraphrase the exact claim you are building on or disputing.',
    '- If you correct a factual or technical claim, show the check briefly (a one-line derivation, counter-example, or source of certainty).',
    '- Do not agree to be agreeable. AGREE only when you genuinely cannot find a material flaw or missing piece.',
    '- Full effort, always: a small or "easy" task gets exactly the same rigor, depth, and verification as a huge one. Task size never lowers the bar, and every seat contributes at full intensity — no coasting on colleagues.',
    '- Keep your turn focused: roughly under 250 words.'
  ];
  if (blind) {
    lines.push(
      'This is the opening round: give your own independent take on the task; you will see your colleagues\' views next round.'
    );
  }
  if (finalRound) {
    lines.push(
      'This is the FINAL scheduled round — converge now. Unless a truly blocking flaw remains, AGREE and nominate the best writer. If you must CONTINUE, name the single blocking issue in one sentence.'
    );
  }
  lines.push(
    '',
    'End your message with exactly one line (plain text, no bold or backticks):',
    '[STATUS: CONTINUE] — if open problems, unresolved disagreements, or unexplored critical angles remain.',
    "[STATUS: AGREE | NOMINATE: <ExpertName>] — if you believe the team's current solution is elite and complete. Nominate the colleague (or yourself) best suited to write the final deliverable.",
    'This status line is machine-read and hidden from the client. Do not mention or refer to it.'
  );
  return lines.join('\n');
}

function presenterSystemPrompt(seat, seats, { consensus = true } = {}) {
  const names = seats.map((s) => s.name).join(', ');
  const lines = [
    `You are ${seat.name}, one of ${seats.length} AI experts (${names}) who just finished discussing a client's task.`,
    `Your role — ${seat.persona}`,
    '',
    'The discussion is over. You were chosen by the team to deliver the final result.',
    "Write the complete, polished deliverable for the client directly — no meta-commentary about the debate, no status line, no mention of your colleagues. Just the best possible answer, incorporating the team's conclusions.",
    'Hold the same elite bar however small the task looks — the client gets your absolute best work either way.'
  ];
  if (!consensus) {
    lines.push(
      'The team did not reach full consensus. Where positions still differed, resolve each point explicitly with your best judgment rather than papering over it.'
    );
  }
  return lines.join('\n');
}

/** Neutral judge — not a debater; no status line */
function judgeSystemPrompt(seats) {
  const names = seats.map((s) => s.name).join(', ');
  return [
    'You are a neutral judge. You are NOT one of the debaters and must not role-play as any of them.',
    `You have read a debate among: ${names}.`,
    '',
    'Instructions:',
    "- Read the client's task and the full transcript carefully.",
    '- Weigh the arguments on merit, not who spoke most or last.',
    '- Resolve disagreements explicitly in the body of your answer.',
    "- Write the complete, polished final deliverable for the client.",
    '- Hold an elite quality bar regardless of how small the task is.',
    '- If the experts disagreed on something material, end with a short section titled exactly "Where the team disagreed" (2–4 lines) naming the tradeoff.',
    '- If there was no material disagreement, omit that section entirely.',
    '- No status line, no meta-commentary about being a judge, no nomination markers.'
  ].join('\n');
}

/**
 * Format the debate transcript, dropping OLDEST turns first when it exceeds
 * charBudget (the newest turn is always kept). Returns { text, omitted }.
 */
function formatDebateTranscript(transcript, charBudget = Infinity) {
  if (!transcript.length) return { text: '(nothing yet — you open the discussion)', omitted: 0 };
  const blocks = transcript.map((t) => `── ${t.name} said:\n${t.text}`);
  let total = 0;
  const kept = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    total += blocks[i].length + 2;
    if (kept.length && total > charBudget) break;
    kept.unshift(blocks[i]);
  }
  const omitted = blocks.length - kept.length;
  if (omitted > 0) {
    kept.unshift(`…(${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted to fit the model's context window)`);
  }
  return { text: kept.join('\n\n'), omitted };
}

function buildDebateTurnMessage({
  task,
  prior,
  transcript,
  transcriptText,
  seat,
  presenter = false,
  blind = false,
  judge = false
}) {
  let s = `THE CLIENT'S TASK:\n${task}\n\n`;
  if (prior) s += `PRIOR CONVERSATION WITH THE CLIENT (context):\n${prior}\n\n`;
  if (blind) {
    // Round 1: empty transcript in the prompt (independent takes)
    s += `TEAM DISCUSSION SO FAR:\n(independent opening round — no prior turns)\n\n`;
  } else {
    const block =
      transcriptText != null ? transcriptText : formatDebateTranscript(transcript).text;
    s += `TEAM DISCUSSION SO FAR:\n${block}\n\n`;
  }
  if (judge) {
    s +=
      'You are the neutral judge. The discussion is over — write the final deliverable for the client now.';
  } else {
    s += presenter
      ? `You are ${seat.name}. The discussion is over — write the final deliverable for the client now.`
      : `You are ${seat.name}. It is your turn to speak.`;
  }
  return s;
}

/**
 * A machine-read STATUS line. Line-start only — a mid-sentence quote is not
 * a verdict. Markdown decoration around the marker is tolerated (models emit
 * `**[STATUS: AGREE | NOMINATE: Kai]**` despite instructions). The LAST such
 * line in the message wins, even when chatter follows it.
 */
const DEBATE_STATUS_RE =
  /[*_`~]{0,3}\[?\s*STATUS\s*:\s*(CONTINUE|AGREE)\b\s*(?:\|\s*NOMINATE\s*:\s*([^\]\n|]+?)\s*)?\]?[*_`~]{0,3}/i;
const DEBATE_STATUS_FIND_RE =
  /(?:^|\n)([ \t]*[*_`~]{0,3}\[?\s*STATUS\s*:\s*(CONTINUE|AGREE)\b)/gi;

function parseDebateStatus(text) {
  const s = String(text == null ? '' : text);
  const find = new RegExp(DEBATE_STATUS_FIND_RE.source, 'gi');
  let last = null;
  for (let m; (m = find.exec(s)) !== null; ) {
    last = m;
    if (m.index === find.lastIndex) find.lastIndex++;
  }
  if (!last) return { status: 'continue', nominee: null, cleanText: s.replace(/\s+$/, '') };

  const cut = last.index + last[0].length - last[1].length;
  const rest = s.slice(cut);
  const nl = rest.indexOf('\n');
  const region = rest.slice(0, nl === -1 ? rest.length : nl);
  const status = last[2].toLowerCase() === 'agree' ? 'agree' : 'continue';
  const nom = /\|\s*NOMINATE\s*:\s*([^\]\n|]+)/i.exec(region);
  const nominee = nom ? nom[1].trim().replace(/[*_`~]+$/, '').trim() || null : null;
  return { status, nominee, cleanText: s.slice(0, cut).replace(/\s+$/, '') };
}

/**
 * While streaming: withhold a trailing line that looks like a (partial) status
 * marker.
 *
 * Blank trailing lines are skipped rather than treated as "no marker": models
 * end the turn with a newline after the marker, and stopping at the last `\n`
 * made the finished `[STATUS: …]` line pop into the arena for as long as the
 * stream kept running.
 */
function isDebateStatusishLine(line) {
  const lastLine = String(line || '')
    .trim()
    .replace(/^[*_`~]{0,3}/, '');
  if (!lastLine) return false;
  // Partial bracketed marker as it is typed (`[`, `[S`, `[STAT`, …)
  if (/^\[\s*(s(t(a(t(u(s[\s\S]*)?)?)?)?)?)?$/i.test(lastLine)) return true;
  // Complete (or still-being-typed after the colon) STATUS line
  if (/^\[?\s*STATUS\s*:/i.test(lastLine)) return true;
  return false;
}

function stripStreamingStatusTail(text) {
  // Hide from the last status-ish line onward — including a finished marker
  // followed by a trailing pleasantry, which parseDebateStatus also ignores.
  // No status-ish line → the original string, trailing blanks included.
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const lines = s.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isDebateStatusishLine(lines[i])) last = i;
  }
  if (last === -1) return s;
  return lines.slice(0, last).join('\n');
}

/**
 * Who spoke a stored turn, when rebuilding a debate from history.
 *
 * The turn's own `name` is the speaker and the stored index only picks a
 * colour. This matters because `record.experts` holds just the seats that were
 * still live at the end, while `turn.i` is the ORIGINAL seat index — so reading
 * the name out of `seats[turn.i]` relabels turns as the wrong expert as soon as
 * one seat dropped out, and a three-way debate can restore as a monologue.
 * Legacy records written before turns carried an index fall back to the name.
 */
function debateTurnSpeaker(turn, seats) {
  const t = turn || {};
  const list = Array.isArray(seats) ? seats : [];
  const i = Number.isInteger(t.i) ? t.i : Math.max(0, list.findIndex((s) => s && s.name === t.name));
  return { name: String(t.name || list[i]?.name || '?'), i };
}

function matchSeatByName(name, seats) {
  if (!name) return null;
  const n = name.toLowerCase();
  return (
    seats.find((s) => s.name.toLowerCase() === n) ||
    seats.find((s) => n.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(n)) ||
    null
  );
}

/**
 * Most nominations wins; ties resolve to the earliest seat in order.
 * Seats that dropped out cannot present (and their votes no longer count) —
 * nominating a dead endpoint would just fail the final answer too.
 */
function pickDebatePresenter(seats) {
  const list = Array.isArray(seats) ? seats : [];
  const eligible = list.filter((s) => s && !s.dropped);
  // A dropped seat cannot present. Only when nobody is left live do we fall
  // back to the full roster, so a finished transcript can still be written.
  const pool = eligible.length ? eligible : list;
  if (!pool.length) return null;
  const tally = new Map();
  for (const s of pool) {
    if (s.nominee && !s.nominee.dropped) {
      tally.set(s.nominee.i, (tally.get(s.nominee.i) || 0) + 1);
    }
  }
  let best = null;
  let bestCount = 0;
  for (const s of pool) {
    const c = tally.get(s.i) || 0;
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best || pool[0];
}

function debateLiveSeats(seats) {
  return (Array.isArray(seats) ? seats : []).filter((s) => s && !s.dropped);
}

/**
 * Consensus = every live seat agrees. Fewer than two live seats cannot claim
 * it — a remaining monologue is not a team.
 */
function debateHasConsensus(seats) {
  const live = debateLiveSeats(seats);
  return live.length >= 2 && live.every((s) => s.status === 'agree');
}

/**
 * Record a finished turn's vote. An AGREE is only valid while nothing
 * contentious follows it: a later CONTINUE clears every earlier AGREE so
 * those seats must re-confirm. Opening-round votes are discarded separately
 * via discardOpeningVotes — this helper never treats silence as agreement.
 */
function applyDebateVote(seats, seat, status, nomineeName) {
  if (!seat) return seat;
  const next = String(status || '').toLowerCase() === 'agree' ? 'agree' : 'continue';
  seat.status = next;
  seat.nominee = matchSeatByName(nomineeName, seats);
  if (next === 'continue') {
    for (const other of seats || []) {
      if (other !== seat && other.status === 'agree') {
        other.status = 'continue';
      }
    }
  }
  return seat;
}

/** Opening-round AGREEs are opinions about one's own take, not the team's. */
function discardOpeningVotes(seats) {
  for (const s of seats || []) {
    if (s.dropped) continue;
    s.status = 'continue';
  }
  return seats;
}

/** A seat whose provider failed twice sits out; its vote no longer counts. */
function dropDebateSeat(seat) {
  if (!seat) return seat;
  seat.dropped = true;
  seat.status = 'continue';
  return seat;
}

/**
 * Who writes the final answer, and how the credit line names them.
 * A failed judge does not throw away a finished debate: the team nominee
 * writes, and the record says so.
 */
function debateAnswerAttribution({ judgeDelivered = false, judgeSeat = null, seats = [] } = {}) {
  const live = debateLiveSeats(seats);
  const creditNames = (live.length ? live : seats).map((s) => s.name);
  if (judgeDelivered && judgeSeat) {
    const label = `Judge (${judgeSeat.model || 'unknown'})`;
    return {
      mode: 'judge',
      label,
      presenter: { name: label, model: judgeSeat.model },
      creditNames
    };
  }
  const presenter = pickDebatePresenter(seats);
  return {
    mode: 'nominated',
    label: presenter?.name || '',
    presenter,
    creditNames
  };
}

export {
  DEBATE_MAX_SEATS, DEBATE_DEFAULT_PERSONA, debateSeatRangeLabel,
  joinNames, expertSystemPrompt, presenterSystemPrompt, judgeSystemPrompt,
  formatDebateTranscript, buildDebateTurnMessage,
  DEBATE_STATUS_RE, DEBATE_STATUS_FIND_RE, parseDebateStatus, stripStreamingStatusTail,
  debateTurnSpeaker, matchSeatByName, pickDebatePresenter,
  debateLiveSeats, debateHasConsensus, applyDebateVote, discardOpeningVotes,
  dropDebateSeat, debateAnswerAttribution
};
