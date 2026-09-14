import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

test('real routed Chats hydrates an already-active group and handles non-friend socket profile updates', { timeout: 120_000 }, async () => {
  // Serve index.html -> main.tsx -> Router -> Chats, not a replacement test application.
  const baseline = process.env.PROFILE_BASELINE_REVISION;
  const server = await createServer({ root: process.cwd(),
    plugins: baseline ? [{ name: 'profile-regression-baseline', enforce: 'pre', load(id) {
      const relative = id.split('?')[0].replace(`${process.cwd()}/`, '');
      if (['src/pages/Chat/Chats.tsx', 'src/Services/hooks/Chats/useConversationMembers.ts'].includes(relative)) {
        return execFileSync('git', ['show', `${baseline}:VOID0000-www/${relative}`], { encoding: 'utf8' });
      }
    } }] : [],
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom', 'lucide-react', 'react-virtuoso'] },
    server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  let page;
  const errors = [];
  const requests = [];
  try {
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    const profileId = '732434999193640961';
    const user = { id: '10d44508-fded-489b-945d-c5008dfd8b45', profile_id: '101', username: 'self', display_name: 'Viewer' };
    const peer = '953b4d6e-5dd7-4d50-bde9-3dfbfb408d69';
    const groupId = 'b3f849f1-a6c0-46b2-9027-7e53e009d460';
    const member = { user_id: peer, profile_id: profileId, username: 'peer-handle', display_name: 'Old member',
      avatar_url: '/avatars/old.svg', nickname: null, role: 'member', joined_at: '2026-01-01' };
    const summary = { id: groupId, public_id: '456', type: 'group', name: 'Shared group', owner_id: user.id,
      role: 'owner', member_count: 2, created_at: '2026-01-01', updated_at: '2026-01-01', last_read_message_id: null };
    const group = { ...summary, members: [member, { ...member, user_id: user.id, profile_id: '101', username: 'self', display_name: 'Viewer', role: 'owner' }] };
    const message = { conversation_id: groupId, message_id: '53e52b80-88b1-11f1-bc31-62cdbf2cbe66', sender_id: peer,
      content: 'A real routed group message', message_type: 'text', created_at: '2026-09-01T00:00:00.000Z',
      reply_to: null, is_edited: false, edited_at: null, is_deleted: false };
    let socket;
    let sequence = 0;
    let identified = false;
    const send = (event, data) => {
      assert.ok(socket && identified, 'event requires an identified browser WebSocket');
      socket.send(JSON.stringify({ op: 0, t: event, s: ++sequence, d: data }));
    };
    await page.routeWebSocket('**/gateway', ws => {
      socket = ws;
      ws.onMessage(raw => {
        const frame = JSON.parse(String(raw));
        if (frame.op === 2) {
          assert.equal(frame.d.user_id, user.id);
          identified = true;
          send('READY', { session_id: 'profile-test-session', user_id: user.id });
        }
        if (frame.op === 1) ws.send(JSON.stringify({ op: 3 }));
      });
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    });
    let detailRequests = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        requests.push(url.pathname);
        let body = { success: true, csrfToken: 'fixture-only', friends: [], presences: [], preferences: {}, incoming: [], outgoing: [] };
        if (url.pathname === '/api/bootstrap') body = { ...body, user, account: user, conversations: [summary], friend_requests: { incoming: [], outgoing: [] } };
        if (url.pathname === '/api/conversations') body = { success: true, conversations: [summary] };
        if (url.pathname === '/api/conversations/456' || url.pathname === `/api/conversations/${groupId}`) {
          detailRequests++;
          body = { success: true, conversation: group };
        }
        if (/\/messages(?:\/|$)/.test(url.pathname)) body = { success: true, messages: [message], has_more: false, hasOlder: false, hasNewer: false };
        if (/\/api\/users\/[^/]+$/.test(url.pathname)) {
          assert.ok([`/api/users/${profileId}`, '/api/users/101', '/api/users/preferences'].includes(url.pathname), `Wrong profile lookup: ${url.pathname}`);
          if (url.pathname === `/api/users/${profileId}`) body = { ...member, id: peer, bio: 'Old bio', created_at: '2026-01-01' };
          if (url.pathname === '/api/users/101') body = { ...user, bio: '', created_at: '2026-01-01' };
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (url.pathname.startsWith('/avatars/')) return route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>' });
      if (route.request().url().startsWith(origin)) return route.continue();
      return route.abort(); // No real account data or requests to the deployed app.
    });
    await page.goto(`${origin}chats/456`);
    const row = page.locator(`[data-message-id="${message.message_id}"]`);
    await row.getByText('Old member', { exact: true }).waitFor();
    const initialRequests = detailRequests;
    assert.ok(initialRequests > 0);

    // Same routed group, already active, but with incomplete member identities.
    await page.evaluate(async () => {
      (await import('/src/Services/Gateway/gateway.ts')).gateway.on('CONVERSATION_UPDATE', () => { window.groupEventSeen = true; });
    });
    const hydration = page.waitForResponse(response => new URL(response.url()).pathname === '/api/conversations/456');
    send('CONVERSATION_UPDATE', { conversation: { ...summary, members: group.members.map(({ profile_id: _profileId, ...member }) => member) } });
    await hydration;
    await page.waitForFunction(async () => {
      const { getConversationDetails } = await import('/src/Services/Chat/conversationCache.ts');
      return window.groupEventSeen && getConversationDetails('456')?.members?.every(member => typeof member.profile_id === 'string');
    }, undefined, { timeout: 10_000 });
    assert.equal(detailRequests, initialRequests + 1, 'active route must rehydrate missing member IDs once');
    await row.getByText('Old member', { exact: true }).click();
    await page.getByText('Old bio', { exact: true }).waitFor();
    assert.ok(requests.some(path => path === `/api/users/${profileId}`));
    assert.equal(requests.includes(`/api/users/${peer}`), false);
    const rowNode = await row.elementHandle();
    const profileRequests = () => requests.filter(path => path === `/api/users/${profileId}`).length;
    const beforeProfiles = profileRequests();
    const beforeDetails = detailRequests;
    send('TYPING_START', { conversation_id: groupId, user_id: peer });
    send('PROFILE_UPDATE', { user_id: peer, profile_id: profileId, display_name: 'Live member', avatar_url: '/avatars/new.svg', bio: 'Live bio' });
    await row.getByText('Live member', { exact: true }).waitFor();
    await page.getByText('Live bio', { exact: true }).waitFor();
    await page.getByText('Live member is typing...', { exact: true }).waitFor();
    await page.waitForFunction(id => document.querySelector(`[data-message-id="${id}"] img`)?.getAttribute('src') === '/avatars/new.svg', message.message_id);
    assert.equal(await rowNode.evaluate(node => node.isConnected), true);
    assert.equal(profileRequests(), beforeProfiles);
    assert.equal(detailRequests, beforeDetails);

    const closeProfile = page.locator('.fixed.inset-0.z-50').filter({ hasText: 'Live bio' }).locator('button').first();
    await closeProfile.click();
    await page.getByTitle('Conversation settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    await page.getByRole('heading', { name: 'Current Members', exact: true }).waitFor();
    send('MEMBER_NICKNAME_UPDATE', { conversation_id: groupId, user_id: peer, nickname: 'Group nickname' });
    send('PROFILE_UPDATE', { user_id: peer, profile_id: profileId, display_name: 'Newest global name', avatar_url: null });
    await row.getByText('Group nickname', { exact: true }).waitFor();
    await page.waitForFunction(() => document.body.textContent.includes('Newest global name'));
    assert.equal(profileRequests(), beforeProfiles);
    assert.equal(detailRequests, beforeDetails);
    assert.deepEqual(errors, []);
  } catch (error) {
    throw new Error(`${error.message}\n${JSON.stringify({ errors, requests, body: await page?.locator('body').innerText() })}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});
