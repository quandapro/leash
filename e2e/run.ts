// npm run e2e: builds the production image, runs it with a 2 vCPU / 4 GB limit next to a mock provider,
// runs the scenario and a latency test from a third container, then checks limits, user and memory.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), 'compose.yml');
const dc = (...args: string[]) => ['compose', '-f', file, ...args];
const run = (args: string[]) => {
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  return r.status ?? 1;
};
const out = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

let code = 1;
try {
  if (run(dc('up', '-d', '--build', '--wait', 'mock', 'leash')) !== 0) throw new Error('stack failed to start');
  const id = out(dc('ps', '-q', 'leash'));
  const [cpus, mem, user, ro] = out(['inspect', '-f', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}', id]).split(' ');
  console.log(`leash container: cpus=${Number(cpus) / 1e9} memory=${Number(mem) / 2 ** 30} GiB user=${user} read-only=${ro}`);
  if (Number(cpus) !== 2e9 || Number(mem) !== 4 * 2 ** 30) throw new Error('container is not limited to 2 vCPU / 4 GB');
  if (user !== 'node') throw new Error('container must not run as root');

  code = run(dc('--profile', 'run', 'run', '--rm', 'runner'));
  console.log('leash memory after run:', out(['stats', '--no-stream', '--format', '{{.MemUsage}} cpu {{.CPUPerc}}', id]));
  console.log('image size:', out(['image', 'inspect', '-f', '{{.Size}}', 'leash:e2e']), 'bytes');
  if (code !== 0) run(dc('logs', '--tail', '50', 'leash'));
} catch (e) {
  console.error((e as Error).message);
  run(dc('logs', '--tail', '50'));
} finally {
  run(dc('--profile', 'run', 'down', '-v', '--remove-orphans'));
}
console.log(code === 0 ? 'E2E PASSED' : 'E2E FAILED');
process.exit(code);
