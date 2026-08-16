# Tarka — Architecture

A map of the codebase for people changing it. Read the top three sections and
you can find anything; read the mode sections when you touch that mode.

**No build step.** The browser loads ES modules natively and the server is plain
CommonJS. `node server.js` is the whole toolchain. There are no dependencies to
install and nothing to compile — if you add either, you've changed the project's
central constraint, so say so in the PR.

---

## The shape of it

```
server.js          131 lines — request pipeline and listen, nothing else
lib/               the server, one concern per file
public/
  index.html       markup + CSP; loads app.js as a module
  app.js           entry: DOM event wiring + boot sequence ONLY
  src/             all frontend behaviour
  style.css
data/projects.json created on demand — the project index
```

Two rules keep this navigable:

1. **`app.js` never contains behaviour.** It wires DOM events to imported
   functions and runs the boot sequence. If you're adding logic there, it
   belongs in a `src/` module.
2. **`server.js` never contains behaviour.** It routes. Handlers live in `lib/`.

---

## Request pipeline (server)

Every request passes through, in order:

| Step | Where | Why it exists |
|---|---|---|
| 1. `Host` must name this machine | `lib/security.js` | DNS rebinding: an attacker's domain re-resolving to `127.0.0.1` would become same-origin with your local server |
| 2. `/api/*` must be same-origin, JSON-shaped | `lib/security.js` | A page you visit can POST to localhost without a preflight. Project Mode writes files and runs commands |
| 3. route | `server.js` | `/api/health` · `/api/chat` · `/api/models` · `/api/agents/local` · `/api/project*` |
| 4. static, SPA fallback | `server.js` | anything else |

The whole thing is wrapped so a throw becomes a 500, not an exit. `createServer`'s
callback used to be `async`, which made any unhandled rejection fatal — one bad
request took the process and every in-flight chat with it. Keep `route()` behind
the `.catch()`; don't make the outer callback async again.

### `lib/` map

| File | Holds |
|---|---|
| `paths.js` | `APP_DIR`, `PUBLIC_DIR`, `DATA_DIR`. **Anchored to the repo root, never `__dirname` of the importing file** — see the warning below |
| `config.js` | env parsing: port, host, timeouts, upstream attribution headers |
| `http.js` | body parsing, static files, SSE writes, JSON replies |
| `security.js` | the trust boundary: `isPrivateIp`, host/origin/CSRF checks, SSRF containment, DNS pinning |
| `proxy.js` | `handleChat` (streaming + the provider-compat ladder), `handleModels` |
| `local-agents.js` | detect + spawn Claude Code / Codex / Grok Build CLIs as keyless providers. Grok is prompted via `--prompt-file` (it does not read stdin) and streamed as `streaming-json`. |
| `project/paths.js` | `validateProjectFolder`, `resolveInside` — path containment |
| `project/fs.js` | file operations, all routed through `resolveInside` |
| `project/exec.js` | shell execution: timeout, output caps, process-group kill |
| `project/state.js` | projects index, task board, decisions, journal |
| `project/routes.js` | the `/api/project*` endpoints |

> ### ⚠ Containment is judged on where a path LANDS
> `resolveInside` resolves the target component by component with `lstat`
> (`resolveLanding`), not by `realpath`-ing the nearest existing ancestor.
> `realpath` answers ENOENT for a symlink whose target does not exist *yet*, and
> a probe that walks up on ENOENT reads that as "nothing here, we are creating
> it" — while `writeFile`, `appendFile` and `mkdir -p` all follow the link. That
> gap let an agent `ln -s ~/.config/autostart/x.desktop payload` and then write
> a file of its choosing anywhere the user can write. A link in any *directory*
> component does the same thing, so every component is checked, not just the last.

> ### ⚠ `__dirname` in `lib/`
> `validateProjectFolder` refuses a project folder that would let agents write to
> Tarka's own source. It compares against `APP_DIR` **imported from
> `lib/paths.js`**. Deriving it from `__dirname` inside `lib/project/` resolves
> to `lib/project` and silently narrows the guard, leaving the app root
> assignable as a project folder. If you move that check, keep the import.

### Two non-obvious server details

