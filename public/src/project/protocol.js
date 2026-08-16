/**
 * Project Mode's protocol: the system prompt every member works under, the
 * fenced-block tool syntax they emit, and the handoff marker that ends a turn.
 *
 * Turn output is parsed for three things:
 *   ```tool {json}```  / ```write <path>``` / ```append``` / ```edit```
 *   prose (what teammates and the journal see)
 *   [TURN: HANDOFF | TO: … | STATUS: working|blocked|done | NOTE: …]
 *
 * PJ_WORK_TOOLS / PJ_INSPECT_TOOLS are the evidence sets behind the "done"
 * gate in project/engine.js: a completion claim is refused when the session
 * shows no work, and a verifier's sign-off is refused when that turn
 * inspected nothing. Changing these sets changes what "done" means.
 *
 * Pure: no DOM, no app state. Safe to unit test in plain Node.
 */

/* ---------- agent output protocol ---------- */
// The closing fence must sit on its own (possibly indented) line: with a bare
// lazy `[\s\S]*?``` ` terminator, a write fence whose content contained a
// markdown code fence (` ```sh `) was cut at that inner opener — the file was
// silently truncated and the rest spilled into the prose. Models write
// fenced markdown into READMEs constantly.
const PJ_FENCE_RE = /```(tool|write|append|edit)([^\n]*)\n([\s\S]*?)\n?```[ \t]*\r?(?=\n|$)/g;
/**
 * The turn-ending handoff marker.
 *
 * Anchored to the START of a line, not the END of the message. Requiring it to
 * be the last thing in the text meant one trailing pleasantry ("Let me know if
 * you need anything else."), a code fence, a newline inside NOTE, or a "]" in
 * NOTE made the match fail — and a turn with no marker is read as plain
 * `working`, silently discarding the two statuses that actually steer a
 * session: `blocked` never reached the client and `done` never reached the
 * verification gate. Requiring a line start still keeps a marker quoted
 * mid-sentence from ending a turn. The closing "]" stays optional so a NOTE the
 * pattern cannot model degrades to a missing note, never to a missing STATUS.
 */
const PJ_TURN_RE = /(?:^|\n)([ \t]*[*_`~]{0,3}\[\s*TURN\s*:\s*HANDOFF\b)/i;
/** Same pattern, global: the LAST marker in a message is the turn's verdict. */
const PJ_TURN_SCAN_RE = new RegExp(PJ_TURN_RE.source, 'gi');
/** Fields are parsed from the located marker, each independently. */
const PJ_TURN_TO_RE = /\|\s*TO\s*:\s*([^|\]\n]+)/i;
const PJ_TURN_STATUS_RE = /\|\s*STATUS\s*:\s*(working|blocked|done)\b/i;
const PJ_TURN_NOTE_RE = /\|\s*NOTE\s*:\s*([\s\S]*?)\s*\]?\s*$/i;

/**
 * Read the handoff marker out of a turn, or null when there is none.
 *
 * Locate-then-parse rather than one all-or-nothing regex: a single pattern that
 * has to match TO, STATUS and NOTE together fails entirely on any NOTE it
 * cannot model — a newline, a "]", or simply being long — and a turn with no
 * marker is read as plain `working`, silently discarding the two statuses that
 * steer a session (`blocked` never reaches the client, `done` never reaches the
 * verification gate). Parsing each field on its own means a NOTE this cannot
 * represent costs the note, never the STATUS.
 */
function parseTurnMarker(text) {
  let last = null;
  PJ_TURN_SCAN_RE.lastIndex = 0;
  for (let m; (m = PJ_TURN_SCAN_RE.exec(text)) !== null; ) {
    last = m;
    if (m.index === PJ_TURN_SCAN_RE.lastIndex) PJ_TURN_SCAN_RE.lastIndex++;
  }
  if (!last) return null;

  // Where the message stops being for the client, and where the marker itself
  // begins (the match may have consumed a leading newline).
  const cut = last.index;
  const rest = text.slice(cut + last[0].length - last[1].length);

  // The marker runs to its closing "]", or to end of line when it has none. A
  // NOTE may wrap a line or two, so look a little past the line break — but not
  // far enough that a stray "]" much later swallows the rest of the message.
  const nl = rest.indexOf('\n');
  const lineEnd = nl === -1 ? rest.length : nl;
  const close = rest.slice(0, Math.min(rest.length, lineEnd + 400)).indexOf(']');
  const region = rest.slice(0, close !== -1 ? close + 1 : lineEnd);

  const to = PJ_TURN_TO_RE.exec(region);
  const status = PJ_TURN_STATUS_RE.exec(region);
  const note = PJ_TURN_NOTE_RE.exec(region);
  return {
    cut,
    handoff: {
      to: to ? to[1].trim().replace(/[*_`~]+$/, '') || null : null,
      status: status ? status[1].toLowerCase() : 'working',
      note: note ? note[1].trim() : ''
    }
  };
}

