// Local demo: Leash on http://127.0.0.1:8790 with a mock provider, populated by the e2e scenario
// (keys, a blocked loop, budget warnings, redactions, alerts). For design work and screenshots.
// Usage: npm run demo   (admin token: demo-admin-token-0123456789abcdef)
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { buildServer } from '../src/main.ts';
import { MOCK_ANTHROPIC_KEY, MOCK_OPENAI_KEY, startMock } from '../e2e/mock-upstream.ts';
import { scenario } from '../e2e/scenario.ts';

const PORT = Number(process.env.PORT ?? 8790);
const admin = 'demo-admin-token-0123456789abcdef';
const mock = await startMock();
const cfg = loadConfig({
  LEASH_ADMIN_TOKEN: admin,
  LEASH_SECRET: 'demo-secret-0123456789abcdef0123456789abcdef',
  LEASH_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
  LEASH_ANTHROPIC_KEY: MOCK_ANTHROPIC_KEY,
  LEASH_ANTHROPIC_BASE_URL: mock.url,
  LEASH_OPENAI_KEY: MOCK_OPENAI_KEY,
  LEASH_OPENAI_BASE_URL: mock.url,
  LEASH_ALLOW_HTTP_UPSTREAM: '1',
});
const store = new Store(':memory:');
const server = buildServer(cfg, store);
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
const leash = `http://127.0.0.1:${PORT}`;
await scenario({ leash, admin, mock: mock.url, mockFromLeash: mock.url, log: () => {} });
// The scenario resumes the session it paused; pause it again so the demo shows the most important state.
store.setSessionStatus('1:loop-test', 'blocked', 'Same Bash failure 3 times in a row: Error: 1 failing test in auth.spec.ts');
console.log(`Leash demo on ${leash}  (admin token: ${admin})`);
