import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MirrorStore } from './store.mjs';
import { HandoffStore } from './handoff.mjs';

export const name = 'codex-mirror';
export const inject = ['webServer', 'connection'];
const base = '/api/codex-mirror';

export function isLocal(req) {
  const address = req.socket?.remoteAddress ?? '';
  if (!(address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')) return false;
  if (req.headers?.['sec-fetch-site'] === 'cross-site' || req.headers?.forwarded || req.headers?.['x-forwarded-for']) return false;
  try {
    const authority = new URL(`http://${req.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(authority.hostname)) return false;
    return !req.headers.origin || new URL(req.headers.origin).host === authority.host;
  } catch { return false; }
}

function json(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'});
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function readJsonBody(req) {
  if (!String(req.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw Object.assign(Error('expected-json'), {status: 415});
  if (Number(req.headers?.['content-length'] ?? 0) > 200000) throw Object.assign(Error('body-too-large'), {status: 413});
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 200000) throw Object.assign(Error('body-too-large'), {status: 413});
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(Error('invalid-json'), {status: 400}); }
}

export function createHandler(store, handoffs, ready, html) {
  const scan = { phase: 'pending' };
  Promise.resolve(ready).then(() => { scan.phase = 'ready'; }, error => {
    scan.phase = 'failed'; scan.error = error; console.error('[codex-mirror] scan', error);
  });
  return async (req, res) => {
    if (!isLocal(req)) return json(res, 403, {error: 'local-only'});
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === `${base}/view`) {
        if (req.method !== 'GET') return json(res, 405, {error: 'read-only'});
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        return json(res, 200, await html(), 'text/html; charset=utf-8');
      }
      if (url.pathname === `${base}/sessions`) {
        if (req.method !== 'GET') return json(res, 405, {error: 'read-only'});
        // Answer during the first scan instead of holding the request for half a minute.
        return json(res, 200, {sessions: store.listSessions(), pollMs: 1000, readOnly: true,
          scan: scan.phase, scanned: store.files?.size ?? 0,
          ...(store.rootMissing ? {rootMissing: true, root: store.root} : {}),
          ...(scan.phase === 'failed' ? {error: 'scan-failed'} : {})});
      }
      await ready;
      if (url.pathname === `${base}/session`) {
        if (req.method !== 'GET') return json(res, 405, {error: 'read-only'});
        const session = store.getSession(url.searchParams.get('id'));
        return session ? json(res, 200, session) : json(res, 404, {error: 'session-not-found'});
      }
      if (url.pathname === `${base}/handoff`) {
        if (req.method === 'POST') {
          const input = await readJsonBody(req);
          if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, {error: 'invalid-input'});
          const result = await handoffs.save(input);
          return json(res, 200, {...result, mode: 'handoff-file', codexOriginalModified: false});
        }
        if (req.method === 'GET') {
          const result = await handoffs.latest(url.searchParams.get('codexSessionId'), url.searchParams.get('dshSessionId'));
          return result ? json(res, 200, result) : json(res, 404, {error: 'handoff-not-found'});
        }
        return json(res, 405, {error: 'method-not-allowed'});
      }
      return json(res, 404, {error: 'not-found'});
    } catch (error) {
      const status = error.status || (error instanceof TypeError || error instanceof RangeError ? 400 : 500);
      if (status >= 500) console.error('[codex-mirror]', error);
      return json(res, status, {error: status >= 500 ? 'mirror-unavailable' : error.message});
    }
  };
}

export function apply(ctx, config) {
  const configured = typeof config?.root === 'string' ? config.root.trim() : '';
  const root = configured ? configured.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), '.codex');
  ctx.effect(() => {
    const store = new MirrorStore({root, pollMs: 1000});
    const handoffs = new HandoffStore({root: join(homedir(), '.dsh', 'codex-mirror', 'handoffs')});
    store.on('error', error => console.error('[codex-mirror]', error));
    const ready = store.start();
    ready.catch(error => console.error('[codex-mirror] start', error));
    const handler = createHandler(store, handoffs, ready, () => readFile(new URL('./view.html', import.meta.url), 'utf8'));
    const authenticated = (req, res) => {
      const rejected = ctx.connection.requestRejection(req);
      if (rejected !== undefined) { res.writeHead(rejected); res.end(rejected === 401 ? 'unauthorized' : 'forbidden'); return; }
      return handler(req, res);
    };
    const paths = ['view', 'sessions', 'session', 'handoff'];
    const disposers = paths.map(part => ctx.webServer.register({kind: 'exact', path: `${base}/${part}`, handler: authenticated}));
    return () => { disposers.forEach(dispose => dispose()); void store.stop(); };
  }, 'codex-mirror: read-only mirror and explicit handoff files');
}
