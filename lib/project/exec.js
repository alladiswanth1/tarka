'use strict';
/**
 * Shell execution for Project Mode.
 *
 * Commands run with the project folder as cwd, a hard timeout, output caps,
 * and process-GROUP kill so a shell pipeline dies whole. Not containerized:
 * this is a loopback-only local power tool, and the catastrophic-command
 * guard below is a seatbelt, not a sandbox.
 */
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { EXEC_OUT_CAP, EXEC_TIMEOUT_DEFAULT, EXEC_TIMEOUT_MAX } = require('./constants');
const { scrubSpawnEnv, commandExitFacts } = require('../spawn-hygiene');

/**
 * Where a command can begin: the start of the string, or after any separator sh
 * treats as one. `\n` is a separator exactly like `;`, `(` and `{` open command
 * groups, and a quote or backtick starts a nested command — so `(rm -rf /)`,
 * `` `rm -rf /` `` and `sh -c 'rm -rf /'` are all command positions too. A few
 * keywords may sit in front (`; do rm …`, `time rm …`).
 */
const CMD_START =
  "(?:^|[;&|\\n({`'\"])\\s*(?:(?:do|then|else|elif|time|command|exec|nohup|env)\\s+)*";
/** `rm` plus any run of flags, e.g. `rm -rf`, `rm --recursive -f`. */
const RM_FLAGS = String.raw`rm\s+(?:-[a-zA-Z-]+\s+)*`;
/**
 * What may follow the target and still mean "that was the whole path".
 * Whitespace and end-of-string are the obvious ones; the rest are how a command
 * ends inside a group or list — `(rm -rf /)`, `{ rm -rf /; }`, `do rm -rf /; done`.
 * Anything else means the path continued (`/tmp/scratch`) and is ordinary work.
 */
const TARGET_END = String.raw`(?:\s|$|['")\];&|])`;

/**
 * Commands that are never worth running, even in fully-automatic mode.
 *
 * Two deliberate calibrations:
 *
 * - The destructive-verb list only fires in COMMAND position. Matching
 *   `\bshutdown\b` anywhere refused ordinary work — `git commit -m "fix
 *   shutdown handler"`, `grep -rn sudo /etc/sudoers.d`, `make halt` — and a
 *   guard that blocks the job it was hired to protect just gets worked around.
 * - `~` and `$HOME` are guarded alongside `/`. The project folder is refused if
 *   it IS your home directory, so losing it to a stray cleanup command is the
 *   same unrecoverable outcome by another route. A path INSIDE it
 *   (`rm -rf ~/projects/old`) is ordinary work and stays allowed.
 *
 * This is still a seatbelt, not a sandbox: `run` is unrestricted by design, and
 * anything determined enough to reach for `python3 -c` will get there.
 */
