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

function isAllowedHost(host) {
  return ALLOWED_HOSTNAMES.has(hostnameOf(host || ''));
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

function defaultHostConvId() {
  return !process.env.AGY_GEMINI_ROOT ? (process.env.ANTIGRAVITY_CONVERSATION_ID || '') : '';
}

async function buildMetricsPayload(searchParams, hostConvId = '') {
  const followLatest = searchParams.get('followLatest') === '1';
  const requestedConvId = searchParams.get('conversationId') || (followLatest ? '' : hostConvId);
  const pricing = searchParams.get('pricing') || 'auto';
  const clientEtag = searchParams.get('etag') || '';
  const metrics = await getConversationMetrics(requestedConvId, pricing);
  if (clientEtag && metrics.etag === clientEtag) {
    return { unchanged: true, etag: metrics.etag, conversationId: metrics.conversationId };
  }
  return metrics;
}

const server = createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (!isAllowedHost(host)) {
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
    try {
      const payload = await buildMetricsPayload(url.searchParams, defaultHostConvId());
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload));
    } catch (err) {
      console.error('[context-monitor] failed to collect metrics:', err);
      send(res, 500, 'application/json', JSON.stringify({ error: 'Failed to collect metrics' }));
    }
    return;
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
});

async function start() {
  const hasSdkEnv = Boolean(
    process.env.ANTIGRAVITY_LS_ADDRESS &&
      process.env.ANTIGRAVITY_CSRF_TOKEN &&
      process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
      !process.env.AGY_FORCE_STANDALONE
  );

  if (hasSdkEnv) {
    try {
      const { SidecarApp, Response } = await import('sidecar_sdk');
      const app = new SidecarApp();
      const serveIndex = () =>
        new Response(readUi('index.html'), {
          contentType: 'text/html; charset=utf-8',
          headers: { 'Cache-Control': 'no-store' },
        });
      app.page('/', serveIndex);
      app.page('/index.html', serveIndex);
      app.api(
        '/api/metrics',
        async (data) => {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(data || {})) {
            if (v !== undefined && v !== null) params.set(k, String(v));
          }
          try {
            const payload = await buildMetricsPayload(
              params,
              app.config?.conversationId || defaultHostConvId()
            );
            return new Response(JSON.stringify(payload), {
              contentType: 'application/json; charset=utf-8',
              headers: { 'Cache-Control': 'no-store' },
            });
          } catch (err) {
            console.error('[context-monitor] failed to collect metrics:', err);
            return new Response(JSON.stringify({ error: 'Failed to collect metrics' }), {
              status: 500,
              contentType: 'application/json',
              headers: { 'Cache-Control': 'no-store' },
            });
          }
        },
        'GET'
      );

      const sdkServer = await app.run();
      const origListeners = sdkServer.listeners('request');
      sdkServer.removeAllListeners('request');
      sdkServer.on('request', (req, res) => {
        const host = req.headers.host || '';
        if (!isAllowedHost(host)) {
          console.warn(`[context-monitor] rejected request with Host ${JSON.stringify(host)}`);
          send(res, 403, 'application/json', JSON.stringify({ error: 'Forbidden host' }));
          return;
        }
        for (const fn of origListeners) fn.call(sdkServer, req, res);
      });
      return;
    } catch {
      // Not launched with Antigravity's sidecar loader; fall back to standalone HTTP server.
    }
  }

  server.listen(PORT, BIND_HOST, () => {
    console.log(`[context-monitor] listening on http://${BIND_HOST}:${PORT}`);
  });
}

const realPath = (p) => (existsSync(p) ? realpathSync(p) : p);
const isMain =
  process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  await start();
}

export { server };
