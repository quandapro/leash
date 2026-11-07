// Runs the full end-to-end scenario against an in-process Leash and mock provider.
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { buildServer } from '../src/main.ts';
import { MOCK_ANTHROPIC_KEY, MOCK_OPENAI_KEY, startMock } from '../e2e/mock-upstream.ts';
import { scenario } from '../e2e/scenario.ts';

test('end-to-end scenario (in process)', async () => {
  const mock = await startMock();
  const admin = 'test-admin-token-0123456789abcdef';
  const cfg = loadConfig({
    LEASH_ADMIN_TOKEN: admin,
    LEASH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    LEASH_ANTHROPIC_KEY: MOCK_ANTHROPIC_KEY,
    LEASH_ANTHROPIC_BASE_URL: mock.url,
    LEASH_OPENAI_KEY: MOCK_OPENAI_KEY,
    LEASH_OPENAI_BASE_URL: mock.url,
    LEASH_ALLOW_HTTP_UPSTREAM: '1',
  });
  const store = new Store(':memory:');
  const server = buildServer(cfg, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const leash = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await scenario({ leash, admin, mock: mock.url, mockFromLeash: mock.url });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    mock.server.closeAllConnections();
    await new Promise((r) => mock.server.close(r));
    store.close();
  }
});
