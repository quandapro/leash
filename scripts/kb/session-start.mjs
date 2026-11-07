#!/usr/bin/env node
// SessionStart hook (startup, resume, clear, compact): prints the knowledge base so every
// new or compacted session starts with the project's current state, decisions and runbook.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const kb = join(root, 'kb');
const read = (name) => (existsSync(join(kb, name)) ? readFileSync(join(kb, name), 'utf8') : '');

const decisions = read('DECISIONS.md')
  .split('\n')
  .filter((l) => l.startsWith('## '))
  .map((l) => '- ' + l.slice(3))
  .join('\n');

const out = [
  '# Leash knowledge base (auto-loaded by kb/session-start hook)',
  `Repo: ${root}`,
  'Rules: kb/README.md. Update kb/STATE.md before ending a turn that changed code; add an entry to kb/DECISIONS.md for every non-obvious decision.',
  '',
  read('STATE.md'),
  '',
  '# Decision index (full text in kb/DECISIONS.md)',
  decisions,
  '',
  read('RUNBOOK.md'),
].join('\n');

process.stdout.write(out.length > 20000 ? out.slice(0, 20000) + '\n[truncated: read kb/ files directly]\n' : out);
