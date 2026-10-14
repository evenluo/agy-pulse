#!/usr/bin/env node
// Antigravity sidecar entrypoint: serves the Context & TPS panel and its metrics API
// on the loopback interface. Antigravity starts it via sidecar.json.

import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getConversationMetrics } from './metrics.mjs';

const BIND_HOST = '127.0.0.1';
const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '18990', 10);

const HTML_PAGE = readFileSync(new URL('./ui/index.html', import.meta.url), 'utf-8');
const PRELOAD_JS = readFileSync(new URL('./ui/preload.js', import.meta.url), 'utf-8');

function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${BIND_HOST}:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    send(res, 200, 'text/html; charset=utf-8', HTML_PAGE);
    return;
  }

  if (url.pathname === '/preload.js') {
    send(res, 200, 'application/javascript; charset=utf-8', PRELOAD_JS);
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

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[context-monitor] listening on http://${BIND_HOST}:${PORT}`);
  });
}

export { HTML_PAGE, PRELOAD_JS, server };
