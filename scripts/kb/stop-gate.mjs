#!/usr/bin/env node
// Stop hook: blocks the end of a turn when code changed but kb/STATE.md did not, so the
// knowledge base never falls behind the code. Uses stop_hook_active to avoid loops.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input || '{}'); } catch { /* ignore */ }
  if (payload.stop_hook_active) return;

  let status = '';
  try {
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  } catch { return; }

  const changed = status.split('\n').filter(Boolean).map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
  const code = changed.filter((f) => !f.startsWith('kb/') && !f.startsWith('node_modules/'));
  const stateTouched = changed.includes('kb/STATE.md');

  if (code.length > 0 && !stateTouched) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `Uncommitted changes (${code.slice(0, 5).join(', ')}${code.length > 5 ? ', ...' : ''}) but kb/STATE.md is unchanged. ` +
        'Update kb/STATE.md (status, next steps) and kb/DECISIONS.md if you made a decision, then commit if tests pass.',
    }));
  }
});
