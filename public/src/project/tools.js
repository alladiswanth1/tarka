import { getConfig } from '../config.js';
import { localAgentId } from '../providers.js';
import { streamCompletion } from '../net/stream.js';
import { pjEmit } from '../project/journal.js';
import { pjElide } from '../project/protocol.js';
import { activeProject, pjApi, projectDecisions, projectSeats, projectTasks, renderProjectTasksList, setProjectDecisions } from '../project/state.js';

/* ---------- tool execution ---------- */
async function pjSaveTasks() {
  if (!activeProject) return;
  try {
    await pjApi('/api/project/tasks', { id: activeProject.id, tasks: projectTasks });
  } catch { /* transient */ }
  renderProjectTasksList();
}

async function executeAgentBlock(block, seat, opts) {
  const started = performance.now();
  // Every call an agent triggers is abortable, so Stop reaches the server and
  // kills a running command instead of waiting out its timeout.
  const sig = opts.signal;
  const done = (ok, tool, args, detail, convo) => ({
    ok, tool, args, detail: String(detail || ''), convo: String(convo != null ? convo : detail || ''),
    ms: Math.round(performance.now() - started)
  });

  try {
    if (block.err) return done(false, block.kind === 'tool' ? 'tool' : block.kind, {}, block.err);

    if (block.kind === 'write' || block.kind === 'append') {
      const data = await pjApi('/api/project/fs', {
        id: activeProject.id, op: block.kind, path: block.path, content: block.content
      }, sig);
      const r = data.result;
      return done(true, block.kind, { path: block.path },
        `${block.kind === 'append' ? 'appended to' : 'wrote'} ${r.path} — ${r.lines} lines (${r.bytes} bytes)`);
    }

    if (block.kind === 'edit') {
      const read = await pjApi('/api/project/fs', { id: activeProject.id, op: 'read', path: block.path }, sig);
      if (read.result.binary) return done(false, 'edit', { path: block.path }, `${block.path} is binary — cannot edit`);
      let content = read.result.content;
      for (let k = 0; k < block.edits.length; k++) {
        const { find, replace } = block.edits[k];
        const first = content.indexOf(find);
        if (first === -1) {
          return done(false, 'edit', { path: block.path },
            `SEARCH block ${k + 1} not found in ${block.path} — re-read the file and match the exact current text`);
        }
        if (content.indexOf(find, first + 1) !== -1) {
          return done(false, 'edit', { path: block.path },
            `SEARCH block ${k + 1} matches multiple places in ${block.path} — include more surrounding lines to make it unique`);
        }
        content = content.slice(0, first) + replace + content.slice(first + find.length);
      }
      await pjApi('/api/project/fs', { id: activeProject.id, op: 'write', path: block.path, content }, sig);
      return done(true, 'edit', { path: block.path }, `applied ${block.edits.length} edit${block.edits.length === 1 ? '' : 's'} to ${block.path}`);
    }

    // JSON tools
    const spec = block.spec || {};
    const tool = String(spec.tool || '');
    if (tool === 'read_file') {
      const data = await pjApi('/api/project/fs', { id: activeProject.id, op: 'read', path: spec.path }, sig);
      const r = data.result;
      if (r.binary) return done(true, tool, spec, `${r.path} is binary (${r.size} bytes)`);
      return done(true, tool, spec, `read ${r.path} (${r.size} bytes)`, `--- ${r.path} ---\n${pjElide(r.content)}`);
    }
    if (tool === 'list_files') {
      const data = await pjApi('/api/project/fs', { id: activeProject.id, op: 'list', path: spec.path || '' }, sig);
      const lines = (data.result.entries || []).slice(0, 300).map((en) =>
        en.dir ? `${en.path}${en.skipped ? ' (contents skipped)' : ''}` : `${en.path} (${en.size}b)`
      );
      const body = lines.join('\n') + (data.result.truncated ? '\n…(truncated)' : '');
      return done(true, tool, spec, `${lines.length} entries`, body || '(empty)');
    }
    if (tool === 'run') {
      const data = await pjApi('/api/project/exec', {
        id: activeProject.id, command: spec.command, timeoutMs: spec.timeoutMs
      }, sig);
      const r = data.result;
      if (r.blocked || (r.error && r.code === -1 && !r.stdout)) {
        return done(false, tool, spec, r.error || 'command failed to start');
      }
      const out = [
        `exit ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''}${r.signal ? ` signal ${r.signal}` : ''} · ${r.ms}ms`,
        r.stdout ? `stdout:\n${pjElide(r.stdout, 6000)}` : '',
        r.stderr ? `stderr:\n${pjElide(r.stderr, 4000)}` : ''
      ].filter(Boolean).join('\n');
      // `ran` distinguishes "executed and exited non-zero" from "never ran":
      // the done-gate counts an executed command as work/inspection evidence
      // even when the exit code is non-zero (grep with no matches exits 1).
      return { ...done(r.code === 0, tool, spec, out), ran: true };
    }
    if (tool === 'mkdir' || tool === 'delete') {
      const data = await pjApi('/api/project/fs', { id: activeProject.id, op: tool, path: spec.path }, sig);
      return done(true, tool, spec, JSON.stringify(data.result));
    }
    if (tool === 'move') {
      const data = await pjApi('/api/project/fs', { id: activeProject.id, op: 'move', path: spec.path, to: spec.to }, sig);
      return done(true, tool, spec, `moved ${data.result.from} → ${data.result.to}`);
    }
    if (tool === 'task_add') {
      const t = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: String(spec.title || '').slice(0, 200), status: 'todo', by: '' };
      if (!t.title) return done(false, tool, spec, 'task_add needs a title');
      projectTasks.push(t);
      await pjSaveTasks();
      return done(true, tool, spec, `added [${t.id}] ${t.title}`);
    }
    if (tool === 'task_update') {
      const t = projectTasks.find((x) => x.id === spec.id);
      if (!t) return done(false, tool, spec, `no task with id ${spec.id} — check the board ids`);
      if (spec.status && ['todo', 'doing', 'done'].includes(spec.status)) {
        if (spec.status === 'doing' && t.by && t.by !== seat.name) {
          return done(false, tool, spec, `task [${t.id}] is claimed by ${t.by} — pick another task`);
        }
        t.status = spec.status;
        if (spec.status === 'doing') t.by = seat.name;
      }
      if (spec.note) t.note = String(spec.note).slice(0, 300);
      await pjSaveTasks();
      return done(true, tool, spec, `[${t.id}] → ${t.status}${t.by ? ` (${t.by})` : ''}`);
    }
    if (tool === 'decision') {
      const text = String(spec.text || '').slice(0, 1000);
      if (!text) return done(false, tool, spec, 'decision needs text');
      try {
        const data = await pjApi('/api/project/decision', { id: activeProject.id, by: seat.name, text }, sig);
        setProjectDecisions(data.decisions || projectDecisions);
      } catch { /* keep local */ }
      pjEmit({ type: 'decision', by: seat.name, text });
      return done(true, tool, spec, `recorded: ${text.slice(0, 120)}`);
    }
    if (tool === 'debate' || tool === 'council') {
      const question = String(spec.question || '').slice(0, 600);
      if (!question) return done(false, 'debate', spec, 'debate needs a question');
      const takes = await runProjectCouncil(question, seat, opts);
      if (takes === null) return done(false, 'debate', spec, 'debate aborted');
      pjEmit({ type: 'council', by: seat.name, question, takes });
      const convo = takes.map((t) => `${t.name}: ${t.text}`).join('\n\n');
      return done(true, 'debate', spec, `${takes.length} teammates answered`, `TEAM TAKES on "${question}":\n${convo}\n\nWeigh these and decide.`);
    }
    return done(false, tool || 'tool', spec, `Unknown tool "${tool}" — available: read_file, list_files, run, mkdir, move, delete, task_add, task_update, decision, debate`);
  } catch (e) {
    const label = block.kind === 'tool' ? (block.spec?.tool || 'tool') : block.kind;
    const args = block.spec || { path: block.path };
    // Stop aborted the fetch: the server has already killed the command.
    if (e.name === 'AbortError' || sig?.aborted) return { ...done(false, label, args, 'stopped by the user'), aborted: true };
    return done(false, label, args, e.message || 'operation failed');
  }
}