function parseAgentResponse(text) {
  const blocks = [];
  let prose = String(text || '');
  prose = prose.replace(PJ_FENCE_RE, (_, kind, info, body) => {
    if (kind === 'tool') {
      let spec = null;
      let err = null;
      try {
        spec = JSON.parse(body.trim());
      } catch (e) {
        err = `Invalid JSON in tool block: ${e.message}`;
      }
      blocks.push({ kind: 'tool', spec, err, raw: body.trim() });
    } else if (kind === 'write' || kind === 'append') {
      const p = info.trim();
      blocks.push(p ? { kind, path: p, content: body.replace(/\n$/, '') + '\n' } : { kind, err: `Missing path on \`\`\`${kind} fence` });
    } else if (kind === 'edit') {
      const p = info.trim();
      const edits = [];
      const re = /<{4,}\s*SEARCH\s*\n([\s\S]*?)\n?={4,}\s*\n([\s\S]*?)\n?>{4,}\s*REPLACE/g;
      let m;
      while ((m = re.exec(body)) !== null) edits.push({ find: m[1], replace: m[2] });
      blocks.push(
        !p
          ? { kind, err: 'Missing path on ```edit fence' }
          : edits.length
            ? { kind, path: p, edits }
            : { kind, path: p, err: 'No SEARCH/REPLACE sections found in edit block' }
      );
    }
    return '\n';
  });

  // Anything from the marker onward is machine-read, plus any sign-off chatter
  // the model added after it — the client sees neither.
  const marker = parseTurnMarker(prose);
  const handoff = marker ? marker.handoff : null;
  if (marker) prose = prose.slice(0, marker.cut);
  return { blocks, prose: prose.replace(/\n{3,}/g, '\n\n').trim(), handoff };
}

/** While streaming: hide tool fences and partial handoff markers from display */
function pjDisplayable(text) {
  let s = String(text || '');
  s = s.replace(PJ_FENCE_RE, (_, kind, info) => `⚙ ${kind}${info ? ' ' + info.trim() : ''}…`);
  const open = s.search(/```(tool|write|append|edit)[^\n]*\n(?![\s\S]*```)/);
  if (open !== -1) s = s.slice(0, open) + '\n⚙ preparing action…';
  else {
    const tick = s.search(/`{1,3}$/);
    if (tick !== -1) s = s.slice(0, tick);
  }
  const nl = s.lastIndexOf('\n');
  const lastLine = s.slice(nl + 1).trimStart().replace(/^[*_`~]{0,3}/, '');
  if (lastLine.startsWith('[') && /^\[\s*(t(u(r(n[\s\S]*)?)?)?)?$/i.test(lastLine)) {
    s = s.slice(0, Math.max(0, nl));
  }
  return s;
}

function pjElide(text, max = 12_000) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.75));
  const tail = s.slice(-Math.floor(max * 0.2));
  const omitted = s.length - head.length - tail.length;
  return (
    `${head}\n…[${omitted} chars elided — re-read the file or re-run a narrower command to recover the middle]…\n${tail}`
  );
}

/** Deep key-sort so two arg objects that differ only in key order match. */
function stableToolArgs(value) {
  if (Array.isArray(value)) return value.map(stableToolArgs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stableToolArgs(value[k]);
    return out;
  }
  return value;
}

/** Identity of one Project tool call — same tool + same args is one call. */
function projectToolCallKey(tool, args) {
  return `${String(tool || '')}:${JSON.stringify(stableToolArgs(args || {}))}`;
}

/**
 * Full call identity from the parsed fence — not the journal-facing args.
 * write/append/edit must include content/edits, or two different writes to
 * the same path collapse into a false REPEAT.
 */
function projectToolCallPayload(block) {
  if (!block || typeof block !== 'object') return {};
  if (block.kind === 'write' || block.kind === 'append') {
    return { path: block.path || '', content: block.content || '' };
  }
  if (block.kind === 'edit') {
    return { path: block.path || '', edits: block.edits || [] };
  }
  if (block.kind === 'tool' && block.spec && typeof block.spec === 'object') {
    const spec = { ...block.spec };
    delete spec.tool;
    return spec;
  }
  return {};
}

/**
 * A repeated identical tool call is not fresh progress. `seen` is a Map of
 * key → prior preview; the first sighting is recorded, later ones are repeats.
 */
