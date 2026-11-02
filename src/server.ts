import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Processes } from './processes';

export function createHelper(token: string, processes = new Processes()) {
  if (token.length < 32) throw new Error('The helper requires a private connection token.');
  const server = createServer(async (request, response) => {
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    const address = server.address();
    const host = `127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
    if (request.headers.host !== host) { json(403, { error: 'Invalid host.' }); return; }
    const origin = request.headers.origin;
    if (origin && origin !== 'lsp://logseq.com' && origin !== 'null') { json(403, { error: 'Only the local Logseq plugin can connect.' }); return; }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const supplied = Buffer.from(String(request.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { json(401, { error: 'The helper connection token is missing or incorrect.' }); return; }
    try {
      const url = new URL(request.url || '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/health') { json(200, { name: 'logseq-executable-snippets', version: 1 }); return; }
      if (request.method === 'GET' && url.pathname === '/runs') { json(200, processes.latest(url.searchParams.get('owner') || '')); return; }
      if (request.method === 'POST' && url.pathname === '/runs') { json(201, await processes.start(await body(request))); return; }
      if (request.method === 'POST' && url.pathname === '/stop-all') { for (const id of processes.jobs.keys()) processes.stop(id); json(200, { ok: true }); return; }
      const match = /^\/runs\/([a-f0-9-]+)(?:\/(input|stop))?$/.exec(url.pathname);
      if (match && request.method === 'GET' && !match[2]) {
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid output cursor.');
        json(200, processes.get(match[1]!, offset)); return;
      }
      if (match && request.method === 'POST') {
        if (match[2] === 'stop') processes.stop(match[1]!);
        else if (match[2] === 'input') { const value = await body(request); processes.input(match[1]!, value.text, value.end === true); }
        else { json(404, { error: 'Unknown action.' }); return; }
        json(200, { ok: true }); return;
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        json(200, { ok: true }); void processes.close().then(() => { server.close(); server.closeAllConnections(); }); return;
      }
      json(404, { error: 'Unknown endpoint.' });
    } catch (error) { json(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return { server, processes, close: async () => { await processes.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function body(request: IncomingMessage): Promise<any> {
  if (!String(request.headers['content-type']).startsWith('application/json')) throw new Error('Expected JSON.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
