#!/usr/bin/env node
'use strict';
/** Stand-in `grok` CLI for local-agent tests. Never talks to xAI. */
if (process.argv.includes('--version')) {
  process.stdout.write('grok 1.0.4\n');
  process.exit(0);
}
const fs = require('fs');
const i = process.argv.indexOf('--prompt-file');
const src = i >= 0 ? process.argv[i + 1] : null;
if (src) {
  try {
    fs.readFileSync(src, 'utf8');
  } catch {
    /* prompt file optional for the fake */
  }
}
process.stdout.write(JSON.stringify({ type: 'thought', data: 'planning' }) + '\n');
process.stdout.write(JSON.stringify({ type: 'text', data: 'Hello' }) + '\n');
process.stdout.write(JSON.stringify({ type: 'text', data: ' from Grok' }) + '\n');
process.stdout.write(JSON.stringify({ type: 'end', stopReason: 'end_turn' }) + '\n');
process.exit(0);
