import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('real hook coalesces taps, sends explicit methods, applies batch envelope and converges two tabs', { timeout: 30_000 }, async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom', optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime'] }, server: { host: '127.0.0.1', port: 0, watch: null } });
  server.middlewares.use((req, res, next) => { if (req.url !== '/') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div>'); });
  let browser;
  try {
    await server.listen(); const origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
    const pages = [await context.newPage(), await context.newPage()];
    const requests = [], errors = []; let revision = 0, present = false;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/csrf/')) return route.fulfill({ json: { success: true, csrfToken: 'test-only' } });
      if (url.pathname.endsWith('/reactions/a')) {
        const request = route.request(), body = request.postDataJSON();
        requests.push({ method: request.method(), body, csrf: request.headers()['x-csrf-token'], account: request.headers()['x-void-account-id'] });
        if (present !== body.present) { present = body.present; revision++; }
        const event = { user_id: 'user', emoji: 'a', action: present ? 'add' : 'remove', counts: present ? { a: 1 } : {}, mine: present ? ['a'] : [], revision: String(revision) };
        for (const page of pages) await page.evaluate(async event => {
          (await import('/src/Services/Gateway/gateway.ts')).gateway.emit('REACTIONS_BATCH', { conversation_id: 'conversation', message_id: 'message', events: [event] });
        }, event);
        return route.fulfill({ json: { success: true, conversation_id: 'conversation', message_id: 'message', ...event } });
      }
      if (route.request().url().startsWith(origin)) return route.continue();
      return route.abort();
    });
    for (const page of pages) {
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin); await page.evaluate(() => import('/scripts/tests/messages/reactionFixture.tsx'));
      await page.waitForFunction(() => document.querySelector('#state')?.textContent === '{"message":{}}');
    }
    await pages[0].evaluate(() => { for (let i = 0; i < 3; i++) document.querySelector('#reaction').click(); });
    for (const page of pages) await page.waitForFunction(() => document.querySelector('#state').textContent === '{"message":{"a":{"count":1,"me":true}}}');
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'PUT'); assert.equal(requests[0].body.present, true);
    await pages[1].click('#reaction');
    for (const page of pages) await page.waitForFunction(() => document.querySelector('#state').textContent === '{"message":{}}');
    assert.equal(requests.length, 2); assert.equal(requests[1].method, 'DELETE'); assert.equal(requests[1].body.present, false);
    assert.ok(requests.every(r => r.csrf === 'test-only' && r.account === 'user'));
    await pages[0].evaluate(async () => {
      document.querySelector('#reaction').click();
      (await import('/src/Services/Chat/chatStorageAccount.ts')).setChatStorageAccount('different-user');
    });
    await pages[0].waitForTimeout(500); assert.equal(requests.length, 2);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
