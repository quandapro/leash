#!/usr/bin/env node
// Git pre-commit gate: (1) code changes must ship with a kb/STATE.md update,
// (2) staged additions must not contain anything that looks like a real secret.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').filter(Boolean);
let failed = false;

const code = staged.filter((f) => !f.startsWith('kb/') && !/^(README|SECURITY|CONTRIBUTING|LICENSE)/.test(f));
if (code.length > 0 && !staged.includes('kb/STATE.md')) {
  console.error('KB gate: code is staged but kb/STATE.md is not. Update the knowledge base and stage it.');
  failed = true;
}

// Fixtures build fake secrets by concatenation, so a literal match here means a real one.
const patterns = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /github_pat_[A-Za-z0-9_]{22,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-(proj-)?[A-Za-z0-9]{32,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\b(sk|rk)_live_[A-Za-z0-9]{16,}/,
];
const diff = git('diff', '--cached', '-U0', '--no-color');
let file = '';
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) file = line.slice(6);
  else if (line.startsWith('+') && !line.startsWith('+++')) {
    const hit = patterns.find((p) => p.test(line));
    if (hit) { console.error(`Secret scan: ${file} adds a line matching ${hit}`); failed = true; }
  }
}

process.exit(failed ? 1 : 0);
