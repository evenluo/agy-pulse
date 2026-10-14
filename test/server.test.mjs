import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { server } from '../sidecars/context-monitor/server.mjs';

function getWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/metrics', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const readUi = (name) =>
  readFileSync(new URL(`../sidecars/context-monitor/ui/${name}`, import.meta.url), 'utf-8');

describe('Offline UI & HTTP Server', () => {
  let tmpRoot;
  let baseUrl;

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-srv-test-'));
    process.env.AGY_GEMINI_ROOT = tmpRoot;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    delete process.env.AGY_GEMINI_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('ships a self-contained page with no external scripts, styles, or fonts', () => {
    const HTML_PAGE = readUi('index.html');
    assert.doesNotMatch(HTML_PAGE, /(src|href)=["']?https?:/i);
    assert.doesNotMatch(HTML_PAGE, /@import|url\(\s*["']?https?:/i);
    assert.ok(HTML_PAGE.includes('id="langToggle"'));
    assert.ok(HTML_PAGE.includes('const I18N ='));
    assert.ok(readUi('preload.js').includes('theme-change'));
  });

  it('serves /, /preload.js, /api/metrics, and 404', async () => {
    const html = await fetch(`${baseUrl}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.ok((await html.text()).includes('Context & TPS Monitor'));

    const preload = await fetch(`${baseUrl}/preload.js`);
    assert.equal(preload.status, 200);
    assert.ok((await preload.text()).includes('theme-change'));

    const api = await fetch(`${baseUrl}/api/metrics`);
    assert.equal(api.status, 200);
    const json = await api.json();
    assert.equal(json.summary.turnCount, 0);
    assert.deepEqual(json.recentConversations, []);

    const missing = await fetch(`${baseUrl}/unknown-route`);
    assert.equal(missing.status, 404);
    await missing.text();
  });

  it('accepts loopback Host names on any port and rejects others (DNS rebinding)', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const { port } = server.address();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'LOCALHOST:1', 'localhost']) {
      assert.equal(await getWithHost(port, host), 200, host);
    }
    for (const host of [`evil.example:${port}`, 'evil.example', `127.0.0.1.nip.io:${port}`, 'localhost.:1']) {
      assert.equal(await getWithHost(port, host), 403, host);
    }
  });
});
