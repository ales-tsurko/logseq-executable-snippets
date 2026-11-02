import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Processes, type RunSnapshot } from '../src/processes';
import { commandArguments, DEFAULT_TEMPLATES, normalizeTemplates, runtimeFor } from '../src/templates';
import { createHelper } from '../src/server';
import { request as httpRequest } from 'node:http';

async function until(read: () => RunSnapshot, predicate: (value: RunSnapshot) => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const state = read(); if (predicate(state)) return state; await delay(20); }
  throw new Error('Timed out waiting for the process.');
}
test('templates pass the complete snippet as exactly one argument', () => {
  const code = 'const value = "quotes \\\" and \' and $HOME and $(touch SHOULD_NOT_EXIST)";\nconsole.log(value);';
  assert.deepEqual(commandArguments('node -e $', code), ['node', ['-e', code]]);
  assert.deepEqual(commandArguments('"/path with spaces/python" -u -c "$"', code), ['/path with spaces/python', ['-u', '-c', code]]);
  assert.deepEqual(commandArguments("program --flag 'a b' -e $", ''), ['program', ['--flag', 'a b', '-e', '']]);
  assert.throws(() => commandArguments('node -e', code), /Use \$/);
  assert.throws(() => commandArguments('node $ $', code), /Use \$/);
  assert.throws(() => commandArguments('node "', code), /unclosed/);
});
test('runtime presets are editable, language-matched, and not shared mutable state', () => {
  const first = normalizeTemplates(undefined); first[0]!.name = 'Changed';
  assert.notEqual(normalizeTemplates(undefined)[0]!.name, 'Changed');
  assert.equal(runtimeFor(DEFAULT_TEMPLATES, 'Python')!.id, 'python');
  assert.equal(runtimeFor(DEFAULT_TEMPLATES, 'javascript', 'bun')!.id, 'bun');
  assert.deepEqual(normalizeTemplates([]), []);
  assert.throws(() => normalizeTemplates([{ ...DEFAULT_TEMPLATES[0], command: 'sh -c' }]), /Use \$/);
});
test('multiline code, stdout, stderr, Unicode, working directories, and failures', async t => {
  const processes = new Processes(); const directory = await mkdtemp(join(tmpdir(), 'snippets-test-'));
  t.after(async () => { await processes.close(); await rm(directory, { recursive: true, force: true }); });
  const snippet = 'console.log("Привет \' $HOME $(literal)");\nconsole.error("stderr");\nconsole.log(process.cwd());';
  const run = await processes.start({ command: 'node -e $', snippet, directory, owner: 'unicode' });
  const finished = await until(() => processes.get(run.id), v => v.state !== 'running');
  assert.equal(finished.state, 'finished');
  assert.match(finished.output, /Привет ' \$HOME \$\(literal\)/);
  assert.match(finished.output, /stderr/); assert.ok(finished.output.includes(directory.replace(/^\/var\//, '/private/var/')) || finished.output.includes(directory));
  const failed = await processes.start({ command: 'node -e $', snippet: 'process.exit(7)', directory, owner: 'failure' });
  assert.equal((await until(() => processes.get(failed.id), v => v.state !== 'running')).exitCode, 7);
});
test('prompts are streamed before input, input can be sent repeatedly, and EOF completes the process', async t => {
  const processes = new Processes(); t.after(() => processes.close());
  const snippet = 'process.stdout.write("Name? ");process.stdin.setEncoding("utf8");process.stdin.on("data", s => process.stdout.write("Hello " + s));process.stdin.on("end", () => console.log("EOF"));';
  const run = await processes.start({ command: 'node -e $', snippet, directory: tmpdir(), owner: 'input' });
  const waiting = await until(() => processes.get(run.id), v => v.output.includes('Name? '));
  assert.equal(waiting.state, 'running');
  processes.input(run.id, 'Ada\n');
  await until(() => processes.get(run.id), v => v.output.includes('Hello Ada'));
  processes.input(run.id, 'Lin\n');
  await until(() => processes.get(run.id), v => v.output.includes('Hello Lin'));
  processes.input(run.id, '', true);
  const finished = await until(() => processes.get(run.id), v => v.state !== 'running');
  assert.equal(finished.state, 'finished'); assert.match(finished.output, /EOF/); assert.equal(finished.inputOpen, false);
  assert.throws(() => processes.input(run.id, 'late'), /not accepting/);
});
test('a stuck process is forcibly stopped and duplicate starts are rejected atomically', async t => {
  const processes = new Processes(); t.after(() => processes.close());
  const request = { command: 'node -e $', snippet: 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)', directory: tmpdir(), owner: 'stuck' };
  const starts = await Promise.allSettled([processes.start(request), processes.start(request)]);
  assert.equal(starts.filter(r => r.status === 'fulfilled').length, 1);
  const run = (starts.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<RunSnapshot>).value;
  await until(() => processes.get(run.id), v => v.output.includes('ready'));
  processes.stop(run.id);
  const finished = await until(() => processes.get(run.id), v => v.state === 'stopped');
  assert.equal(finished.signal, 'SIGKILL');
});
test('Stop terminates descendants even when the parent exits first', async t => {
  const processes = new Processes();
  let descendant = 0;
  t.after(async () => {
    await processes.close();
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
  });
  const childCode = 'process.on("SIGTERM",()=>{});console.log("descendant:"+process.pid);setInterval(()=>{},1000)';
  const snippet = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"inherit"});setInterval(()=>{},1000)`;
  const run = await processes.start({ command: 'node -e $', snippet, directory: tmpdir(), owner: 'descendants' });
  const ready = await until(() => processes.get(run.id), value => /descendant:\d+/.test(value.output));
  descendant = Number(ready.output.match(/descendant:(\d+)/)![1]);
  processes.stop(run.id);
  await until(() => processes.get(run.id), value => value.state === 'stopped');
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  descendant = 0;
});
test('output is bounded and clients can resume after truncation or reconnect by owner', async t => {
  const processes = new Processes(); t.after(() => processes.close());
  const run = await processes.start({ command: 'node -e $', snippet: 'process.stdout.write("x".repeat(400000));', directory: tmpdir(), owner: 'large' });
  const finished = await until(() => processes.get(run.id), v => v.state !== 'running');
  assert.equal(finished.output.length, 200000); assert.equal(finished.offset, 400000); assert.equal(finished.reset, true);
  assert.equal(processes.get(run.id, 399999).output, 'x');
  assert.equal(processes.latest('large')!.id, run.id);
});
test('HTTP helper rejects missing credentials, foreign origins, and foreign hosts', async t => {
  const token = 'test-token-'.repeat(4); const helper = createHelper(token);
  await new Promise<void>(resolve => helper.server.listen(0, '127.0.0.1', resolve)); t.after(() => helper.close());
  const port = (helper.server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(url + '/health')).status, 401);
  assert.equal((await fetch(url + '/health', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' } })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(url + '/health', { headers: { Authorization: `Bearer ${token}`, Host: 'example.com' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(foreignHostStatus, 403);
  const headers = { Authorization: `Bearer ${token}`, Origin: 'lsp://logseq.com', 'Content-Type': 'application/json' };
  const response = await fetch(url + '/runs', { method: 'POST', headers, body: JSON.stringify({ command: 'node -e $', snippet: 'console.log("HTTP works")', directory: tmpdir(), owner: 'http' }) });
  assert.equal(response.status, 201); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'lsp://logseq.com');
  const run = await response.json() as RunSnapshot;
  const finished = await until(() => helper.processes.get(run.id), v => v.state !== 'running');
  assert.match(finished.output, /HTTP works/);
});