function noteRepeatToolCall(seen, key, preview) {
  const map = seen instanceof Map ? seen : new Map();
  if (map.has(key)) return { repeat: true, prior: map.get(key), seen: map };
  map.set(key, String(preview == null ? '' : preview).replace(/\s+/g, ' ').slice(0, 160));
  return { repeat: false, prior: null, seen: map };
}

/**
 * Orthogonal command outcome. A timeout or signal is not a clean success
 * even when the process still exits 0.
 */
function commandExitFacts({ timedOut = false, signal = null, exitCode = null, aborted = false } = {}) {
  const code = exitCode == null || exitCode === '' ? null : Number(exitCode);
  const sig = signal || null;
  const timed = !!timedOut;
  const stop = !!aborted;
  return {
    timedOut: timed,
    signal: sig,
    exitCode: Number.isFinite(code) ? code : null,
    aborted: stop,
    cleanSuccess: !timed && !stop && !sig && code === 0
  };
}

/* ---------- prompts ---------- */
function buildProjectSystemPrompt(seat, seats, { verify = false } = {}) {
  const names = seats.map((s) => s.name).join(', ');
  const lines = [
    `You are ${seat.name}, one of ${seats.length} AI engineers (${names}) collaborating as equals on one software project in a shared workspace folder. The user is your client.`,
    seat.role ? `Your assigned focus: ${seat.role}` : 'No roles are assigned — self-organize around the task board.',
    '',
    'WORKSPACE',
    '- All paths are relative to the project root. You can only touch files inside it.',
    '- Shell commands execute automatically with the project root as working directory. Prefer small, verifiable steps.',
    '',
    'EFFORT STANDARD',
    '- Every member gives maximum effort on every task — tiny or huge, glamorous or boring. Task size never changes the quality bar.',
    '- No coasting: contribute real work each turn (build, verify, improve, or critically review a teammate\'s work). Never hand off after a token effort.',
    '- Craftsmanship counts even for one-line changes: naming, structure, edge cases, and a verification pass are part of "done".',
    '',
    'COLLABORATION PROTOCOL',
    '- The task board is the single source of truth. Claim a task (task_update → "doing") before working on it; NEVER work on a task a teammate has "doing". Mark "done" only after verifying.',
    '- Early in a job, break the instruction into small concrete tasks (task_add). Add newly discovered work as tasks instead of doing it silently.',
    '- Read files before editing them. Build on teammates\' work; never rewrite it wholesale without recording a decision.',
    '- Record important choices with the decision tool (stack, structure, conventions) and respect existing decisions.',
    '- Verify your work: run the code, tests, or a quick check after meaningful changes. Bar: would a strict senior reviewer approve?',
    '- Keep chat brief and concrete — teammates read it; the client only reads the final report.',
    '- If a material choice is contested, use the debate tool to poll the team, then decide and record it.',
    '',
    'TOOLS — emit fenced blocks; they execute immediately in order, and results come back to you in this same turn:',
    '```tool',
    '{"tool":"read_file","path":"src/app.js"}',
    '```',
    'JSON tools: read_file{path} · list_files{path?} · run{command,timeoutMs?} · mkdir{path} · move{path,to} · delete{path} · task_add{title} · task_update{id,status,note?} (todo|doing|done) · decision{text} · debate{question}',
    'Create/overwrite a whole file with a write fence (raw content — no escaping):',
    '```write src/app.js',
    "console.log('hi');",
    '```',
    'The write fence ends at the first line containing only ``` — if the content itself needs a line like that (nested markdown fences), build the file with append/edit instead.',
    'Append with ```append <path>```. Edit surgically with:',
    '```edit src/app.js',
    '<<<<<<< SEARCH',
    'exact current lines',
    '=======',
    'replacement lines',
    '>>>>>>> REPLACE',
    '```',
    'Multiple blocks per message are fine. Never invent other tools.',
    '',
    'ENDING YOUR TURN',
    'When this turn\'s work is done (or a teammate should take over), stop emitting tools and end your message with exactly one plain line:',
    '[TURN: HANDOFF | TO: auto|<TeammateName> | STATUS: working|blocked|done | NOTE: <≤15 words>]',
    '- working: you made progress; more remains.',
    '- blocked: you need the client. Put the question in your chat text.',
    '- done: the CURRENT INSTRUCTION is fully satisfied AND verified.',
    'STATUS: done is checked against the record: it is rejected if the team has not read, written, or run anything this session. Never claim done from an assumption about what the workspace contains — look first.'
  ];
  if (verify) {
    lines.push(
      '',
      'A teammate believes the instruction is complete. Independently VERIFY it now — read the key files, run the code or checks yourself. Your STATUS: done is rejected unless this turn actually inspected the workspace (read_file, list_files, or run). Agree only if it truly holds; otherwise fix it or report what is missing with STATUS: working.'
    );
  }
  lines.push('', 'The TURN line is machine-read and hidden from the client. Do not mention it.');
  return lines.join('\n');
}

