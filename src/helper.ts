import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, stat, unlink, rename, chmod } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHelper } from './server';
import { PROTOCOL, type RuntimeConnection } from './protocol';

const execute = promisify(execFile);
async function identity(pid: number) {
  try { return (await execute('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000 })).stdout.trim(); }
  catch { return ''; }
}
async function removeOwned(path: string, instance: string) {
  try { if (JSON.parse(await readFile(path, 'utf8')).instance === instance) await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function main() {
  if (process.platform === 'win32') throw new Error('This version supports macOS and Linux.');
  if (!process.versions.electron) throw new Error('Launch the helper through Logseq’s bundled runtime.');
  const args = process.argv.slice(2);
  const value = (key: string) => args[args.indexOf(key) + 1];
  const session = value('--session'); const directory = value('--directory');
  if (!args.includes('--session') || !/^[a-f0-9-]{36}$/i.test(session || '') || !args.includes('--directory') || !directory || !isAbsolute(directory)) throw new Error('Invalid helper launch arguments.');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const instance = randomUUID(); const start = await identity(process.pid);
  if (!start) throw new Error('Cannot establish the helper process identity.');
  const lock = join(directory, session + '.lock'); const connectionFile = join(directory, session + '.json');
  const candidate = lock + '.' + instance;
  await writeFile(candidate, JSON.stringify({ pid: process.pid, start, instance }), { flag: 'wx', mode: 0o600 });
  let acquired = false;
  try {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await link(candidate, lock);
      acquired = true; break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let old: { pid: number; start: string; instance: string } | undefined;
      try { old = JSON.parse(await readFile(lock, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; }
      if (!old || !Number.isInteger(old.pid) || old.pid <= 0 || !old.instance || !old.start) {
        // Recover a damaged old lock, while allowing an older launcher to finish writing.
        try {
          const before = await stat(lock);
          if (Date.now() - before.mtimeMs < 30_000) return;
          const current = await stat(lock);
          if (current.ino === before.ino && current.mtimeMs === before.mtimeMs) await unlink(lock);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        continue;
      }
      if (old.start && await identity(old.pid) === old.start) return;
      await removeOwned(lock, old.instance);
    }
  }
  } finally { await unlink(candidate); }
  if (!acquired) throw new Error('Cannot acquire the helper lock.');
  const token = randomBytes(32).toString('base64url');
  const cleanup = async () => { await removeOwned(connectionFile, instance); await removeOwned(lock, instance); };
  const helper = createHelper(token, undefined, { session, instance, onClose: cleanup });
  try {
    await new Promise<void>((resolve, reject) => { helper.server.once('error', reject); helper.server.listen(0, '127.0.0.1', resolve); });
    const port = (helper.server.address() as { port: number }).port;
    const connection: RuntimeConnection = { helperUrl: `http://127.0.0.1:${port}`, helperToken: token, protocol: PROTOCOL, session, instance, pid: process.pid };
    const temporary = connectionFile + '.' + instance;
    await writeFile(temporary, JSON.stringify(connection), { mode: 0o600 }); await rename(temporary, connectionFile);
    const stop = () => { void helper.close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { await helper.close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
