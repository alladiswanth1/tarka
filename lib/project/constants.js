'use strict';
/** Hard limits for Project Mode. Agents are told about these in their prompts. */

const TARKA_STATE_DIR = '.tarka';
const READ_CAP_BYTES = 512 * 1024;
const WRITE_CAP_BYTES = 5 * 1024 * 1024;
const EXEC_OUT_CAP = 200 * 1024;
const EXEC_TIMEOUT_DEFAULT = 60_000;
const EXEC_TIMEOUT_MAX = 300_000;
const JOURNAL_ROTATE_BYTES = 8 * 1024 * 1024;
const JOURNAL_TAIL_BYTES = 400 * 1024;

module.exports = {
  TARKA_STATE_DIR, READ_CAP_BYTES, WRITE_CAP_BYTES, EXEC_OUT_CAP,
  EXEC_TIMEOUT_DEFAULT, EXEC_TIMEOUT_MAX, JOURNAL_ROTATE_BYTES, JOURNAL_TAIL_BYTES
};
