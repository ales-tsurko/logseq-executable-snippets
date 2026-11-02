declare const logseq: any;
import { Client, busy, type RunState } from './client';
import { normalizeTemplates, runtimeFor, type RuntimeTemplate } from './templates';
import { showSettings, type Options } from './settings';
import { ManagedRuntime } from './host-runtime';

const api: any = logseq;
const DIRECTORY = 'plugin.property.logseq-executable-snippets/directory';
const RUNNER = 'plugin.property.logseq-executable-snippets/runner';
let options: Options;
let host: Window & typeof globalThis;
let doc: Document;
let graphKey = '';
let disposed = false;
let scanTimer: ReturnType<typeof setTimeout> | undefined;
const subscriptions: Array<() => void> = [];
const mounted = new Map<HTMLElement, { uuid: string; language: string; remove: () => void }>();
const checked = new WeakMap<HTMLElement, string>();
let managed: ManagedRuntime;
const client = new Client(() => managed.ensure());
const uuidPattern = /^[a-f0-9-]{36}$/i;
const errorText = (error: unknown) => error && typeof error === 'object' ? ('message' in error ? String(error.message) : JSON.stringify(error)) : String(error);
const report = (error: unknown) => { console.error('[Executable Snippets]', error); void api.UI.showMsg(errorText(error), 'error'); };
function readOptions(settings: any): Options {
  return { runtimes: normalizeTemplates(settings?.runtimes), defaultDirectory: String(settings?.defaultDirectory || '~') };
}
async function currentGraphKey() {
  const graph = await api.App.getCurrentGraph();
  return String(graph?.url || graph?.path || graph?.name || '');
}
async function properties(uuid: string) {
  const values = await Promise.all([RUNNER, DIRECTORY].map(key => api.Editor.getBlockProperty(uuid, key)));
  return Object.fromEntries([RUNNER, DIRECTORY].map((key, i) => {
    const value = values[i];
    return [key, typeof value === 'string' ? value : value?.value ?? value?.['block/value'] ?? value?.title ?? ''];
  }));
}
async function ensureProperty(key: string) {
  if (await api.Editor.getProperty(key)) return;
  const shortName = key.split('/').at(-1)!;
  await api.Editor.upsertProperty(shortName, { type: 'default', cardinality: 'one' });
}
function propertyValue(props: Record<string, any>, key: string): string {
  const value = props[key] ?? props[':' + key];
  return typeof value === 'string' ? value : '';
}
async function directoryFor(uuid: string, initial: Record<string, any>): Promise<string> {
  let own = propertyValue(initial, DIRECTORY);
  if (own) return own;
  let block = await api.Editor.getBlock(uuid);
  const visited = new Set<string>([uuid]);
  for (let depth = 0; depth < 64; depth++) {
    const parent = block?.parent?.id || block?.parent?.uuid || block?.page?.id || block?.page?.uuid;
    if (!parent || visited.has(String(parent))) break;
    visited.add(String(parent));
    block = await api.Editor.getBlock(parent);
    if (!block) break;
    own = propertyValue(await properties(String(block.uuid || block['block/uuid'])), DIRECTORY);
    if (own) return own;
  }
  return options.defaultDirectory;
}
function scheduleScan(reset = false) {
  if (disposed) return;
  if (reset) {
    for (const [wrap, instance] of mounted) { instance.remove(); mounted.delete(wrap); checked.delete(wrap); }
    for (const wrap of doc.querySelectorAll<HTMLElement>('.ls-code-editor-wrap')) checked.delete(wrap);
  }
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void scan().catch(report), 120);
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const el = doc.createElement(tag); el.textContent = text; if (className) el.className = className; return el;
}
function attach(wrap: HTMLElement, uuid: string, language: string) {
  const ownerGraph = graphKey;
  const owner = `${ownerGraph}:${uuid}`;
  const panel = node('section', '', 'logseq-executable-snippets');
  panel.setAttribute('aria-label', 'Snippet process controls');
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown']) panel.addEventListener(type, event => event.stopPropagation());
  const actions = node('div', '', 'snippet-actions');
  const run = node('button', 'Run'); const stop = node('button', 'Stop');
  const configure = node('button', 'Configure'); const clear = node('button', 'Clear output');
  const status = node('span', '', 'snippet-status'); status.setAttribute('role', 'status');
  for (const button of [run, stop, configure, clear]) button.type = 'button';
  actions.append(run, stop, configure, clear, status);
  const output = node('pre', '', 'snippet-output'); output.tabIndex = 0; output.setAttribute('aria-label', 'Process output');
  const error = node('div', '', 'snippet-error'); error.setAttribute('role', 'alert');
  const inputRow = node('form', '', 'snippet-input');
  const input = node('input'); input.type = 'text'; input.placeholder = 'Input…'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', 'Process input');
  const send = node('button', 'Send'); send.type = 'submit';
  const eof = node('button', 'End input'); eof.type = 'button';
  inputRow.append(input, send, eof); panel.append(actions, output, error, inputRow); wrap.append(panel);
  let latest: RunState;
  const unwatch = client.watch(owner, state => {
    latest = state;
    const following = output.scrollHeight - output.scrollTop - output.clientHeight < 32;
    output.hidden = !state.output; error.hidden = !state.error;
    output.textContent = state.output; error.textContent = state.error || '';
    if (following) output.scrollTop = output.scrollHeight;
    run.disabled = busy(state); stop.hidden = !busy(state); stop.disabled = state.state === 'starting' || state.state === 'stopping';
    clear.hidden = !state.output && !state.error; clear.disabled = busy(state);
    inputRow.hidden = !['running', 'stopping'].includes(state.state);
    input.disabled = send.disabled = eof.disabled = state.state !== 'running' || !state.inputOpen;
    status.textContent = state.state === 'idle' ? '' : state.state === 'finished' ? 'Finished · exit 0'
      : state.state === 'failed' ? `Failed${state.exitCode === null ? '' : ` · exit ${state.exitCode}`}`
      : state.state === 'stopped' ? 'Stopped' : state.state === 'starting' ? 'Starting…' : state.state === 'stopping' ? 'Stopping…' : state.inputOpen ? 'Running' : 'Running · input closed';
  });
  const failedAction = (failure: unknown) => { error.hidden = false; error.textContent = errorText(failure); };
  run.onclick = () => {
    run.disabled = true;
    void (async () => {
      if (await currentGraphKey() !== ownerGraph) throw new Error('The graph changed. Reopen this snippet before running it.');
      const props = await properties(uuid);
      const selected = propertyValue(props, RUNNER);
      const runtime = runtimeFor(options.runtimes, language, selected);
      if (!runtime) throw new Error('Choose an enabled command in snippet configuration.');
      const cm = (wrap.querySelector('.CodeMirror') as any)?.CodeMirror;
      const block = cm ? null : await api.Editor.getBlock(uuid);
      const code = cm?.getValue() ?? block?.title ?? block?.content ?? block?.['block/title'];
      if (typeof code !== 'string') throw new Error('The code editor is still loading.');
      const directory = await directoryFor(uuid, props);
      if (await currentGraphKey() !== ownerGraph) throw new Error('The graph changed before execution.');
      await client.start(owner, { command: runtime.command, snippet: code, directory, owner });
    })().catch(failedAction).finally(() => { run.disabled = busy(client.get(owner)); });
  };
  stop.onclick = () => { void client.stop(owner).catch(failedAction); };
  configure.onclick = () => { void configureSnippet(uuid).catch(report); };
  clear.onclick = () => client.clear(owner);
  inputRow.onsubmit = event => { event.preventDefault(); const value = input.value; void client.input(owner, value + '\n').then(() => { input.value = ''; input.focus(); }).catch(failedAction); };
  eof.onclick = () => { void client.input(owner, '', true).catch(failedAction); };
  input.onkeydown = event => {
    if (event.ctrlKey && event.key.toLowerCase() === 'd') { event.preventDefault(); void client.input(owner, '', true).catch(failedAction); }
    if (event.ctrlKey && event.key.toLowerCase() === 'c' && busy(latest)) { event.preventDefault(); void client.stop(owner).catch(failedAction); }
  };
  mounted.set(wrap, { uuid, language, remove: () => { unwatch(); panel.remove(); } });
}
async function scan() {
  if (disposed || !graphKey) return;
  for (const [wrap, instance] of mounted) if (!wrap.isConnected) { instance.remove(); mounted.delete(wrap); }
  for (const wrap of doc.querySelectorAll<HTMLElement>('.ls-code-editor-wrap')) {
    const picker = wrap.querySelector<HTMLElement>('.select-language[blockid]');
    const uuid = picker?.getAttribute('blockid') || '';
    if (!uuidPattern.test(uuid)) continue;
    const language = picker!.textContent?.trim().toLowerCase() || '';
    const marker = `${graphKey}:${uuid}:${language}`;
    if (checked.get(wrap) === marker) continue;
    checked.set(wrap, marker);
    mounted.get(wrap)?.remove(); mounted.delete(wrap);
    let selected = '';
    try { selected = propertyValue(await properties(uuid), RUNNER); } catch { checked.delete(wrap); continue; }
    if (disposed || checked.get(wrap) !== marker || !wrap.isConnected) continue;
    if (runtimeFor(options.runtimes, language, selected)) attach(wrap, uuid, language);
  }
}
async function theme() {
  const colors = await api.UI.resolveThemeCssPropsVals(['--ls-primary-background-color', '--ls-secondary-background-color', '--ls-primary-text-color', '--ls-secondary-text-color', '--ls-border-color', '--ls-quaternary-background-color', '--ls-link-text-color']) || {};
  for (const [key, value] of Object.entries(colors)) if (typeof value === 'string') document.documentElement.style.setProperty(key, value);
}
async function settings() {
  await theme();
  showSettings(api, options, next => { api.updateSettings(next); options = readOptions(next); scheduleScan(true); },
    () => managed.ensure(), () => managed.enable());
}
async function configureSnippet(uuid: string) {
  await theme();
  const props = await properties(uuid);
  const app = document.getElementById('app')!;
  const header = document.createElement('header'); const title = document.createElement('h2'); title.textContent = 'Snippet configuration';
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', 'Close'); close.onclick = () => api.hideMainUI(); header.append(title, close);
  const section = document.createElement('section');
  const select = document.createElement('select'); select.id = 'snippet-runner'; select.setAttribute('aria-label', 'Snippet command');
  const automatic = document.createElement('option'); automatic.value = ''; automatic.textContent = 'From code language'; select.append(automatic);
  for (const runtime of options.runtimes.filter(t => t.enabled)) { const option = document.createElement('option'); option.value = runtime.id; option.textContent = runtime.name; select.append(option); }
  select.value = propertyValue(props, RUNNER);
  const directory = document.createElement('input'); directory.id = 'snippet-directory'; directory.placeholder = 'Inherit from parent or default'; directory.value = propertyValue(props, DIRECTORY); directory.setAttribute('aria-label', 'Snippet directory');
  for (const [label, field] of [['Command', select], ['Working directory', directory]] as const) {
    const row = document.createElement('div'); row.className = 'row'; const name = document.createElement('label'); name.htmlFor = field.id; name.textContent = label; row.append(name, field); section.append(row);
  }
  const footer = document.createElement('footer'); const status = document.createElement('span'); status.id = 'status';
  const save = document.createElement('button'); save.textContent = 'Apply'; save.className = 'primary';
  save.onclick = () => { save.disabled = true; void (async () => {
    for (const [key, value] of [[RUNNER, select.value], [DIRECTORY, directory.value.trim()]] as const) {
      if (value) { await ensureProperty(key); await api.Editor.upsertBlockProperty(uuid, key, value); }
      else if (propertyValue(props, key)) await api.Editor.removeBlockProperty(uuid, key);
    }
    scheduleScan(true); api.hideMainUI();
  })().catch(error => { status.textContent = errorText(error); }).finally(() => { save.disabled = false; }); };
  footer.append(status, save); app.replaceChildren(header, section, footer); api.showMainUI({ autoFocus: true });
}
async function main() {
  if (!(await api.App.checkCurrentIsDbGraph())) throw new Error('Executable Snippets currently supports Logseq DB graphs.');
  host = api.Experiments.ensureHostScope(); doc = host.document;
  options = readOptions(api.settings); graphKey = await currentGraphKey();
  managed = new ManagedRuntime(api, host);
  void managed.ensure().catch(report);
  api.setMainUIInlineStyle({ position: 'fixed', inset: '0', zIndex: 1000, backgroundColor: 'rgba(0,0,0,.25)' });
  api.provideModel({ openSettings: () => void settings().catch(report) });
  api.useSettingsSchema([
    { key: 'configure', type: 'button', default: null, title: 'Executable Snippets', description: 'Commands and automatic startup.', buttonText: 'Open snippet settings', buttonAction: 'openSettings' },
  ]);
  api.App.registerCommandPalette({ key: 'settings', label: 'Executable Snippets: Settings' }, () => void settings().catch(report));
  api.App.registerCommandPalette({ key: 'stop-all', label: 'Executable Snippets: Stop all processes' }, () => { void client.request('/stop-all', 'POST', {}).catch(report); });
  api.Editor.registerBlockContextMenuItem('Configure executable snippet', ({ uuid }: { uuid: string }) => void configureSnippet(uuid).catch(report));
  api.provideStyle({ key: 'snippet-controls', style: `
    .logseq-executable-snippets { padding: 6px 0 2px; font: 12px/1.45 var(--ls-font-family,system-ui,sans-serif); color: var(--ls-primary-text-color); }
    .logseq-executable-snippets [hidden] { display:none !important; }
    .logseq-executable-snippets .snippet-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .logseq-executable-snippets button { font:inherit; color:inherit; background:var(--ls-secondary-background-color); border:1px solid var(--ls-border-color,hsl(var(--border))); border-radius:4px; padding:2px 8px; cursor:pointer; }
    .logseq-executable-snippets button:hover { background:var(--ls-quaternary-background-color); }
    .logseq-executable-snippets button:disabled { opacity:.45; cursor:default; }
    .logseq-executable-snippets .snippet-status { margin-left:4px; color:var(--ls-secondary-text-color); }
    .logseq-executable-snippets .snippet-output { margin:8px 0 0; padding:8px 10px; max-height:280px; min-height:0; overflow:auto; font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--ls-secondary-background-color); color:var(--ls-primary-text-color); border-radius:4px; user-select:text; }
    .logseq-executable-snippets .snippet-error { margin:6px 0; color:var(--ls-error-text-color,var(--ls-primary-text-color)); white-space:pre-wrap; }
    .logseq-executable-snippets .snippet-input { display:flex; gap:6px; margin-top:7px; }
    .logseq-executable-snippets input { min-width:0; flex:1; padding:3px 7px; border:1px solid var(--ls-border-color,hsl(var(--border))); border-radius:4px; background:var(--ls-primary-background-color); color:var(--ls-primary-text-color); font:12px/1.5 ui-monospace,monospace; }
  ` });
  const observer = new MutationObserver(records => {
    if (records.some(record => !(record.target instanceof host.Element) || !(record.target as Element).closest('.logseq-executable-snippets'))) scheduleScan();
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  subscriptions.push(() => observer.disconnect());
  subscriptions.push(api.App.onCurrentGraphChanged(() => { void currentGraphKey().then(key => { graphKey = key; scheduleScan(true); }).catch(report); }));
  subscriptions.push(api.App.onRouteChanged(() => scheduleScan()));
  subscriptions.push(api.onSettingsChanged((value: any) => { try { options = readOptions(value); scheduleScan(true); } catch (error) { report(error); } }));
  subscriptions.push(api.DB.onChanged((event: any) => { if (event.txData?.some((row: any[]) => String(row[1]).includes('plugin.property.logseq-executable-snippets/'))) scheduleScan(true); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); api.hideMainUI(); } });
  const stop = () => { void managed.stop(); };
  host.addEventListener('pagehide', stop);
  subscriptions.push(() => host.removeEventListener('pagehide', stop));
  api.beforeunload(async () => { disposed = true; clearTimeout(scanTimer); subscriptions.forEach(off => off?.()); for (const instance of mounted.values()) instance.remove(); mounted.clear(); client.close(); await managed.stop(); });
  scheduleScan();
}
api.ready(main).catch(report);
