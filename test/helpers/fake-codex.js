#!/usr/bin/env node
'use strict';
/** Stand-in `codex` CLI for local-agent tests. Never talks to OpenAI. */
const fs = require('fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.4.0\n');
  process.exit(0);
}
const i = process.argv.indexOf('--output-last-message');
const dest = i >= 0 ? process.argv[i + 1] : null;
process.stdin.resume();
process.stdin.on('end', () => {
  const text = 'Hello from Codex';
  if (dest) fs.writeFileSync(dest, text);
  else process.stdout.write(text);
  process.exit(0);
});
