import { PROTOCOL, SUPPORTED_LOGSEQ_MINOR, TESTED_LOGSEQ, type RuntimeConnection } from './protocol';

export function shellQuote(value: string) {
  if (value.includes('\0') || /[\r\n]/.test(value)) throw new Error('Invalid launcher path.');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export class ManagedRuntime {
  private connection?: RuntimeConnection;
  private opening?: Promise<RuntimeConnection>;
  private controller?: AbortController;
  private lease = '';
  private closed = false;
  private warnedVersion = '';
  private native: any;
  private session: string;
  constructor(private api: any, private host: Window & typeof globalThis) {
    this.native = (host as any).apis;
    const key = 'logseq-executable-snippets/window';
    this.session = host.sessionStorage.getItem(key) || crypto.randomUUID();
    host.sessionStorage.setItem(key, this.session);
  }
  private action(command: string, ...args: unknown[]) {
    return this.native.doAction([command, ...args, 'js-obj']);
  }
  private async allowed(): Promise<string[]> {
    const config = await this.action('userAppCfgs', null, null);
    const allowed = config?.['commands-allowlist'] ?? [];
    if (!Array.isArray(allowed) || !allowed.every(value => typeof value === 'string')) throw new Error('Logseq returned an invalid command allowlist.');
    return allowed;
  }
  private async supported() {
    const info = await this.api.App.getInfo();
    const version = typeof info?.version === 'string' ? info.version : '';
    const match = /^(\d+\.\d+)\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.exec(version);
    if (match?.[1] !== SUPPORTED_LOGSEQ_MINOR) throw new Error(`Automatic startup supports Logseq ${SUPPORTED_LOGSEQ_MINOR}.x. Detected: ${version || 'unknown'}.`);
    if (typeof this.native?.doAction !== 'function' || typeof this.native?._callApplication !== 'function') throw new Error('Logseq’s desktop launcher is unavailable.');
    const platform = await this.action('getAppBaseInfo');
    if (!['darwin', 'linux'].includes(platform?.platform)) throw new Error('Automatic startup currently supports macOS and Linux.');
    if (!TESTED_LOGSEQ.includes(version) && this.warnedVersion !== version) {
      this.warnedVersion = version;
      void Promise.resolve(this.api.UI.showMsg(`Executable Snippets has not been tested with Logseq ${version}. Tested: ${TESTED_LOGSEQ.join(', ')}. Startup compatibility checks remain enabled.`, 'warning')).catch(console.warn);
    }
  }
  async enable() {
    await this.supported();
    const allowed = await this.allowed();
    await this.action('userAppCfgs', 'commands-allowlist', allowed.includes('env') ? allowed : [...allowed, 'env']);
    return this.ensure();
  }
  ensure(): Promise<RuntimeConnection> {
    if (this.closed) return Promise.reject(new Error('The snippet plugin has stopped.'));
    if (this.connection && this.lease) return Promise.resolve(this.connection);
    return this.opening ||= this.open().finally(() => { this.opening = undefined; });
  }
  private async open() {
    await this.supported();
    const allowed = await this.allowed();
    if (!allowed.includes('env')) throw new Error('Automatic startup needs permission. Open Executable Snippets: Settings and enable it.');
    const appPath = await this.native._callApplication('getAppPath');
    const platform = await this.action('getAppBaseInfo');
    const metrics = platform.platform === 'linux' ? await this.native._callApplication('getAppMetrics') : [];
    const browser = metrics.find((entry: any) => entry.type === 'Browser');
    const executable = platform.platform === 'darwin' && typeof appPath === 'string' && appPath.endsWith('/Contents/Resources/app.asar')
      ? appPath.slice(0, -'/Resources/app.asar'.length) + '/MacOS/Logseq'
      : platform.platform === 'linux' && Number.isSafeInteger(browser?.pid) ? `/proc/${browser.pid}/exe` : '';
    const userData = this.api.Experiments.pluginLocal.dotConfigRoot;
    const root = this.api.Experiments.pluginLocal.localRoot;
    if (![executable, userData, root].every(value => typeof value === 'string' && value.startsWith('/'))) throw new Error('Logseq returned invalid runtime paths.');
    const directory = userData + '/executable-snippets';
    const file = directory + '/' + this.session + '.json';
    const read = async () => {
      try {
        if (!(await this.action('stat', file))) return;
        const raw = await this.action('readFile', file);
        const value = JSON.parse(typeof raw === 'string' ? raw : raw.content);
        const url = new URL(value.helperUrl);
        if (value.protocol !== PROTOCOL || value.session !== this.session || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || typeof value.helperToken !== 'string' || value.helperToken.length < 32) return;
        const health = await this.fetch(value, '/health').then(r => r.json());
        if (health.version === PROTOCOL && health.session === this.session && health.instance === value.instance) return value as RuntimeConnection;
      } catch { /* A previous helper may have exited. */ }
    };
    let connection = await read();
    if (!connection) {
      const args = ['-u', 'NODE_OPTIONS', '-u', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE=1', executable, root + '/dist/helper.cjs', '--session', this.session, '--directory', directory];
      let launchError: unknown;
      void this.action('runCli', { command: 'env', args: args.map(shellQuote).join(' '), returnResult: false }).catch((error: unknown) => { launchError = error; });
      const deadline = Date.now() + 12_000;
      while (!this.closed && Date.now() < deadline) {
        if (launchError) throw launchError;
        await new Promise(resolve => setTimeout(resolve, 200));
        connection = await read(); if (connection) break;
      }
    }
    if (this.closed) throw new Error('The snippet plugin has stopped.');
    if (!connection) throw new Error('Logseq could not start its bundled helper. Check the command allowlist and runtime compatibility.');
    this.connection = connection;
    await this.listen(connection);
    return connection;
  }
  private fetch(connection: RuntimeConnection, path: string, data?: unknown, keepalive = false) {
    return fetch(connection.helperUrl + path, { method: data === undefined ? 'GET' : 'POST', keepalive,
      headers: { Authorization: `Bearer ${connection.helperToken}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: keepalive ? undefined : AbortSignal.timeout(3000) });
  }
  private async listen(connection: RuntimeConnection) {
    const controller = new AbortController(); this.controller?.abort(); this.controller = controller;
    const response = await fetch(connection.helperUrl + '/lease', { headers: { Authorization: `Bearer ${connection.helperToken}` }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Cannot establish the window heartbeat.');
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let pending = '';
    const consume = async (first = false): Promise<void> => {
      do {
        const next = await reader.read();
        if (next.done) throw new Error('The helper connection closed.');
        pending += decoder.decode(next.value, { stream: true });
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) {
          const message = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
          if (typeof message.lease !== 'string') throw new Error('Invalid helper heartbeat.');
          const acknowledged = await this.fetch(connection, '/heartbeat', { lease: message.lease });
          if (!acknowledged.ok) throw new Error('The helper heartbeat expired.');
          this.lease = message.lease;
          if (first) return;
        }
      } while (!this.closed);
    };
    await consume(true);
    void consume().catch(() => {
      if (this.controller === controller) { this.lease = ''; this.connection = undefined; }
      controller.abort();
    });
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    const connection = this.connection; const lease = this.lease;
    this.connection = undefined; this.lease = '';
    if (connection && lease) {
      try { await this.fetch(connection, '/release', { lease }, true); } catch { /* The helper also expires independently. */ }
    }
    this.controller?.abort();
  }
}
