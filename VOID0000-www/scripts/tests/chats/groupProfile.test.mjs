import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('non-friend group hydration, profile click and live message/settings/typing/modal identity', { timeout: 90_000 }, async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom',
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', 'react-virtuoso'] },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  server.middlewares.use((req, res, next) => {
    if (req.url !== '/') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<div id="root"></div>');
  });
  let browser;
  try {
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const profileId = '732434999193640961'; // Above JS safe-integer precision, deliberately not round.
    const user = { id: 'self', profile_id: '101', username: 'self-handle' };
    const member = { user_id: 'peer', profile_id: profileId, username: 'peer-handle', display_name: 'Old member',
      avatar_url: '/avatars/old.svg', nickname: null, role: 'member', joined_at: '2026-01-01' };
    const group = { id: 'group', public_id: '456', type: 'group', name: 'Group', owner_id: 'self',
      role: 'owner', member_count: 2, members: [member, { ...member, user_id: 'self', profile_id: '101', role: 'owner' }] };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        requests.push(url.pathname);
        let body = { success: true, csrfToken: 'fixture-only', friends: [], presences: [], conversations: [] };
        if (url.pathname === '/api/bootstrap') body = { ...body, user, account: user, preferences: {}, friend_requests: { incoming: [], outgoing: [] } };
        if (url.pathname === '/api/conversations/456') body = { success: true, conversation: group };
        if (url.pathname.startsWith('/api/users/')) {
          assert.equal(url.pathname, `/api/users/${profileId}`, 'profile lookup must use the exact profile ID, never a user ID');
          body = { ...member, id: 'peer', bio: 'Old bio', created_at: '2026-01-01' };
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (url.pathname.startsWith('/avatars/')) return route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>' });
      if (route.request().url().startsWith(origin)) return route.continue();
      return route.abort(); // No production requests from this test.
    });
    await page.goto(origin);
    await page.evaluate(() => import('/scripts/tests/chats/groupProfileFixture.tsx'));
    await page.locator('#open-group').click();
    await page.waitForFunction(id => document.querySelector('#member-id')?.textContent === id, profileId, { timeout: 10_000 })
      .catch(async error => { throw new Error(`${error.message}\n${JSON.stringify({ requests, errors, body: await page.locator('body').innerText() })}`); });
    assert.equal(await page.locator('#friend-count').textContent(), '0');
    assert.equal(requests.filter(path => path === '/api/conversations/456').length, 1, 'summary must hydrate members');
    await page.locator('#row span.cursor-pointer').click();
    await page.waitForFunction(() => document.querySelector('#profile')?.textContent.includes('Old bio'));
    assert.deepEqual(requests.filter(path => path.startsWith('/api/users/')), [`/api/users/${profileId}`]);
    await page.locator('#settings').getByRole('button', { name: 'Members', exact: true }).click();
    const row = await page.locator('#row [data-message-id]').elementHandle();
    const emit = (event, data) => page.evaluate(async ({ event, data }) => {
      (await import('/src/Services/Gateway/gateway.ts')).gateway.emit(event, data);
    }, { event, data });
    await emit('TYPING_START', { conversation_id: 'group', user_id: 'peer' });
    await page.waitForFunction(() => document.querySelector('#typing')?.textContent.includes('Old member'));
    const profileRequests = () => requests.filter(path => path.startsWith('/api/users/') || path === '/api/conversations/456');
    const requestCount = profileRequests().length;
    const update = { user_id: 'peer', profile_id: profileId, display_name: 'Live member', avatar_url: '/avatars/new.svg', bio: 'Live bio' };
    await emit('PROFILE_UPDATE', update);
    await page.waitForFunction(() => ['#row', '#typing', '#settings', '#profile'].every(selector =>
      document.querySelector(selector)?.textContent.includes('Live member')));
    for (const selector of ['#row', '#typing', '#settings', '#profile']) {
      await page.waitForFunction(selector => [...document.querySelectorAll(`${selector} img`)].some(img => img.getAttribute('src') === '/avatars/new.svg'), selector);
    }
    assert.equal(await row.evaluate(node => node === document.querySelector('#row [data-message-id]')), true);
    assert.equal(profileRequests().length, requestCount, 'profile events must not trigger profile refetches');
    await emit('MEMBER_NICKNAME_UPDATE', { conversation_id: 'group', user_id: 'peer', nickname: 'Group nickname' });
    await emit('PROFILE_UPDATE', { ...update, display_name: 'New global name' });
    await page.waitForFunction(() => ['#row', '#typing', '#settings'].every(selector =>
      document.querySelector(selector)?.textContent.includes('Group nickname')));
    await page.waitForFunction(() => document.querySelector('#profile')?.textContent.includes('New global name'));
    await page.locator('#close-profile').click();
    await page.locator('#missing-profile').click();
    assert.equal(await page.locator('#profile').count(), 0);
    assert.equal(requests.filter(path => path.startsWith('/api/users/')).length, 1);
    await page.locator('#leave-view').click();
    await page.locator('#open-group').click();
    await page.waitForFunction(() => document.querySelector('#row')?.textContent.includes('New global name'));
    assert.equal(requests.filter(path => path === '/api/conversations/456').length, 1, 'hydrated group may be reused');

    // Old cached JSON-number IDs must be rehydrated rather than String(number)-rounded.
    await page.locator('#leave-view').click();
    await page.evaluate(async () => {
      const cache = await import('/src/Services/Chat/conversationCache.ts');
      const group = cache.getConversationDetails('456');
      cache.storeConversationDetails({ ...group, members: group.members.map(member => ({ ...member, profile_id: Number(member.profile_id) })) });
    });
    await page.locator('#open-group').click();
    await page.waitForFunction(id => document.querySelector('#member-id')?.textContent === id, profileId);
    assert.equal(requests.filter(path => path === '/api/conversations/456').length, 2);
    await page.evaluate(() => window.unmountProfileFixture());
    await emit('PROFILE_UPDATE', update);
    assert.equal(await page.locator('#row').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
