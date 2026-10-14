import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HTML_PAGE, PRELOAD_JS, server } from '../sidecars/context-monitor/server.mjs';

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
    assert.doesNotMatch(HTML_PAGE, /(src|href)=["']?https?:/i);
    assert.doesNotMatch(HTML_PAGE, /@import|url\(\s*["']?https?:/i);
    assert.ok(HTML_PAGE.includes('id="langToggle"'));
    assert.ok(HTML_PAGE.includes('const I18N ='));
    assert.ok(PRELOAD_JS.includes('theme-change'));
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
});
