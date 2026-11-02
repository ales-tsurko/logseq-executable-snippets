import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Processes } from './processes';
import { Lease } from './lease';
import { HEARTBEAT_MS, LEASE_TIMEOUT_MS, PROTOCOL } from './protocol';

export function createHelper(token: string, processes = new Processes(), managed?: {
  session: string; instance: string; timeout?: number; pingInterval?: number; onClose?: () => void | Promise<void>;
}) {
  if (token.length < 32) throw new Error('The helper requires a private connection token.');
  const lease = managed ? new Lease(managed.timeout ?? LEASE_TIMEOUT_MS) : null;
  let leaseResponse: ServerResponse | undefined;
  let closing: Promise<void> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const close = () => closing ||= (async () => {
    clearInterval(monitor); leaseResponse?.end();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await processes.close(); await stopped; await managed?.onClose?.();
  })();
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
      if (closing) throw new Error('The helper is shutting down.');
      const url = new URL(request.url || '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/health') { json(200, { name: 'logseq-executable-snippets', version: PROTOCOL,
        session: managed?.session, instance: managed?.instance, pid: process.pid, node: process.versions.node }); return; }
      if (lease && request.method === 'GET' && url.pathname === '/lease') {
        const id = lease.connect(); leaseResponse?.end(); leaseResponse = response;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const ping = () => response.write(JSON.stringify({ lease: id }) + '\n');
        ping(); const timer = setInterval(ping, managed?.pingInterval ?? HEARTBEAT_MS);
        response.on('close', () => { clearInterval(timer); if (leaseResponse === response) leaseResponse = undefined; }); return;
      }
      if (lease && request.method === 'POST' && url.pathname === '/heartbeat') {
        const value = await body(request); lease.acknowledge(value.lease); json(200, { ok: true }); return;
      }
      if (lease && request.method === 'POST' && url.pathname === '/release') {
        const value = await body(request); lease.release(value.lease); json(200, { ok: true }); void close(); return;
      }
      if (request.method === 'GET' && url.pathname === '/runs') { json(200, processes.latest(url.searchParams.get('owner') || '')); return; }
      if (request.method === 'POST' && url.pathname === '/runs') {
        if (lease && (!lease.id || lease.check())) throw new Error('Connect the Logseq window before running a snippet.');
        json(201, await processes.start(await body(request))); return;
      }
      if (request.method === 'POST' && url.pathname === '/stop-all') { for (const id of processes.jobs.keys()) processes.stop(id); json(200, { ok: true }); return; }
      const match = /^\/runs\/([a-f0-9-]+)(?:\/(input|stop))?$/.exec(url.pathname);
      if (match && request.method === 'GET' && !match[2]) {
        if (!processes.jobs.has(match[1]!)) { json(404, { error: 'This process no longer exists.', code: 'RUN_NOT_FOUND' }); return; }
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
        json(200, { ok: true }); void close(); return;
      }
      json(404, { error: 'Unknown endpoint.' });
    } catch (error) { json(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  if (lease) monitor = setInterval(() => { if (lease.check()) void close(); }, Math.min(1000, managed?.timeout ?? LEASE_TIMEOUT_MS));
  return { server, processes, close };
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
