import { DEFAULT_TEMPLATES, normalizeTemplates, type RuntimeTemplate } from './templates';
import type { Connection } from './client';
export interface Options extends Connection { runtimes: RuntimeTemplate[]; defaultDirectory: string }
export function showSettings(api: any, value: Options, save: (value: Options) => void, test: (connection: Connection) => Promise<unknown>) {
  const app = document.getElementById('app')!;
  const draft = structuredClone(value);
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  function draw() {
    app.innerHTML = `<header><h2>Executable Snippets</h2><button id="close" aria-label="Close">×</button></header>
      <section><div class="row"><label for="directory">Default directory</label><input id="directory" value="${esc(draft.defaultDirectory)}" placeholder="~"></div>
      <details><summary>Helper connection</summary><div class="row"><label for="helper-url">Address</label><input id="helper-url" value="${esc(draft.helperUrl)}"></div>
      <div class="row"><label for="helper-token">Connection token</label><input type="password" autocomplete="off" id="helper-token" value="${esc(draft.helperToken)}"></div></details>
      <div class="heading"><h3>Commands</h3><span>Use $ once for the snippet.</span><button id="add">Add command</button></div>
      <div class="table-scroll"><table><thead><tr><th>On</th><th>Name</th><th>Code languages</th><th>Command</th><th></th></tr></thead><tbody>
      ${draft.runtimes.map((r, i) => `<tr><td><input type="checkbox" data-field="enabled" data-row="${i}" aria-label="Enable ${esc(r.name)}" ${r.enabled ? 'checked' : ''}></td>
      <td><input data-field="name" data-row="${i}" aria-label="Command name" value="${esc(r.name)}"></td>
      <td><input data-field="languages" data-row="${i}" aria-label="Code languages" value="${esc(r.languages.join(', '))}"></td>
      <td><input data-field="command" data-row="${i}" aria-label="Command template" value="${esc(r.command)}" spellcheck="false"></td>
      <td><button data-remove="${i}" aria-label="Remove ${esc(r.name)}">×</button></td></tr>`).join('')}
      </tbody></table></div><button id="reset" class="secondary">Restore defaults</button></section>
      <footer><span id="status"></span><button id="test">Test connection</button><button id="save" class="primary">Apply settings</button></footer>`;
    document.getElementById('close')!.onclick = () => api.hideMainUI();
    input('directory').oninput = () => { draft.defaultDirectory = input('directory').value; };
    input('helper-url').oninput = () => { draft.helperUrl = input('helper-url').value; };
    input('helper-token').oninput = () => { draft.helperToken = input('helper-token').value; };
    for (const el of app.querySelectorAll<HTMLInputElement>('[data-field]')) el.onchange = () => {
      const row = draft.runtimes[Number(el.dataset.row)]!;
      switch (el.dataset.field) {
        case 'enabled': row.enabled = el.checked; break;
        case 'name': row.name = el.value; break;
        case 'languages': row.languages = el.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean); break;
        case 'command': row.command = el.value; break;
      }
    };
    for (const el of app.querySelectorAll<HTMLButtonElement>('[data-remove]')) el.onclick = () => { draft.runtimes.splice(Number(el.dataset.remove), 1); draw(); };
    document.getElementById('add')!.onclick = () => { draft.runtimes.push({ id: crypto.randomUUID(), name: 'New command', languages: [], command: 'repl -e $', enabled: true }); draw(); };
    document.getElementById('reset')!.onclick = () => { draft.runtimes = structuredClone(DEFAULT_TEMPLATES); draw(); };
    document.getElementById('save')!.onclick = () => {
      try { draft.runtimes = normalizeTemplates(draft.runtimes); save(draft); document.getElementById('status')!.textContent = 'Settings saved.'; }
      catch (error) { document.getElementById('status')!.textContent = (error as Error).message; }
    };
    document.getElementById('test')!.onclick = () => { void test(draft).then(() => { document.getElementById('status')!.textContent = 'Helper connected.'; }).catch(error => { document.getElementById('status')!.textContent = error.message; }); };
  }
  draw(); api.showMainUI({ autoFocus: true });
}
