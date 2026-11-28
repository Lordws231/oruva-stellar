// HTTP server for the Oruva Intents Tester API.
//
// Serves the testnet sandbox API plus the developer dashboard and
// docs pages, so one public subdomain can host everything external
// developers need. Testnet only: the tester surface rejects live
// keys and moves no real funds.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTesterApi } from './testerApi.js';

const DEFAULT_DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../dashboard');
const MAX_BODY_BYTES = 65536;

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-api-key, idempotency-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  response.end(payload);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  response.end(html);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createTesterHttpServer({
  api = createTesterApi(),
  dashboardDir = DEFAULT_DASHBOARD_DIR,
} = {}) {
  async function servePage(response, fileName) {
    const html = await readFile(join(dashboardDir, fileName), 'utf8');
    sendHtml(response, html);
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = request.method ?? 'GET';

      if (method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
      }
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        await servePage(response, 'index.html');
        return;
      }
      if (method === 'GET' && path === '/docs.html') {
        await servePage(response, 'docs.html');
        return;
      }
      if (method === 'GET' && path === '/tester/v1/health') {
        sendJson(response, 200, api.health());
        return;
      }
      if (method === 'POST' && path === '/tester/v1/keys') {
        sendJson(response, 201, api.issueTesterKey({ body: await readJsonBody(request) }));
        return;
      }
      if (method === 'POST' && path === '/tester/v1/intents/quote') {
        sendJson(response, 200, await api.quote({
          headers: request.headers,
          body: await readJsonBody(request),
        }));
        return;
      }
      if (method === 'POST' && path === '/tester/v1/intents/submit') {
        sendJson(response, 200, await api.submit({
          headers: request.headers,
          body: await readJsonBody(request),
        }));
        return;
      }
      if (method === 'POST' && path === '/tester/v1/reset') {
        sendJson(response, 200, api.reset({ headers: request.headers }));
        return;
      }
      const intentMatch = path.match(/^\/tester\/v1\/intents\/([^/]+)(?:\/(refund|simulate-fill))?$/);
      if (intentMatch) {
        const params = { intentId: decodeURIComponent(intentMatch[1]) };
        const action = intentMatch[2];
        if (method === 'GET' && !action) {
          sendJson(response, 200, api.status({ headers: request.headers, params }));
          return;
        }
        if (method === 'POST' && action === 'refund') {
          sendJson(response, 200, api.refund({ headers: request.headers, params }));
          return;
        }
        if (method === 'POST' && action === 'simulate-fill') {
          sendJson(response, 200, api.simulateFill({ headers: request.headers, params }));
          return;
        }
      }
      sendJson(response, 404, { error: 'route not found' });
    } catch (error) {
      sendJson(response, 400, {
        error: String(error && error.message ? error.message : error),
      });
    }
  });
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  createTesterHttpServer().listen(port, () => {
    console.log(`Oruva Intents tester server listening on port ${port}`);
  });
}
