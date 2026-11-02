import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Lease } from '../src/lease';
import { createHelper } from '../src/server';
import { ManagedRuntime, shellQuote } from '../src/host-runtime';
import { Client } from '../src/client';

test('leases expire, reject stale clients, and allow a grace period after system suspension', () => {
  let time = 0; const lease = new Lease(100, () => time);
  const first = lease.connect(); time = 50; lease.acknowledge(first);
  const second = lease.connect(); assert.throws(() => lease.release(first), /expired/);
  time = 140; assert.equal(lease.check(), false);
  time = 151; assert.equal(lease.check(), true);
  assert.throws(() => lease.acknowledge(second), /expired/);
  time = 0; const waking = new Lease(100, () => time); const id = waking.connect();
  time = 10_000; assert.equal(waking.check(), false); waking.acknowledge(id);
  time = 10_101; assert.equal(waking.check(), true);
});

test('launcher paths are single shell arguments, including quotes and shell metacharacters', () => {
  assert.equal(shellQuote("/some path/it's $(literal)"), "'/some path/it'\\''s $(literal)'");
  assert.throws(() => shellQuote('bad\npath'), /Invalid/);
});

test('startup checks version and permission without changing native settings', async () => {
  const storage = new Map<string, string>();
  let reads = 0;
  const host = { sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    apis: { _callApplication() { throw new Error('Must not launch'); }, async doAction(args: unknown[]) {
      if (args[0] === 'getAppBaseInfo') return { platform: 'darwin' };
      assert.deepEqual(args, ['userAppCfgs', null, null, 'js-obj']); reads++; return {};
    } } } as any;
  const api = { App: { getInfo: async () => ({ version: '2.0.2' }) } };
  await assert.rejects(new ManagedRuntime(api, host).ensure(), /needs permission/); assert.equal(reads, 1);
  api.App.getInfo = async () => ({ version: '9.9.9' });
  await assert.rejects(new ManagedRuntime(api, host).ensure(), /supports Logseq 2\.0\.x/); assert.equal(reads, 1);
  api.App.getInfo = async () => ({ version: '2.0.2' });
  host.apis.doAction = async (args: unknown[]) => args[0] === 'getAppBaseInfo' ? { platform: 'darwin' } : { 'commands-allowlist': 'env' };
  await assert.rejects(new ManagedRuntime(api, host).ensure(), /invalid command allowlist/);
});

test('untested patches warn once and continue checks, while other minors are blocked', async () => {
  const warnings: string[] = []; let checks = 0;
  const host = { sessionStorage: { getItem: () => null, setItem() {} }, apis: {
    _callApplication() { throw new Error('Must not launch without permission'); },
    async doAction(args: unknown[]) { checks++; return args[0] === 'getAppBaseInfo' ? { platform: 'darwin' } : {}; },
  } } as any;
  const api = { App: { getInfo: async () => ({ version: '2.0.3' }) }, UI: { showMsg: (message: string) => warnings.push(message) } };
  const runtime = new ManagedRuntime(api, host);
  await assert.rejects(runtime.ensure(), /needs permission/);
  await assert.rejects(runtime.ensure(), /needs permission/);
  assert.equal(warnings.length, 1); assert.match(warnings[0]!, /not been tested with Logseq 2\.0\.3/);
  api.App.getInfo = async () => ({ version: '2.1.0' }); const previous = checks;
  await assert.rejects(runtime.ensure(), /supports Logseq 2\.0\.x/); assert.equal(checks, previous);
  api.App.getInfo = async () => ({ version: '2.0.4' }); host.apis._callApplication = undefined;
  await assert.rejects(runtime.ensure(), /launcher is unavailable/);
});

test('a restarted helper releases the Run button instead of polling a missing process forever', async t => {
  const id = 'd524f2b9-b4b2-4c52-aa9a-f249336c54c5';
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => options.method === 'POST'
    ? Response.json({ id, state: 'running', output: 'ready', offset: 5, reset: false, inputOpen: true, exitCode: null, signal: null, error: null })
    : Response.json({ code: 'RUN_NOT_FOUND', error: 'This process no longer exists.' }, { status: 404 }));
  const client = new Client(() => ({ helperUrl: 'http://127.0.0.1:12345', helperToken: 'test-token' }));
  t.after(() => client.close());
  await client.start('block', { command: 'node -e $', snippet: '0', directory: '/tmp', owner: 'block' });
  assert.equal(client.get('block').state, 'stopped'); assert.equal(client.get('block').inputOpen, false);
  assert.equal(client.get('block').output, 'ready'); assert.match(client.get('block').error!, /restarted/);
});

test('a lost window stops its processes without affecting another window', async t => {
  const token = 'test-window-token-'.repeat(4);
  const first = createHelper(token, undefined, { session: 'one', instance: 'one', timeout: 250, pingInterval: 50 });
  const second = createHelper(token, undefined, { session: 'two', instance: 'two', timeout: 250, pingInterval: 50 });
  t.after(async () => { await Promise.all([first.close(), second.close()]); });
  for (const helper of [first, second]) await new Promise<void>(resolve => helper.server.listen(0, '127.0.0.1', resolve));
  const url = (helper: typeof first) => `http://127.0.0.1:${(helper.server.address() as { port: number }).port}`;
  const firstUrl = url(first), secondUrl = url(second);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = (base: string, path: string, data?: unknown) => fetch(base + path, { headers, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
  const controllers = [new AbortController(), new AbortController()];
  t.after(() => controllers.forEach(c => c.abort()));
  const leases: string[] = [];
  for (const [i, base] of [firstUrl, secondUrl].entries()) {
    const response = await fetch(base + '/lease', { headers, signal: controllers[i]!.signal });
    const data = await response.body!.getReader().read();
    const id = JSON.parse(new TextDecoder().decode(data.value).trim()).lease;
    leases.push(id); assert.equal((await request(base, '/heartbeat', { lease: id })).status, 200);
  }
  const code = 'console.log("ready");setInterval(()=>{},1000)';
  const create = async (base: string) => {
    const response = await request(base, '/runs', { command: 'node -e $', snippet: code, directory: '/tmp', owner: 'same-block' });
    assert.equal(response.status, 201); return await response.json() as { id: string };
  };
  const [a, b] = await Promise.all([create(firstUrl), create(secondUrl)]);
  controllers[0]!.abort();
  const deadline = Date.now() + 5000;
  while (first.processes.get(a.id).state !== 'stopped' && Date.now() < deadline) {
    assert.equal((await request(secondUrl, '/heartbeat', { lease: leases[1] })).status, 200);
    await delay(40);
  }
  assert.equal(first.processes.get(a.id).state, 'stopped');
  assert.equal(second.processes.get(b.id).state, 'running');
  assert.equal((await request(secondUrl, '/release', { lease: 'stale' })).status, 400);
  assert.equal((await request(secondUrl, '/release', { lease: leases[1] })).status, 200);
  await second.close(); assert.equal(second.processes.get(b.id).state, 'stopped');
});