/** One blind round of teammate takes on a contested question */
async function runProjectCouncil(question, askingSeat, opts) {
  const seats = projectSeats().filter((s) => s.i !== askingSeat.i && s.provider);
  const cfg = getConfig();
  const results = await Promise.all(seats.map(async (s) => {
    try {
      const r = await streamCompletion({
        baseURL: s.provider.baseURL,
        apiKey: s.provider.apiKey,
        model: s.model,
        agent: localAgentId(s.provider),
        // Same elite effort as regular turns — a contested decision is exactly
        // where thinking pays off
        reasoningEffort: opts.effort,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        systemPrompt:
          `You are ${s.name}, an AI engineer on a project team. ${askingSeat.name} asked the team a contested question. ` +
          'Think it through at full depth, then give your independent, decisive take in under 120 words. Commit to a position. No tools, no hedging.',
        messages: [{ role: 'user', content: question }],
        signal: opts.signal,
        shouldCancel: opts.stale
      });
      if (r.cancelled) return null;
      return { name: s.name, seat: s.i, text: (r.content || '(no answer)').trim() };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      return { name: s.name, seat: s.i, text: `(error: ${e.message})` };
    }
  }));
  if (opts.stale() || results.some((r) => r === null && opts.signal.aborted)) return null;
  return results.filter(Boolean);
}

/* ---------- prompts ---------- */

export { executeAgentBlock, pjSaveTasks, runProjectCouncil };