- **`projectExec` hangs its abort handler on `res`, not `req`.** Since Node 16 an
  `IncomingMessage` emits `'close'` as soon as its body is consumed — long
  before the client disconnects — so `req.on('close')` fires instantly and never
  signals a real disconnect. `res` closes only on response end or socket death.
  This is what makes **Stop** actually kill a running command. `handleChat` has
  the same trap and the same answer.
  > **Known limit.** A command that backgrounds a grandchild (`node server.js &`)
  > settles via the 1.5s grace path once the shell exits, which clears the
  > timeout and releases the abort handler — so that grandchild outlives both
  > the timeout and Stop. This is deliberate: killing it is indistinguishable
  > from killing a dev server the team started on purpose and is about to test
  > against. The result carries a `note` saying a background process is still
  > holding the pipes.
- **`handleChat` has a compatibility ladder.** A rejected `stream_options`,
  reasoning shape, `max_tokens` vs `max_completion_tokens`, or an unsupported
  `temperature` each cost exactly one transparent retry, checked
  most-specific-first. See `reasoningVariants()`.
- **`stream_options: { include_usage: true }` is always sent.** OpenAI — and
  everything that copies it: Azure, vLLM, Together, Fireworks, DeepSeek, Groq,
  Ollama's shim — reports no token usage at all during streaming without it, so
  the context meter would run on character-count estimates forever. OpenRouter
  sends usage regardless and documents the field as accepted-but-ignored.
  Its usage chunk carries `choices: []`, which is why the content branch is
  guarded on `choices[0]` and the usage check sits outside it.
- **The upstream timeout is an *idle* timeout, and the proxy keeps the browser
  side alive itself.** A reasoning model can sit silent for minutes before its
  first byte, and one-api-family gateways (TokenRouter et al.) forward none of
  that silence as keep-alives — OpenRouter's ": PROCESSING" comments are the
  exception. So `UPSTREAM_TIMEOUT_MS` defaults to 5 minutes of *no bytes at
  all*, the timeout error names the phase that died (never answered vs stalled
  mid-stream) and the env var that raises it, and Tarka writes its own
  `: keepalive` SSE comments downstream every `TARKA_SSE_KEEPALIVE_MS` so a
  reverse proxy in front of it cannot kill the "idle" response first.
- **Usage is forwarded once, at end of stream.** Some gateways attach a running
  `usage` to every chunk; the debate arena sums what it receives, so forwarding
  each one inflated reported spend by the chunk count. `pendingUsage` keeps the
  newest figures and emits a single `done`.
- **`applyPinnedLookup` must honour `opts.all`.** Since Node 20 `autoSelectFamily`
  defaults on, so `net` calls a custom DNS lookup with `{ all: true }` and
  expects an array of `{ address, family }`. Answering with the three-argument
  `(err, address, family)` form fails every proxied request from a non-loopback
  client with `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.
- **`pickContextLength` distrusts a bare `max_tokens`.** Most providers use it
  for the completion cap. It is only read as a context window when a sibling
  completion-cap field proves it is not one, or when it is too large
  (≥ 32k) to plausibly be one — otherwise the meter pins at 4k, fires
  "context nearly full" on the first message, and shreds every trim budget.
- **Anything that becomes a header is validated first.** `http.request` throws
  `ERR_INVALID_CHAR` *synchronously* for a header value outside printable
  Latin-1, so an API key pasted with a trailing newline used to kill the server
  rather than fail the request. `headerSafeApiKey()` trims and vets the key
  before the request object exists; env-supplied header values go through
  `headerSafe()` in `config.js` for the same reason.
- **`parseBody` can return a non-object.** `null`, `true` and `[1,2]` are all
  valid JSON. Both proxy handlers normalize to `{}` before destructuring.
- **Everything `handleChat` buffers whole is capped (`MAX_CHAT_BUFFER`, 8MB).**
  `handleModels` always capped its body; the chat path did not, in three places:
  the 4xx error body, a non-SSE JSON reply, and the SSE line buffer. That last
  one is the dangerous one — a line only leaves the buffer when its newline
  arrives, so an upstream streaming megabytes without one grows it without
  bound *and* keeps the idle timeout from ever firing, because every byte counts
  as activity. The Base URL is user-supplied, so "the upstream" is not
  necessarily a real provider.
- **`handleModels` aborts its upstream when the browser disconnects.** Same
  `res.on('close')` courtesy `handleChat` has always had; without it an
  abandoned catalog fetch held a socket for the full `MODELS_TIMEOUT_MS`.
- **The endpoint is appended to the URL's PATH, not to the string** (`apiUrl`).
  Azure OpenAI — a documented target — is configured as
  `…/deployments/<name>?api-version=…`, and concatenation produced
  `?api-version=…/chat/completions`, i.e. a 404 that the "missing /v1" hint then
  misdiagnosed. A `#fragment` dropped the endpoint outright.
