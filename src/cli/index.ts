#!/usr/bin/env node

// ============================================
// AccessNexus CLI — `accessnexus` bin entry point
// Usage: npx accessnexus <command> [flags]   (see run.ts / llms.txt)
// ============================================

import { runCli } from './run.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    // exitCode (not process.exit) lets large --json output flush to a pipe.
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 2;
  },
);