const CATASTROPHIC_RE = new RegExp(
  [
    // rm on the filesystem root: bare "/", the "/*" glob that is how this is
    // usually written, "/." and "//".
    CMD_START + RM_FLAGS + String.raw`['"]?\/[*.\/]?` + TARGET_END,
    // rm on the user's entire home directory
    CMD_START + RM_FLAGS + String.raw`['"]?(?:~|\$HOME|\$\{HOME\})(?:\/\*?|\*)?['"]?` + TARGET_END,
    CMD_START + String.raw`(?:sudo|doas|mkfs[a-z.0-9]*|shutdown|reboot|poweroff|halt)\b`,
    String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;`, // fork bomb
    String.raw`\bdd\b[^|;&]*\bof=\/dev\/`
  ].join('|')
);

/** Run a shell command inside the project folder. */
function projectExec(project, req, res, body) {
  return new Promise((resolve) => {
    const command = String(body.command || '').trim();
    if (!command) return resolve({ error: 'Command is required', code: -1 });
    if (CATASTROPHIC_RE.test(command)) {
      return resolve({
        error: 'Command blocked by the catastrophic-command guard (rm on /, mkfs, shutdown, sudo, fork bombs, dd to devices)',
        blocked: true,
        code: -1
      });
    }
    const timeoutMs = Math.min(
      EXEC_TIMEOUT_MAX,
      Math.max(1000, Number(body.timeoutMs) || EXEC_TIMEOUT_DEFAULT)
    );
    const isWin = process.platform === 'win32';
    const env = scrubSpawnEnv(process.env);
    const child = isWin
      ? spawn('cmd', ['/c', command], { cwd: project.folder, env })
      : spawn('/bin/sh', ['-c', command], { cwd: project.folder, env, detached: true });

    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const killTree = () => {
      try {
        if (!isWin && child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        } else if (isWin && child.pid) {
          // No process groups on Windows: killing cmd.exe alone leaves
          // grandchildren (npm → node) running forever. taskkill /T walks the
          // tree.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    // If the browser aborts (Stop button / tab closed), kill the command too.
    // This must hang off the RESPONSE, not the request: since Node 16 an
    // IncomingMessage emits 'close' as soon as its body has been consumed —
    // long before the client goes away — so req.on('close') would fire
    // instantly here and never signal a real disconnect. `res` closes only
    // when the response finishes or the socket dies, and by the former point
    // the child has already exited, so killTree() is a no-op.
    let aborted = false;
    const onClose = () => {
      if (settled) return;
      aborted = true;
      killTree();
    };
    res.on('close', onClose);

    // A pipe chunk can end mid-character: `c.toString('utf8')` per chunk turns
    // any multi-byte output (accents, CJK, box drawing, emoji in test runners)
    // into replacement characters at 64KB boundaries. StringDecoder holds the
    // partial sequence until the rest arrives.
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    child.stdout.on('data', (c) => {
      outBytes += c.length;
      const s = outDec.write(c);
      if (stdout.length < EXEC_OUT_CAP) stdout += s;
      if (stdout.length >= EXEC_OUT_CAP) truncated = true;
    });
    child.stderr.on('data', (c) => {
      errBytes += c.length;
      const s = errDec.write(c);
      if (stderr.length < EXEC_OUT_CAP) stderr += s;
      if (stderr.length >= EXEC_OUT_CAP) truncated = true;
    });
    let exitInfo = null;
    let graceTimer = null;
    const settle = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      res.off('close', onClose);
      // Flush any trailing partial multi-byte sequence held by the decoders
      if (stdout.length < EXEC_OUT_CAP) stdout += outDec.end();
      if (stderr.length < EXEC_OUT_CAP) stderr += errDec.end();
      const code = exitInfo == null || exitInfo.code == null ? -1 : exitInfo.code;
      const facts = commandExitFacts({
        timedOut,
        signal: exitInfo && exitInfo.signal,
        exitCode: code,
        aborted
      });
      resolve({
        code,
        signal: facts.signal || undefined,
        stdout: stdout.slice(0, EXEC_OUT_CAP),
        stderr: stderr.slice(0, EXEC_OUT_CAP),
        truncated,
        timedOut: facts.timedOut,
        aborted: facts.aborted,
        cleanSuccess: facts.cleanSuccess,
        ms: Date.now() - started,
        ...(extra || {})
      });
    };
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      res.off('close', onClose);
      resolve({ error: err.message, code: -1 });
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      // 'close' waits for stdio to drain, which normally follows within
      // milliseconds. When it doesn't, a backgrounded grandchild ("node
      // server.js &") inherited the pipes — the shell is done, so report the
      // result instead of hanging the full timeout and then SIGKILLing the
      // very server the agent just started.
      graceTimer = setTimeout(
        () => settle({ note: 'a background process is still running and holding the output pipes' }),
        1500
      );
      if (graceTimer.unref) graceTimer.unref();
    });
    child.on('close', () => settle());
  });
}

module.exports = { CATASTROPHIC_RE, projectExec, scrubSpawnEnv, commandExitFacts };