- **IPv6 literals lose their brackets before `http.request`** (`requestHostname`).
  `URL.hostname` keeps them, `net.isIP('[::1]')` is 0, so the request goes to
  DNS and every call to a local IPv6 Ollama/vLLM dies with ENOTFOUND. Remote
  clients never saw it because `applyPinnedLookup` replaces the lookup entirely.
- **The 413 is written before the socket is torn down.** Destroying `req` while
  the client is still uploading RSTs the connection and discards the reply, so
  an oversized body surfaced as a generic "Failed to fetch" — the opposite of
  what `parseBody` pauses the stream to make possible.
- **`splitModelId` treats Ollama's `:7b` / `:q4_0` as variant TAGS.** They are
  model-shaped (they carry a digit), so the provider-prefix rule would read the
  tag as the model and throw the name away — collapsing `codellama:7b` and
  `mistral:7b` to the same base `7b`, and handing one model's context window to
  the other. `public/src/modelId.js` mirrors this; `test/model-id.test.js` runs
  one table through both.

---

## Frontend state

ES module imports are **read-only bindings**. A module can read an imported
`let` but cannot reassign it — `messages = []` in another module is a
`TypeError`.

So shared mutable state follows one convention:

```js
// state.js — owns the variable
export let messages = [];
export function setMessages(v) { messages = v; return v; }

// any other module
import { messages, setMessages } from './state.js';
messages.length;        // read: use the binding directly, it's live
setMessages([]);        // write: must go through the setter
```

If you add shared mutable state, add its setter next to it. A missing setter
shows up as `TypeError: Assignment to constant variable` the first time that
path runs.

> ### ⚠ `src/state.js` imports nothing
> It sits at the bottom of the graph and declares `$` plus the DOM refs that
> other modules read *at module scope*. Give it an import and it can be
> evaluated after one of its own consumers, which surfaces as
> `ReferenceError: Cannot access '$' before initialization` at page load — from
> whichever file happened to lose the race, not from the one that added the
> import. Whether it breaks depends on `app.js`'s import order, so it can also
> stay latent for a while. Keep the file import-free.

State lives with its topic, not in one god module:

| Module | Owns |
|---|---|
| `src/state.js` | cross-cutting: `messages`, `isStreaming`, `abortController`, `chatSession`, DOM refs, `$` |
| `src/sessions.js` | the chat list, history load/save |
| `src/providers.js` / `src/config.js` | provider profiles, global settings |
| `src/contextStore.js` | the provider-reported context-window cache (imports only `state.js` + pure `modelId.js`) |
| `src/context.js` | context-window resolution + the meter |
| `src/modelId.js` | model-id equivalence. **Pure** — mirrors `lib/proxy.js`; `test/model-id.test.js` runs one table through both |
| `src/debate/settings.js` | debate teams and seat config |
| `src/project/state.js` | active project, task board, decisions, journal |

### ⚠ One catalog fetch, one context cache

`context.js` (the meter) and `models.js` (the model picker) both need the
provider's `/models` response, and they used to fetch it separately: the
catalog cached the response for an hour but discarded the per-model
`context`, while the meter kept the context but cached nothing. So a model the
provider did not list re-downloaded a multi-MB catalog on every 700ms
model-edit debounce and every page load — and a debate seat's window was never
cached at all, because only the *active solo* provider+model was ever probed.

Now `fetchProviderModels()` is the only caller, and `ingestModelContexts()`
records every window it reported into `contextStore.js`. Seat budgets
(`seatTranscriptBudget`, `pjTurnBudget`) read that store through
`contextLimitFor(providerId, modelId)`. If you add a third consumer, go through
the store — do not add another `/api/models` call.

Resolution order in `contextLimitFor` is: the window DECLARED on the provider
profile (`providers.js` — an OpenClaw-style custom-provider models list the
user edits in the provider editor, one `model = 128k` line each) → this
provider's own report → the same model as reported by ANY other configured
provider (`getSharedContext`) → the local guess table.

