// main.ts — launcher for the forge entry.
//
// Boot sequence:
//   1. Pick up the environment endpoint from MAKEFUN_ENV_URL.
//   2. Start the forge HTTP server on a kernel-chosen port.
//   3. Tell the environment which port we took (POST /register).
//   4. Wait until the environment says the run is over (GET /done).
//   5. Shut the server down and exit.
//
// Only the Node standard library is used here, plus the server factory
// from ./app.ts. Nothing in this file talks to any model or external
// service besides the environment endpoint above.

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 1_000;
const LONGEST_RETRY_MS = 30_000;
const DONE_POLL_MS = 5_000;

/** Log a fatal problem and stop the process with a non-zero status. */
function die(message: string, cause?: unknown): never {
  console.error(`[launcher] fatal: ${message}`);
  if (cause !== undefined) {
    console.error(cause);
  }
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JsonReply {
  status: number;
  payload: unknown;
}

/**
 * One JSON request over plain HTTP or TLS, with a hard timeout.
 * The body is parsed when it looks like JSON; anything else (empty body,
 * plain text) comes back as a null payload instead of throwing.
 */
function jsonRequest(urlText: string, method: 'GET' | 'POST', body?: unknown): Promise<JsonReply> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const sender = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = sender(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers:
          data === undefined
            ? { accept: 'application/json' }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(data),
              },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let payload: unknown = null;
          if (text.length > 0) {
            try {
              payload = JSON.parse(text);
            } catch {
              payload = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, payload });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request ${method} ${urlText} exceeded ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (data !== undefined) {
      req.write(data);
    }
    req.end();
  });
}

/**
 * Run `step` until it succeeds, waiting longer between attempts each time
 * it fails (exponential backoff, capped). Callers that need an immediate
 * stop use die() directly instead of throwing.
 */
async function retryWithBackoff<T>(label: string, step: (attempt: number) => Promise<T>): Promise<T> {
  let delay = FIRST_RETRY_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await step(attempt);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[launcher] ${label} attempt ${attempt} failed (${detail}); retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, LONGEST_RETRY_MS);
    }
  }
}

/**
 * Announce our listening port to the environment. HTTP 200 means the
 * environment took the registration; 409 means another entry registered
 * first, which is also fine — we simply keep waiting for /done. 400/405
 * mean the environment refuses us, so stop immediately. Anything else
 * (network errors, other statuses) is retried with backoff.
 */
async function registerPort(envBase: string, port: number): Promise<void> {
  await retryWithBackoff('register', async () => {
    const { status } = await jsonRequest(`${envBase}/register`, 'POST', { port });
    if (status === 200 || status === 409) {
      console.error(`[launcher] registered port ${port} (HTTP ${status})`);
      return;
    }
    if (status === 400 || status === 405) {
      die(`environment rejected registration with HTTP ${status}`);
    }
    throw new Error(`registration answered HTTP ${status}`);
  });
}

/** Poll GET /done until the environment answers {"done": true}. */
async function waitUntilDone(envBase: string): Promise<void> {
  let delay = DONE_POLL_MS;
  for (;;) {
    let reply: JsonReply;
    try {
      reply = await jsonRequest(`${envBase}/done`, 'GET');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[launcher] done poll failed (${detail}); retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, LONGEST_RETRY_MS);
      continue;
    }
    delay = DONE_POLL_MS;
    const payload = reply.payload;
    if (payload !== null && typeof payload === 'object' && (payload as { done?: unknown }).done === true) {
      console.error('[launcher] environment reports done; shutting down');
      return;
    }
    await sleep(DONE_POLL_MS);
  }
}

async function boot(): Promise<void> {
  const rawEnv = process.env.MAKEFUN_ENV_URL ?? '';
  const envBase = rawEnv.replace(/\/+$/, '');
  if (envBase === '') {
    die('MAKEFUN_ENV_URL is not set; nothing to register with');
  }

  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server did not report a TCP address'));
        return;
      }
      resolve(addr.port);
    });
  }).catch((err: unknown) => die('failed to start the forge server', err));
  console.error(`[launcher] forge listening on port ${port}`);

  await registerPort(envBase, port);
  await waitUntilDone(envBase);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  console.error('[launcher] server closed; exiting');
}

boot().catch((err: unknown) => die('unexpected launcher failure', err));
