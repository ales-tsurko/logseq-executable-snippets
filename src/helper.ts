import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHelper } from './server';

const directory = join(homedir(), '.config', 'logseq-executable-snippets');
const connectionFile = join(directory, 'connection.json');
async function connection() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return JSON.parse(await readFile(connectionFile, 'utf8')) as { token: string; port: number }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = { token: randomBytes(32).toString('base64url'), port: 19848 };
    await writeFile(connectionFile, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); return value;
  }
}
async function main() {
  if (process.platform === 'win32') throw new Error('This version supports macOS and Linux.');
  const config = await connection();
  const endpoint = `http://127.0.0.1:${config.port}`;
  const headers = { Authorization: `Bearer ${config.token}` };
  const healthy = async () => { try { const r = await fetch(endpoint + '/health', { headers, signal: AbortSignal.timeout(500) }); return r.ok && (await r.json()).name === 'logseq-executable-snippets'; } catch { return false; } };
  if (process.argv[2] === 'setup') {
    const settingsFile = join(homedir(), '.logseq', 'settings', 'logseq-executable-snippets.json');
    await mkdir(dirname(settingsFile), { recursive: true });
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(settingsFile, JSON.stringify({ ...settings, helperUrl: endpoint, helperToken: config.token }, null, 2) + '\n', { mode: 0o600 });
    if (!(await healthy())) {
      const log = await open(join(directory, 'helper.log'), 'a', 0o600);
      const child = spawn(process.execPath, [process.argv[1]!, 'start'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
      child.unref(); await log.close();
      for (let i = 0; i < 30 && !(await healthy()); i++) await delay(150);
    }
    if (!(await healthy())) throw new Error('The helper did not start. Run npm run helper to see the error.');
    console.log('Local helper connected. Load this directory as an unpacked Logseq plugin.');
  } else if (process.argv[2] === 'stop') {
    const response = await fetch(endpoint + '/shutdown', { method: 'POST', headers, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Could not stop the helper.');
    console.log('Local helper stopped.');
  } else {
    const helper = createHelper(config.token);
    helper.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    helper.server.listen(config.port, '127.0.0.1', () => console.log(`Executable Snippets helper listening at ${endpoint}`));
    const close = () => { void helper.close().then(() => process.exit(0)); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