**Both cache lookups are equivalence-aware, not exact-string.** They are keyed
on the id the CATALOG listed while callers ask with the id the USER typed, and
those differ constantly (`tuned-writer-v2` vs `acme/tuned-writer-v2`). When
`getCachedContext` did exact matching only, an alias missed there and fell
through to `getSharedContext` — which deliberately EXCLUDES the current
provider — so a window resolved against every provider except the one that
actually reported it, and the seat silently took the 128k default. The middle step exists because one-api-family gateways
(TokenRouter et al.) list no context fields at all, while the same model sits
one profile over with its real window already cached — a window is a property
of the model, not of who resells it. Exact-id matches outrank prefix/tag
equivalents so "gpt-4o" from one gateway never loses to "openai:gpt-4o" from
another.

---

## How a turn flows

All three modes stream through one function: **`src/net/stream.js` →
`streamCompletion()`**. It POSTs to `/api/chat`, parses the SSE, and calls
`onToken` / `onReasoningToken` / `onUsage`. Everything above it is orchestration.

### Solo — `src/solo.js`

```
sendMessage()  →  streamAssistantReply(cfg)
                    └─ streamCompletion  →  renderer.update() per token
```
One transparent retry on transient failures, but only when nothing has streamed
yet, so text never duplicates.

### Debate — `src/debate/`

```
runDebate(cfg, task)                              engine.js
  round 1: all seats in parallel, BLIND           ← nobody sees anyone else
  rounds 2..n: round-robin over the transcript
  final answer: nominated expert OR neutral judge
```

| File | Holds |
|---|---|
| `protocol.js` | prompts + the status-line contract. **Pure — unit-testable in plain Node** |
| `engine.js` | the round loop, consensus rules, seat failure handling |
| `arena.js` | the live arena UI |
| `ui.js` | the seats editor |

Every expert turn ends with a machine-read line:

```
[STATUS: CONTINUE]                        open problems remain
[STATUS: AGREE | NOMINATE: <ExpertName>]  this seat is satisfied
```

`parseDebateStatus` is deliberately tolerant — models bold it, backtick it, and
trail whitespace. **A turn with no parseable marker counts as CONTINUE**, because
silence is not agreement.

Two rules in `engine.js` are load-bearing; if you change them, change them
knowingly:

- **Opening-round votes are discarded before round 2.** An expert who has read
  nothing is agreeing with itself. Consensus can only be earned in a round where
  the whole transcript was on the table. Without this, a debate silently
  collapses into N parallel one-shots wearing a consensus badge.
- **A seat that fails twice drops out; the rest continue.** A team of models
  exists so one bad endpoint cannot decide the answer. The dropped seat is greyed
  out, noted in the arena, and left off the credit line. Only below two live
  seats does the debate end.
- **The same rule covers the final writer.** A judge that fails both attempts
  hands the write-up to the team's nominee (`useNominatedPresenter()`), which
  also rewrites the credit line and flips `finalAnswerMode` back to
  `nominated` — the record must name who actually wrote the answer. Without
  this, one 500 discarded a finished N-seat debate, the most expensive thing
  the app does.
- **Consensus is re-tested after a drop, not only after a successful turn.**
  A drop changes who "everyone" is, so the remaining seats may already agree.
  Skipping the re-test recorded an agreed team as "no full consensus" and, mid-
  schedule, paid for another whole round to rediscover it.
- **Round 1 harvests before it reacts to a stop.** The opening round runs in
  parallel, so Esc arrives while some seats have already finished. Their takes
  are moved into the transcript first; only then does the run stop. Otherwise
  the transcript is empty, and the empty-transcript path unwinds the user's
  message as though nothing had happened.

### Project — `src/project/`

```
runProjectSession(instruction)                    engine.js
  per turn: runProjectAgentTurn()
     └─ up to 8 inner steps: model emits tool blocks → execute → feed results back
  a member claims "done" → next member VERIFIES → final report
```

| File | Holds |
|---|---|
| `protocol.js` | system prompt, tool-block parsing, handoff marker, `pjTrimConvo`. **Pure** |
| `tools.js` | `executeAgentBlock` — the tool implementations |
| `engine.js` | session loop, turn loop, the done gate |
| `state.js` | project CRUD, task board, journal state |
| `journal.js` | the transcript rendering |

A turn ends with:

```
[TURN: HANDOFF | TO: auto|<Name> | STATUS: working|blocked|done | NOTE: <≤15 words>]
```

**The done gate.** `STATUS: done` is checked against the record, not taken on
trust:

- refused if the team has read, written, or run **nothing** this session
- a verifier's sign-off is refused if **that turn** inspected nothing
- the verifier is never the claimer: a member that ends a `done` turn with
  `TO: <its own name>` used to resolve straight back to itself, so one inspect
  call let it sign off on its own work. A self-handoff on a pending claim is
  ignored and the round-robin picks someone else.