function pjJournalLineForPrompt(e) {
  const clip = (s, n = 400) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
  switch (e.type) {
    case 'user': return `CLIENT: ${clip(e.text, 600)}`;
    case 'say': return `${e.name}: ${clip(e.text)}`;
    case 'report': return `${e.name} (FINAL REPORT): ${clip(e.text)}`;
    case 'tool': return `${e.name} ▸ ${pjToolLabel(e.tool, e.args)} → ${e.ok === false ? 'ERROR: ' : ''}${clip(e.detail, 200)}`;
    case 'decision': return `DECISION (${e.by}): ${clip(e.text, 300)}`;
    case 'council': return `TEAM DEBATE (asked by ${e.by}): ${clip(e.question, 200)}`;
    case 'session': return `— session ${e.phase === 'start' ? 'started' : (e.reason || 'ended')} —`;
    case 'sys': return `[system] ${clip(e.text, 200)}`;
    default: return '';
  }
}

/**
 * Tools that constitute real engineering work, as opposed to bookkeeping.
 * A "done" claim is only believable if the team ran some of these — moving
 * cards on the task board is not evidence that anything was built.
 */
const PJ_WORK_TOOLS = new Set([
  'write', 'append', 'edit', 'run', 'mkdir', 'move', 'delete', 'read_file', 'list_files'
]);
/** The subset that proves the claimer actually LOOKED at the workspace. */
const PJ_INSPECT_TOOLS = new Set(['read_file', 'list_files', 'run']);
/**
 * The subset that counts as the SESSION having done something.
 *
 * `list_files` is missing on purpose: a directory listing tells you what exists,
 * not that any of it was read, built or checked. With listing included, two
 * turns that each ran one `list_files` satisfied the gate and the team shipped a
 * confident final report about files nobody opened — the exact outcome the gate
 * exists to refuse. It still counts as INSPECTION, so a verifier who lists the
 * tree has looked; it just cannot be the only thing the session ever did.
 */
const PJ_SESSION_WORK_TOOLS = new Set([
  'write', 'append', 'edit', 'run', 'mkdir', 'move', 'delete', 'read_file'
]);

/**
 * Count a finished tool call against this turn's done-gate evidence.
 * `list_files` inspects but does not count as session work. A `run` that
 * actually executed (even with a non-zero exit) still counts; a blocked /
 * failed-to-start command does not.
 */
function recordProjectToolEvidence(out, did) {
  const acc = did || { work: 0, inspect: 0 };
  if (!out) return acc;
  if ((out.ok || (out.tool === 'run' && out.ran)) && PJ_WORK_TOOLS.has(out.tool)) {
    if (PJ_SESSION_WORK_TOOLS.has(out.tool)) acc.work++;
    if (PJ_INSPECT_TOOLS.has(out.tool)) acc.inspect++;
  }
  return acc;
}

/**
 * Decide whether a STATUS: done claim is allowed to increment the streak.
 * The session loop applies this result; tests import the same function.
 */
function evaluateProjectDoneClaim({
  status,
  did = { work: 0, inspect: 0 },
  sessionWork = 0,
  verifying = false,
  seatName = 'A teammate'
} = {}) {
  const work = Number(did.work) || 0;
  const inspect = Number(did.inspect) || 0;
  const nextWork = sessionWork + work;
  const name = String(seatName || 'A teammate');

  if (status !== 'done') {
    return { sessionWork: nextWork, accept: false, resetStreak: true, refusal: '' };
  }
  if (nextWork === 0) {
    return {
      sessionWork: nextWork,
      accept: false,
      resetStreak: true,
      refusal: `${name} reported the instruction done, but nobody has read, written, or run anything this session. Do the work first.`
    };
  }
  if (verifying && inspect === 0) {
    return {
      sessionWork: nextWork,
      accept: false,
      resetStreak: true,
      refusal: `${name} confirmed "done" without inspecting anything. Verification means reading the files or running the code yourself.`
    };
  }
  return { sessionWork: nextWork, accept: true, resetStreak: false, refusal: '' };
}

/**
 * Who speaks next. A self-handoff on a pending done claim is not independent
 * verification — ignore it and round-robin to someone else.
 */
