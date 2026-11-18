// app.ts — the forge's HTTP server: one process, stdlib only. Routes:
//   GET  /healthz                     boot probe
//   POST /mcp                         Model Context Protocol (streamable HTTP)
//   POST /api/graphql                 GraphQL v4
//   /api/v3/*                         REST v3
//   /<owner>/<repo>.git/*             git smart HTTP
// Everything else is a JSON 404. Every API call (except /healthz and the
// API root) requires Authorization: Bearer $MAKEFUN_SHOP_TOKEN.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type Req } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function sendNoBody(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

/** Parse the request URL once; returns pathname + query params. */
function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { path: u.pathname, query: u.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns {ok} or {error} for a malformed body. */
function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
      const method = req.method ?? 'GET';
      const { path, query } = parseUrl(req);
      const host = req.headers.host ?? '127.0.0.1';

      try {
        // Boot probe: no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, baseHeaders);
          return;
        }

        // MCP endpoint.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendNoBody(res, 204, baseHeaders);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          const raw = await readBody(req);
          const outcome = handleMcp(store, raw.toString('utf8'));
          if (outcome.rpc === null) {
            sendNoBody(res, outcome.status, baseHeaders);
            return;
          }
          sendJson(res, outcome.status, outcome.rpc, baseHeaders);
          return;
        }

        // GraphQL endpoint.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw.toString('utf8'));
          if (!parsed.ok) {
            sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, baseHeaders);
            return;
          }
          const result = executeGraphQL(store, parsed.value);
          sendJson(res, 200, result, baseHeaders);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const isRoot = method === 'GET' && (path === '/api/v3' || path === '/api/v3/');
          if (!isRoot && !authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              const parsed = parseJsonBody(raw.toString('utf8'));
              if (!parsed.ok) {
                sendJson(res, 400, { message: 'Request body is not valid JSON' }, baseHeaders);
                return;
              }
              body = parsed.value;
            }
          }
          const restReq: Req = { method, path, query, body, host };
          const result = handleRest(store, restReq);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          if (result.status === 204) {
            sendNoBody(res, 204, { ...baseHeaders, ...(result.headers ?? {}) });
            return;
          }
          sendJson(res, result.status, result.body, { ...baseHeaders, ...(result.headers ?? {}) });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/<service>.
        const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
            return;
          }
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoDotGit = gitMatch[2] as string;
          if (!repoDotGit.endsWith('.git')) {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          const repoName = decodeURIComponent(repoDotGit.slice(0, -4));
          const service = gitMatch[3] as string;
          const repo = store.getRepo(owner, repoName);
          if (service === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
              return;
            }
            const q = query;
            const out = infoRefs(repo, q.get('service') ?? '', req.headers['git-protocol']);
            if (out.status === 200) sendRaw(res, 200, out.contentType, out.body, baseHeaders);
            else sendJson(res, out.status, JSON.parse(out.body.toString('utf8')), baseHeaders);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
            return;
          }
          const raw = await readBody(req);
          const out =
            service === 'git-upload-pack'
              ? uploadPack(store, repo, raw, req.headers['git-protocol'])
              : receivePack(store, repo, raw);
          if (out.status === 200) sendRaw(res, 200, out.contentType, out.body, baseHeaders);
          else sendJson(res, out.status, JSON.parse(out.body.toString('utf8')), baseHeaders);
          return;
        }

        // Anything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      } catch (e) {
        // A handler must never take the server down: answer 500 JSON.
        try {
          process.stderr.write(`[forge] handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
          if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, baseHeaders);
          else res.end();
        } catch {
          // Nothing left to do.
        }
      }
    })();
  });
}