- `list_files` counts as INSPECTION but not as session work
  (`PJ_SESSION_WORK_TOOLS`). A directory listing says what exists, not that any
  of it was read, built or checked — with listing included, two turns that each
  ran one `list_files` satisfied the gate and the team shipped a confident
  report about files nobody opened.

The evidence sets are `PJ_WORK_TOOLS` and `PJ_INSPECT_TOOLS` in `protocol.js` —
editing them changes what "done" means. Refusals are written into the journal, so
the team reads why it was turned down and goes back to work. Without this, two
models will happily declare a whole project complete in two turns having touched
no files, and write a confident report about it.

**Context trimming.** Eight inner steps at up to 12KB of tool output each will
overrun a small model's window, and providers answer that with a hard 400.
`pjTrimConvo` drops the oldest tool exchanges, keeps the turn brief and the
newest exchange, and leaves a note saying what was dropped.

The trim must preserve the conversation's shape: one user brief followed by
`[assistant, user]` pairs. Exchanges are dropped **two at a time** and the note
is folded into the brief rather than appended as another user message —
otherwise the result carries consecutive user turns, and providers that check
role alternation answer with the same hard 400 the trimming exists to avoid.

Two sizes have to agree, or the trim cannot do its job. The newest exchange is
never dropped, so a single tool result larger than the whole budget could never
be trimmed back under it — which is why `engine.js` elides each result against
**this seat's** budget (`resultCap`) instead of a fixed 12KB, and why
`pjTrimConvo` elides the final exchange's content as a last resort. Before
that, one medium file read on a small-context seat drew the hard 400 and ended
the session.

---

## Rendering

`src/markdown.js` is the only thing that produces HTML from model output.

> **Safety contract.** Everything reaching `innerHTML` is escaped first. Fenced
> code is extracted from the RAW text (so the highlighter sees real characters),
> highlighted with escaped output, and re-inserted through `\x00CODE<n>\x00`
> placeholders. Links are restricted to `http(s)`. **Model output is untrusted
> input — keep it that way.**

`src/ui/renderer.js` wraps this in the incremental streaming renderer: completed
blocks render once, only the live tail re-renders, so long replies stay smooth.

---

## Testing

```bash
npm test        # node --test — no dependencies, no runner to install
```

Still zero dependencies: the suite is `node:test` + `node:assert`, and the
integration tests spawn the real `server.js` on an ephemeral port and point it
at a mock OpenAI-compatible provider (`test/helpers/harness.js`).

| File | Covers |
|---|---|
| `security.test.js` | the trust boundary: `isPrivateIp` (IPv4-mapped, NAT64, CGNAT, ULA, link-local), host/origin/CSRF checks, DNS pinning incl. a real socket connect |
| `proxy.test.js` | the provider-compat helpers: base URL, API key, clamps, reasoning shapes, model ids, context fields, gzip |
| `chat.test.js` | `/api/chat` end to end: what goes on the wire, the compat ladder, usage, reasoning field names, error unwrapping |
| `models.test.js` | `/api/models` end to end against real OpenRouter- and TokenRouter-shaped catalogs |
| `model-id.test.js` | one case table run through **both** `lib/proxy.js` and `public/src/modelId.js`, so they cannot drift |
| `tokens.test.js` | the context-window table and the estimator |
| `protocol.test.js` | the debate status line and the project handoff marker + trim |
| `markdown.test.js` | the rendering safety contract — model output is untrusted input |
| `project-paths.test.js` | Project Mode containment: traversal, symlinks, `.tarka`, refused folders |
| `frontend-graph.test.js` | every import in `public/` resolves and is actually exported; `state.js` stays import-free; `app.js` stays behaviour-free |

`frontend-graph.test.js` is the one that pays for itself with no build step —
a renamed export is otherwise a blank page and a console error, on whichever
code path happens to run first.

To exercise the full app without a paid API key, point a provider at a local
mock that speaks OpenAI-compatible SSE; `window.tarka` (defined at the bottom of
`app.js`) exposes the actions and live state for driving it from devtools.

---

## Conventions

- Comments explain **why**, not what. The why is usually a provider quirk, a
  browser behaviour, or an attack being prevented — worth writing down.
- No dependencies, no build step, no CDN requests. Tarka works offline.
- API keys live in the browser's `localStorage` and are sent only to the local
  server, which attaches them to the configured Base URL.
