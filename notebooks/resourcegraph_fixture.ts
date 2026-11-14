/** Fetch one immutable worker revision and run it with its frozen Bun lockfile.
 * Installation output goes to stderr: stdout belongs to the VGI Arrow protocol.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const [repository, revision, fixturePath, ...workerArgs] = process.argv.slice(2);
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !revision || !/^[0-9a-f]{40}$/.test(revision)
    || !fixturePath || isAbsolute(fixturePath) || fixturePath.split('/').includes('..')) {
  throw new Error('Usage: bun run resourcegraph_fixture.ts owner/repo FULL_COMMIT relative/fixture.json');
}
const cacheRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'vgi-notebook-workers', repository);
mkdirSync(cacheRoot, { recursive: true });
const checkout = join(cacheRoot, `${revision}-bun-${Bun.version}`);
const ready = join(checkout, '.notebook-worker-ready');
const lock = checkout + '.lock';
const deadline = Date.now() + 180_000;
let ownsLock = false;
while (!existsSync(ready)) {
  try { mkdirSync(lock); ownsLock = true; break; }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for worker cache lock: ${lock}`);
    await Bun.sleep(250);
  }
}
if (ownsLock) {
  let staging: string | undefined;
  try {
    if (!existsSync(ready)) {
      staging = mkdtempSync(join(cacheRoot, '.install-'));
      const run = (command: string, args: string[]) => {
        const result = spawnSync(command, args, { cwd: staging, stdio: ['ignore', 2, 2] });
        if (result.error || result.status !== 0) throw new Error(`Worker setup failed: ${command} ${args.join(' ')}`, { cause: result.error });
      };
      run('git', ['init', '--quiet']);
      run('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
      run('git', ['fetch', '--quiet', '--depth', '1', 'origin', revision]);
      run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: staging, encoding: 'utf8' });
      if (actual.status !== 0 || actual.stdout.trim() !== revision) throw new Error('Fetched revision did not match the pinned commit.');
      if (!existsSync(join(staging, 'bun.lock')) && !existsSync(join(staging, 'bun.lockb'))) throw new Error('Pinned worker has no Bun lockfile.');
      run(process.execPath, ['install', '--frozen-lockfile']);
      writeFileSync(join(staging, '.notebook-worker-ready'), JSON.stringify({ repository, revision, bun: Bun.version }));
      renameSync(staging, checkout);
      staging = undefined;
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
const marker = JSON.parse(readFileSync(ready, 'utf8'));
if (marker.repository !== repository || marker.revision !== revision || marker.bun !== Bun.version) {
  throw new Error(`Worker cache marker does not match this pin: ${checkout}`);
}

// Original worker function and schema; the shipped fake serves declared data only.
const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8'));
const requireWorker = createRequire(join(checkout, 'package.json'));
const { Worker, ReadOnlyCatalogInterface, FunctionRegistry } = await import(requireWorker.resolve('@query-farm/vgi'));
const { makeResourceGraphFunction } = await import(pathToFileURL(join(checkout, 'src/functions.ts')).href);
const { makeCatalog } = await import(pathToFileURL(join(checkout, 'src/catalog.ts')).href);
const { FakeArg, ARG_ENDPOINT } = await import(pathToFileURL(join(checkout, 'test/fake-arg.ts')).href);
const active = new Map<string, { fake: InstanceType<typeof FakeArg>; identity: string }>();
globalThis.fetch = (() => { throw new Error('Network fetch is disabled in the synthetic Resource Graph fixture.'); }) as typeof fetch;
const client = {
  fetchJson: async () => { throw new Error('The fixture only supports declared Resource Graph query POSTs.'); },
  postJson: async (url: string, body: any) => {
    if (url !== ARG_ENDPOINT) throw new Error('Unsupported fixture endpoint: ' + url);
    const scenario = fixture.queries.find((q: any) => q.kql === body.query);
    if (!scenario || body.subscriptions !== undefined || body.options.resultFormat !== 'objectArray') {
      throw new Error('Fixture only supports its exact declared KQL and unscoped objectArray queries.');
    }
    const identity = JSON.stringify({ query: body.query, top: body.options.$top });
    if (!body.options.$skipToken) {
      const fake = new FakeArg(body.options.$top);
      for (const row of scenario.rows) fake.upsert(row);
      active.set(body.query, { fake, identity });
    }
    const state = active.get(body.query);
    if (!state || state.identity !== identity) throw new Error('Query identity changed during pagination.');
    const response = await state.fake.client.postJson(url, body);
    if (process.env.VGI_RESOURCEGRAPH_FIXTURE_TRACE) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.VGI_RESOURCEGRAPH_FIXTURE_TRACE, JSON.stringify({ url, body, response_rows: response.data.length, has_next: !!response.$skipToken }) + '\n');
    }
    return response;
  },
};
const functions = [makeResourceGraphFunction(() => client)];
const registry = new FunctionRegistry();
for (const fn of functions) registry.register(fn);
const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);
new Worker({ functions, catalogInterface }).run(workerArgs);
