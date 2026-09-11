#!/usr/bin/env node
'use strict';
/** A `claude` that exits before reading stdin — the EPIPE case. */
if (process.argv.includes('--version')) {
  process.stdout.write('1.2.3\n');
  process.exit(0);
}
process.stderr.write('Not logged in. Please run /login.\n');
process.exit(1);
