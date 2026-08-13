'use strict';
/**
 * Every path the app resolves against itself, in one place.
 *
 * These MUST be derived from the repository root, not from __dirname of
 * whatever module happens to need them: `validateProjectFolder` uses APP_DIR
 * to refuse a project folder that would let agents write to Tarka's own
 * source. Computing that from `lib/project/__dirname` would quietly narrow
 * the guard to `lib/project`, leaving the app root writable.
 */
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(APP_DIR, 'data');
const PROJECTS_INDEX = path.join(DATA_DIR, 'projects.json');

module.exports = { APP_DIR, PUBLIC_DIR, DATA_DIR, PROJECTS_INDEX };