function resolveProjectNextSeat({
  to,
  seats,
  currentIndex = 0,
  currentSeat = null,
  doneStreak = 0
} = {}) {
  const list = Array.isArray(seats) ? seats : [];
  const n = list.length || 1;
  const cur = Number.isInteger(currentIndex) ? currentIndex : 0;
  const wanted = String(to || '').trim();
  const target =
    wanted && wanted.toLowerCase() !== 'auto'
      ? list.find((s) => s && s.name.toLowerCase() === wanted.toLowerCase())
      : null;
  const selfHandoffIgnored = !!(
    doneStreak > 0 &&
    target &&
    currentSeat &&
    target.i === currentSeat.i
  );
  const nextIndex = target && !selfHandoffIgnored ? target.i : (cur + 1) % n;
  return { nextIndex, target, selfHandoffIgnored };
}

/**
 * Keep the inner turn conversation under budget by dropping the OLDEST
 * tool exchanges. The turn context (message 0) and the most recent exchanges
 * are what the model actually needs; a note marks what was dropped so it can
 * re-read anything it still wants.
 *
 * The shape must survive the trim: `convo` is one user brief followed by
 * [assistant, user] pairs, and providers that validate strict alternation
 * answer a run of consecutive user messages with the same hard 400 this
 * function exists to avoid. So exchanges are dropped two at a time (keeping
 * `rest` starting on an assistant turn) and the note is folded into the brief
 * rather than added as another user message.
 */
function pjTrimConvo(convo, budget) {
  const size = (m) => String(m.content || '').length;
  let total = convo.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return convo;
  const head = convo[0];
  const rest = convo.slice(1);
  // Always keep the last exchange — it holds the results the model is
  // mid-way through reading.
  let dropped = 0;
  while (rest.length > 2 && total > budget) {
    total -= size(rest.shift()) + size(rest.shift());
    dropped += 2;
  }
  // Last resort: the newest exchange is never dropped, so if it ALONE still
  // exceeds the budget nothing above can help and the provider answers with the
  // hard 400 this function exists to avoid. Elide its content instead — losing
  // the middle of one tool result beats losing the turn.
  let elided = false;
  if (total > budget && rest.length >= 2) {
    const room = Math.max(600, budget - size(head) - 400);
    for (let i = rest.length - 1; i >= 0 && total > budget; i--) {
      const before = size(rest[i]);
      if (before <= room) continue;
      rest[i] = { ...rest[i], content: pjElide(rest[i].content, room) };
      total -= before - size(rest[i]);
      elided = true;
    }
  }
  // Identity return only when NOTHING changed — returning `convo` after eliding
  // would quietly hand back the oversized original.
  if (!dropped) return elided ? [head, ...rest] : convo;
  const exchanges = dropped / 2;
  return [
    {
      ...head,
      content:
        `${head.content}\n\n[${exchanges} earlier tool exchange${exchanges === 1 ? '' : 's'} from this turn were dropped to fit your context window. ` +
        'The task board, decisions, and file tree above are current; re-read any file you still need.]'
    },
    ...rest
  ];
}

function pjToolLabel(tool, args = {}) {
  switch (tool) {
    case 'read_file': return `read ${args.path || ''}`;
    case 'list_files': return `list ${args.path || '/'}`;
    case 'run': return `run: ${String(args.command || '').slice(0, 80)}`;
    case 'mkdir': return `mkdir ${args.path || ''}`;
    case 'move': return `move ${args.path || ''} → ${args.to || ''}`;
    case 'delete': return `delete ${args.path || ''}`;
    case 'write': return `write ${args.path || ''}`;
    case 'append': return `append ${args.path || ''}`;
    case 'edit': return `edit ${args.path || ''}`;
    case 'task_add': return `task + ${String(args.title || '').slice(0, 60)}`;
    case 'task_update': return `task ${args.id || ''} → ${args.status || ''}`;
    case 'decision': return `decision recorded`;
    case 'debate': return `team debate: ${String(args.question || '').slice(0, 60)}`;
    default: return tool;
  }
}

export {
  PJ_FENCE_RE, PJ_TURN_RE, PJ_TURN_SCAN_RE, parseAgentResponse, pjDisplayable, pjElide,
  buildProjectSystemPrompt, pjJournalLineForPrompt, pjToolLabel,
  PJ_WORK_TOOLS, PJ_INSPECT_TOOLS, PJ_SESSION_WORK_TOOLS, pjTrimConvo,
  recordProjectToolEvidence, evaluateProjectDoneClaim, resolveProjectNextSeat,
  projectToolCallKey, projectToolCallPayload, noteRepeatToolCall, commandExitFacts
};
