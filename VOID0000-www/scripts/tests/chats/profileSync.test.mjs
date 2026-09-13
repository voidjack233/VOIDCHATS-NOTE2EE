import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('PROFILE_UPDATE rerenders existing chat surfaces, survives resync, and handles broken avatars', { timeout: 90_000 }, async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom',
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', 'react-virtuoso'] },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  server.middlewares.use((req, res, next) => {
    if (req.url !== '/') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<div id="root"></div>');
  });
  let browser;
  let releaseFriends;
  try {
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let fixture;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        requests.push(url.pathname);
        if (url.pathname === '/api/friends') await new Promise(resolve => { releaseFriends = resolve; });
        const user = { id: 'self', profile_id: '101', username: 'self-handle' };
        const body = url.pathname === '/api/bootstrap'
          ? { success: true, user, account: user, friends: [fixture.friend], conversations: [fixture.conversation], preferences: {}, friend_requests: { incoming: [], outgoing: [] } }
          : { success: true, csrfToken: 'fixture-only', friends: [fixture.friend], conversations: [fixture.conversation], presences: [] };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (url.pathname.startsWith('/avatars/')) {
        requests.push(url.pathname);
        return url.pathname.includes('broken')
          ? route.fulfill({ status: 404, body: '' })
          : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>' });
      }
      if (route.request().url().startsWith(origin)) return route.continue();
      return route.abort();
    });
    await page.goto(origin);
    fixture = await page.evaluate(async () => {
      const fixtures = await import('/scripts/tests/chats/profileFixtures.ts');
      return { ...fixtures };
    });
    await page.evaluate(async () => {
      localStorage.setItem('void_profile_202', JSON.stringify({ id: 'peer', profile_id: '202', username: 'peer-handle',
        display_name: 'Old Name', avatar_url: '/avatars/old.svg', bio: 'Old bio', created_at: '2026-01-01' }));
      await import('/scripts/tests/chats/profileSyncFixture.tsx');
    });
    await page.waitForFunction(() => document.querySelector('#friend')?.textContent === 'Old Name');
    const row = await page.locator('#row [data-message-id]').elementHandle();
    const emit = data => page.evaluate(async data => {
      (await import('/src/Services/Gateway/gateway.ts')).gateway.emit('PROFILE_UPDATE', data);
    }, data);
    const requestCount = requests.filter(path => path.startsWith('/api/')).length;
    await emit(fixture.update);
    await page.waitForFunction(() => ['#friend', '#origin', '#row', '#settings', '#list'].every(selector =>
      document.querySelector(selector)?.textContent.includes('New Name')));
    for (const selector of ['#origin', '#row', '#settings', '#list']) {
      await page.waitForFunction(selector => [...document.querySelectorAll(`${selector} img`)].some(img => img.getAttribute('src') === '/avatars/new.svg'), selector);
    }
    assert.equal(await row.evaluate(node => node === document.querySelector('#row [data-message-id]')), true);
    assert.equal(requests.filter(path => path.startsWith('/api/')).length, requestCount);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('void_profile_202')).avatar_url), fixture.update.avatar_url);

    // A snapshot that was already in flight cannot roll back the newer event.
    await page.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 61_000;
      document.querySelector('#resync').click();
    });
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const wait = () => releaseFriends ? resolve() : Date.now() - started > 10_000 ? reject(new Error('resync did not start')) : setTimeout(wait, 10);
      wait();
    });
    await emit({ ...fixture.update, display_name: 'Newest Name' });
    releaseFriends();
    await page.waitForFunction(() => document.querySelector('#friend')?.textContent === 'Newest Name');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#friend').textContent(), 'Newest Name');

    await emit({ ...fixture.update, avatar_url: '/avatars/broken.svg' });
    await page.waitForFunction(() => document.querySelector('#row [data-avatar-state="failed"]') !== null);
    await page.waitForFunction(() => !document.querySelector('img[src="/avatars/broken.svg"]'));
    assert.equal(await page.locator('#row img').count(), 0);
    assert.match(await page.locator('#row [data-avatar-state="failed"]').textContent(), /N/);
    const brokenRequests = requests.filter(path => path === '/avatars/broken.svg').length;
    await emit({ ...fixture.update, avatar_url: undefined, bio: 'Update without an avatar retry' });
    await page.waitForTimeout(150);
    assert.equal(requests.filter(path => path === '/avatars/broken.svg').length, brokenRequests);
    await emit({ ...fixture.update, avatar_url: '/avatars/recovered.svg' });
    await page.waitForFunction(() => document.querySelector('#row [data-avatar-state="loaded"] img')?.getAttribute('src') === '/avatars/recovered.svg');

    await page.evaluate(async () => (await import('/src/Services/Gateway/gateway.ts')).gateway.emit(
      'MEMBER_NICKNAME_UPDATE', { conversation_id: 'dm', user_id: 'peer', nickname: 'Pet name' },
    ));
    await emit({ ...fixture.update, display_name: 'Changed behind nickname' });
    await page.waitForFunction(() => ['#origin', '#row', '#settings', '#list'].every(selector =>
      document.querySelector(selector)?.textContent.includes('Pet name')));
    assert.equal(await page.locator('#friend').textContent(), 'Changed behind nickname');
    await page.evaluate(async () => (await import('/src/Services/Gateway/gateway.ts')).gateway.emit(
      'MEMBER_NICKNAME_UPDATE', { conversation_id: 'dm', user_id: 'peer', nickname: null },
    ));

    await emit({ ...fixture.update, display_name: null, avatar_url: null });
    await page.waitForFunction(() => document.querySelector('#row')?.textContent.includes('peer-handle') && !document.querySelector('#row img'));
    assert.equal(await page.evaluate(async () => (await import('/src/Services/Chat/conversationCache.ts')).getConversationDetails('123').members[0].avatar_url), null);
    await page.evaluate(() => window.unmountProfileFixture());
    await emit(fixture.update);
    assert.equal(await page.locator('#row').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    releaseFriends?.();
    await browser?.close();
    await server.close();
  }
});
