#!/usr/bin/env node
// Antigravity sidecar entrypoint: serves the Context & TPS panel and its metrics API
// on the loopback interface. Antigravity starts it via sidecar.json.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getConversationMetrics } from './metrics.mjs';

const BIND_HOST = '127.0.0.1';
const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '18990', 10);

// Only loopback names may appear in the Host header, so a web page that points
// its own domain at 127.0.0.1 (DNS rebinding) cannot read the API. The port is
// not checked.
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

// Read on each request so UI edits show up without a restart (`node --watch`
// only watches the module graph).
function readUi(name) {
  return readFileSync(new URL(`./ui/${name}`, import.meta.url), 'utf-8');
}

function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (!ALLOWED_HOSTNAMES.has(hostnameOf(host))) {
    console.warn(`[context-monitor] rejected request with Host ${JSON.stringify(host)}`);
    send(res, 403, 'application/json', JSON.stringify({ error: 'Forbidden host' }));
    return;
  }

  const url = new URL(req.url || '/', `http://${BIND_HOST}:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    send(res, 200, 'text/html; charset=utf-8', readUi('index.html'));
    return;
  }

  if (url.pathname === '/preload.js') {
    send(res, 200, 'application/javascript; charset=utf-8', readUi('preload.js'));
    return;
  }

  if (url.pathname === '/api/metrics') {
    const convId = url.searchParams.get('conversationId') || '';
    const pricing = url.searchParams.get('pricing') || 'auto';
    try {
      const metrics = await getConversationMetrics(convId, pricing);
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(metrics));
    } catch (err) {
      console.error('[context-monitor] failed to collect metrics:', err);
      send(res, 500, 'application/json', JSON.stringify({ error: 'Failed to collect metrics' }));
    }
    return;
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
});

const realPath = (p) => (existsSync(p) ? realpathSync(p) : p);
const isMain =
  process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[context-monitor] listening on http://${BIND_HOST}:${PORT}`);
  });
}

export { server };
