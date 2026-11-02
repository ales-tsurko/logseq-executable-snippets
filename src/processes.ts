import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { commandArguments } from './templates';

export interface RunRequest { command: string; snippet: string; directory: string; owner: string }
export interface RunSnapshot {
  id: string; state: 'running' | 'stopping' | 'stopped' | 'finished' | 'failed';
  output: string; offset: number; reset: boolean; inputOpen: boolean;
  exitCode: number | null; signal: string | null; error: string | null;
}
interface Job { child: ChildProcessWithoutNullStreams; owner: string; output: string; base: number; snapshot: Omit<RunSnapshot, 'output' | 'offset' | 'reset'> }
export class Processes {
  private closed = false;
  readonly jobs = new Map<string, Job>();
  readonly maxOutput = 200_000;
  async start(request: RunRequest): Promise<RunSnapshot> {
    if (typeof request.snippet !== 'string' || request.snippet.length > 100_000) throw new Error('Snippets must be strings under 100,000 characters.');
    if (typeof request.command !== 'string' || request.command.length > 4096) throw new Error('Invalid command template.');
    if (typeof request.owner !== 'string' || !request.owner || request.owner.length > 2048) throw new Error('Invalid snippet identity.');
    const expandHome = (s: string) => s === '~' ? homedir() : s.startsWith('~/') ? resolve(homedir(), s.slice(2)) : s;
    const directory = resolve(expandHome(String(request.directory || '~')));
    if (!(await stat(directory)).isDirectory()) throw new Error('The working directory is not a directory.');
    if (this.closed) throw new Error('The helper is shutting down.');
    if ([...this.jobs.values()].filter(j => ['running', 'stopping'].includes(j.snapshot.state)).length >= 8) throw new Error('Eight snippets are already running. Stop one before starting another.');
    if ([...this.jobs.values()].some(j => j.owner === request.owner && ['running', 'stopping'].includes(j.snapshot.state))) throw new Error('This snippet is already running.');
    let [program, args] = commandArguments(request.command, request.snippet);
    program = expandHome(program);
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', NO_COLOR: '1', PYTHONUNBUFFERED: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    if (process.versions.electron && ['node', 'nodejs'].includes(program)) {
      program = process.execPath; env.ELECTRON_RUN_AS_NODE = '1';
    }
    const child = spawn(program, args, { cwd: directory, detached: true, shell: false,
      env, stdio: ['pipe', 'pipe', 'pipe'] });
    const id = randomUUID();
    const job: Job = { child, owner: request.owner, output: '', base: 0, snapshot: { id, state: 'running', inputOpen: true, exitCode: null, signal: null, error: null } };
    this.jobs.set(id, job);
    const output = (chunk: string) => {
      job.output += stripVTControlCharacters(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (job.output.length > this.maxOutput) { const excess = job.output.length - this.maxOutput; job.base += excess; job.output = job.output.slice(excess); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.stdin.on('error', () => { job.snapshot.inputOpen = false; });
    child.on('error', error => { job.snapshot.state = 'failed'; job.snapshot.error = `Cannot start ${program}: ${error.message}`; job.snapshot.inputOpen = false; });
    child.on('close', (code, signal) => {
      job.snapshot.state = job.snapshot.state === 'failed' ? 'failed' : job.snapshot.state === 'stopping' ? 'stopped' : code === 0 ? 'finished' : 'failed';
      job.snapshot.exitCode = code; job.snapshot.signal = signal; job.snapshot.inputOpen = false;
    });
    for (const [key, value] of this.jobs) if (this.jobs.size > 64 && !['running', 'stopping'].includes(value.snapshot.state)) this.jobs.delete(key);
    return this.get(id);
  }
  get(id: string, offset = 0): RunSnapshot {
    const job = this.jobs.get(id);
    if (!job) throw new Error('This process no longer exists.');
    const reset = offset < job.base;
    return { ...job.snapshot, output: job.output.slice(Math.max(0, offset - job.base)), offset: job.base + job.output.length, reset };
  }
  latest(owner: string): RunSnapshot | null {
    const job = [...this.jobs.values()].reverse().find(j => j.owner === owner);
    return job ? this.get(job.snapshot.id) : null;
  }
  input(id: string, text: string, end = false) {
    const job = this.jobs.get(id);
    if (!job || job.snapshot.state !== 'running' || !job.snapshot.inputOpen) throw new Error('This process is not accepting input.');
    if (typeof text !== 'string' || text.length > 100_000) throw new Error('Invalid input.');
    if (end) { job.snapshot.inputOpen = false; job.child.stdin.end(text); }
    else job.child.stdin.write(text);
  }
  stop(id: string) {
    const job = this.jobs.get(id);
    if (!job || !['running', 'stopping'].includes(job.snapshot.state)) return;
    if (job.snapshot.state === 'stopping') return;
    job.snapshot.state = 'stopping'; job.snapshot.inputOpen = false;
    const kill = (signal: NodeJS.Signals) => { try { if (job.child.pid) process.kill(-job.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    kill('SIGTERM');
    setTimeout(() => kill('SIGKILL'), 1000).unref();
  }
  async close() {
    this.closed = true;
    for (const id of this.jobs.keys()) this.stop(id);
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
}
