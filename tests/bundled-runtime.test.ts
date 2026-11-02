import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import type { RuntimeConnection } from '../src/protocol';

const executable = process.env.LOGSEQ_TEST_EXECUTABLE || '/Applications/Logseq.app/Contents/MacOS/Logseq';
test('bundled Electron runtime runs Node snippets, prevents duplicates, and reclaims stale locks', { skip: !existsSync(executable) }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'logseq-helper-test-'));
  const session = randomUUID(); const children: ChildProcess[] = [];
  let connection: RuntimeConnection | undefined;
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await delay(1200); await rm(directory, { recursive: true, force: true });
  });
  const entry = join(directory, 'helper.cjs');
  await build({ entryPoints: [resolve('src/helper.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const launch = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin' }; delete env.NODE_OPTIONS;
    const child = spawn(executable, [entry, '--session', session, '--directory', directory], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child); return child;
  };
  const readConnection = async (previous?: string) => {
    for (let i = 0; i < 70; i++) {
      try { const data = JSON.parse(await readFile(join(directory, session + '.json'), 'utf8')) as RuntimeConnection;
        if (data.instance !== previous) return data;
      } catch {} await delay(50);
    }
    throw new Error('Helper did not publish its connection.');
  };
  launch(); launch(); connection = await readConnection();
  assert.equal((await stat(join(directory, session + '.json'))).mode & 0o777, 0o600);
  const request = (path: string, data?: unknown) => fetch(connection!.helperUrl + path, {
    headers: { Authorization: `Bearer ${connection!.helperToken}`, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
  });
  const acquire = async () => {
    const stream = await request('/lease'); const reader = stream.body!.getReader();
    const item = await reader.read(); const lease = JSON.parse(new TextDecoder().decode(item.value).trim()).lease;
    assert.equal((await request('/heartbeat', { lease })).status, 200); return { reader, lease };
  };
  const { reader, lease } = await acquire();
  const response = await request('/runs', { command: 'node -e $', snippet: 'console.log("Node="+process.versions.node);process.stdin.once("data",s=>console.log("Hello "+s.toString().trim()))', directory, owner: 'input' });
  const run = await response.json() as { id: string };
  assert.equal(response.status, 201);
  await request(`/runs/${run.id}/input`, { text: 'Ada\n', end: true });
  let result: any;
  for (let i = 0; i < 70; i++) { result = await (await request(`/runs/${run.id}`)).json(); if (result.state === 'finished') break; await delay(40); }
  assert.equal(result.state, 'finished'); assert.match(result.output, /Hello Ada/);
  await delay(100); assert.equal(children.filter(child => child.exitCode === null).length, 1);
  await request('/release', { lease }); await reader.cancel();
  for (let i = 0; i < 60 && existsSync(join(directory, session + '.lock')); i++) await delay(50);
  assert.equal(existsSync(join(directory, session + '.lock')), false);
  // A reused PID must not make an unrelated process look like the old helper.
  await writeFile(join(directory, session + '.lock'), JSON.stringify({ pid: process.pid, start: 'old-process-birth', instance: 'stale' }));
  const previous = connection.instance; launch(); connection = await readConnection(previous);
  assert.notEqual(connection.instance, previous);
  const next = await acquire(); await request('/release', { lease: next.lease }); await next.reader.cancel();
  for (let i = 0; i < 60 && existsSync(join(directory, session + '.lock')); i++) await delay(50);
  // Interrupted older launchers could leave an empty lock behind.
  const lock = join(directory, session + '.lock');
  await writeFile(lock, ''); await utimes(lock, new Date(0), new Date(0));
  const stale = connection.instance; launch(); connection = await readConnection(stale);
  const recovered = await acquire(); await request('/release', { lease: recovered.lease }); await recovered.reader.cancel();
});
