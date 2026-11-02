import type { RunRequest, RunSnapshot } from './processes';
export interface Connection { helperUrl: string; helperToken: string }
export interface RunState extends Omit<RunSnapshot, 'state' | 'reset'> { state: RunSnapshot['state'] | 'idle' | 'starting' }
export const busy = (state: RunState) => ['starting', 'running', 'stopping'].includes(state.state);
const idle = (): RunState => ({ id: '', state: 'idle', output: '', offset: 0, inputOpen: false, exitCode: null, signal: null, error: null });
export class Client {
  private states = new Map<string, RunState>();
  private listeners = new Map<string, Set<(state: RunState) => void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(readonly connection: () => Connection) {}
  async request(path: string, method = 'GET', data?: unknown): Promise<any> {
    const connection = this.connection();
    const url = new URL(connection.helperUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Use the local helper address http://127.0.0.1:PORT.');
    if (!connection.helperToken) throw new Error('Connect the local helper first. Run npm run setup in the plugin directory.');
    let response: Response;
    try { response = await fetch(url.origin + path, { method, headers: { Authorization: `Bearer ${connection.helperToken}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(5000) }); }
    catch { throw new Error('Helper unavailable. Run npm run setup in the plugin directory.'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Helper returned ${response.status}.`);
    return result;
  }
  get(key: string) { return this.states.get(key) || idle(); }
  watch(key: string, listener: (state: RunState) => void) {
    const first = !this.states.has(key);
    if (first) this.states.set(key, idle());
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(listener); listener(this.get(key));
    if (first) void this.request('/runs?owner=' + encodeURIComponent(key)).then((snapshot: RunSnapshot | null) => {
      if (!snapshot || this.closed || this.get(key).state !== 'idle') return;
      this.merge(key, snapshot);
      if (busy(this.get(key))) void this.poll(key);
    }).catch(() => {});
    return () => { this.listeners.get(key)?.delete(listener); };
  }
  private notify(key: string) { for (const listener of this.listeners.get(key) || []) listener(this.get(key)); }
  private merge(key: string, snapshot: RunSnapshot) {
    const previous = this.get(key);
    const output = snapshot.reset ? snapshot.output : previous.output + snapshot.output;
    this.states.set(key, { ...snapshot, output: output.slice(-200_000) }); this.notify(key);
  }
  async start(key: string, request: RunRequest) {
    if (busy(this.get(key))) return;
    this.states.set(key, { ...idle(), state: 'starting' }); this.notify(key);
    try { this.merge(key, await this.request('/runs', 'POST', request)); await this.poll(key); }
    catch (error) { this.states.set(key, { ...this.get(key), state: 'failed', error: String((error as Error).message || error) }); this.notify(key); }
  }
  private async poll(key: string) {
    if (this.closed || !busy(this.get(key)) || !this.get(key).id) return;
    this.timers.delete(key);
    let interval = 250;
    try {
      const state = this.get(key);
      this.merge(key, await this.request(`/runs/${state.id}?offset=${state.offset}`));
    } catch (error) { this.get(key).error = `${(error as Error).message} The process may still be running.`; this.notify(key); interval = 2000; }
    if (busy(this.get(key)) && !this.closed) this.timers.set(key, setTimeout(() => void this.poll(key), interval));
  }
  async input(key: string, text: string, end = false) { await this.request(`/runs/${this.get(key).id}/input`, 'POST', { text, end }); }
  async stop(key: string) {
    await this.request(`/runs/${this.get(key).id}/stop`, 'POST', {});
    this.get(key).state = 'stopping'; this.notify(key);
  }
  clear(key: string) {
    if (busy(this.get(key))) return;
    this.states.set(key, idle()); this.notify(key);
  }
  close() { this.closed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.listeners.clear(); }
}
