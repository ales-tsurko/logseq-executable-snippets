export interface RuntimeTemplate { id: string; name: string; languages: string[]; command: string; enabled: boolean }
export const DEFAULT_TEMPLATES: RuntimeTemplate[] = [
  ['shell', 'Shell', ['shell', 'sh'], '/bin/sh -c $'],
  ['bash', 'Bash', ['bash'], 'bash -c $'],
  ['zsh', 'Zsh', ['zsh'], 'zsh -c $'],
  ['fish', 'Fish', ['fish'], 'fish -c $'],
  ['python', 'Python', ['python', 'python3', 'py'], 'python3 -u -c $'],
  ['node', 'Node.js', ['javascript', 'js', 'node', 'nodejs'], 'node -e $'],
  ['lua', 'Lua', ['lua'], 'lua -e $'],
  ['ruby', 'Ruby', ['ruby', 'rb'], 'ruby -e $'],
  ['perl', 'Perl', ['perl', 'pl'], 'perl -e $'],
  ['php', 'PHP', ['php'], 'php -r $'],
  ['r', 'R', ['r', 'rscript'], 'Rscript -e $'],
  ['deno', 'Deno', ['deno', 'typescript', 'ts'], 'deno eval $'],
  ['bun', 'Bun', ['bun'], 'bun -e $'],
].map(([id, name, languages, command]) => ({ id, name, languages, command, enabled: true }) as RuntimeTemplate);

export function commandArguments(template: string, snippet: string): [string, string[]] {
  const words: string[] = [];
  let word = '', quote = '', active = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c === '\\' && quote !== "'") {
      if (i + 1 === template.length) throw new Error('The command ends with an incomplete escape.');
      word += template[++i]; active = true;
    } else if (quote) {
      if (c === quote) quote = ''; else word += c;
    } else if (c === '"' || c === "'") { quote = c; active = true;
    } else if (/\s/.test(c)) {
      if (active) { words.push(word); word = ''; active = false; }
    } else { word += c; active = true; }
  }
  if (quote) throw new Error('The command has an unclosed quote.');
  if (active) words.push(word);
  if (!words[0] || words[0] === '$') throw new Error('Start the template with an executable.');
  if (words.filter(w => w === '$').length !== 1) throw new Error('Use $ once as a separate argument for the snippet.');
  if (words.some(w => w.includes('\0')) || snippet.includes('\0')) throw new Error('NUL characters are not supported.');
  return [words[0], words.slice(1).map(w => w === '$' ? snippet : w)];
}
export function normalizeTemplates(value: unknown): RuntimeTemplate[] {
  if (!Array.isArray(value)) return structuredClone(DEFAULT_TEMPLATES);
  const seen = new Set<string>();
  return value.map((v, i) => {
    if (!v || typeof v !== 'object') throw new Error(`Invalid runtime on row ${i + 1}.`);
    const row = v as RuntimeTemplate;
    const id = String(row.id || '').trim();
    if (!id || seen.has(id)) throw new Error('Runtime IDs must be nonempty and unique.');
    seen.add(id);
    commandArguments(String(row.command || ''), '');
    const languages = (Array.isArray(row.languages) ? row.languages : []).map(l => String(l).trim().toLowerCase()).filter(Boolean);
    return { id, name: String(row.name || id), languages: [...new Set(languages)], command: row.command.trim(), enabled: row.enabled !== false };
  });
}
export function runtimeFor(templates: RuntimeTemplate[], language: string, override?: string): RuntimeTemplate | undefined {
  return override ? templates.find(t => t.enabled && t.id === override)
    : templates.find(t => t.enabled && t.languages.includes(language.toLowerCase().trim()));
}
