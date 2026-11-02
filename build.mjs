import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
await mkdir('dist', { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 10);
async function browserBundle(name, entry) {
  const result = await build({ entryPoints: [entry], outfile: `${name}.js`, bundle: true, minify: true, platform: 'browser', target: 'chrome120', write: false });
  const bytes = result.outputFiles[0].contents;
  const file = `${name}-${digest(bytes)}.js`;
  await writeFile(`dist/${file}`, bytes); return file;
}
const sdk = await browserBundle('sdk', require.resolve('@logseq/libs'));
const main = await browserBundle('main', 'src/main.ts');
await build({ entryPoints: ['src/helper.ts'], outfile: 'dist/helper.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs' });
const css = await readFile('src/settings.css'); const styles = `settings-${digest(css)}.css`;
await writeFile(`dist/${styles}`, css);
await writeFile('dist/index.html', `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${styles}"></head><body><div id="app"></div><script src="${sdk}"></script><script src="${main}"></script></body></html>`);
const current = new Set([sdk, main, styles]);
for (const file of await readdir('dist')) if (/^(main|sdk|settings)(?:-[a-f0-9]+)?\.(js|css)$/.test(file) && !current.has(file)) await unlink(`dist/${file}`);
