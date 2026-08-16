#!/usr/bin/env node
'use strict';
/** Stand-in `claude` CLI for local-agent tests. Never talks to Anthropic. */
if (process.argv.includes('--version')) {
  process.stdout.write('1.2.3\n');
  process.exit(0);
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
});
process.stdin.on('end', () => {
  process.stdout.write(
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }) + '\n'
  );
  process.stdout.write(
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' from Claude' } }) + '\n'
  );
  process.exit(0);
});
