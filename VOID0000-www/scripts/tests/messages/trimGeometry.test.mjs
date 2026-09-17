import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Full routed app, real rows/CSS and pagination; only network responses are fixtures.
test('mixed-height history trimming preserves surviving visible rows in both directions', { timeout: 240000 }, async () => {
  const baseline = process.env.TRIM_BASELINE === '1';
  // Serve the pre-fix owners for comparison without changing the working tree.
  const previousOwners = ['src/Services/hooks/Chats/MessageList/messageListRuntime.ts',
    'src/components/Chat/MessageView/useMessageRowMeasurements.ts'];
  const server = process.env.TRIM_DEPLOYED_URL ? null : await createServer({
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: baseline ? [{ name: 'trim-measurement-baseline', enforce: 'pre', load(id) {
      const file = previousOwners.find(file => id === `${process.cwd()}/${file}`);
      return file ? execFileSync('git', ['show', `273c88f:VOID0000-www/${file}`], { encoding: 'utf8' }) : null;
    } }] : [],
  });
  await server?.listen();
  const base = (process.env.TRIM_DEPLOYED_URL || server.resolvedUrls.local[0]).replace(/\/$/, '');
  const browser = await chromium.launch();
  const reports = [];
  const user = { id: '10d44508-fded-489b-945d-c5008dfd8b45', profile_id: '101', username: 'fixture', display_name: 'Fixture' };
  const peer = { ...user, id: '20d44508-fded-489b-945d-c5008dfd8b45', profile_id: '102', username: 'peer' };
  const conversation = { id: 'b3f849f1-a6c0-46b2-9027-7e53e009d460', public_id: '456', type: 'group', name: 'Trim fixture',
    role: 'owner', owner_id: user.id, member_count: 2, created_at: '2026-01-01', updated_at: '2026-01-01',
    members: [user, peer].map(u => ({ user_id: u.id, ...u, role: 'owner' })) };
  const messages = Array.from({ length: 220 }, (_, i) => {
    const attachments = [];
    if (i % 9 === 0) attachments.push({ id: `image-${i}`, mime: 'image/jpeg', name: 'image.jpg', inline: true,
      width: 3760, height: 5640, display_url: 'https://vmd.void0000.online/fixture.jpg', url: 'https://cdn.void0000.online/fixture.jpg' });
    if (i % 11 === 0) attachments.push({ id: `video-${i}`, mime: 'video/mp4', name: 'video.mp4', inline: true, video_trusted: true,
      width: 1920, height: 1080, url: 'https://cdn.void0000.online/fixture.mp4', poster: { url: 'https://cdn.void0000.online/fixture.jpg' } });
    return { conversation_id: conversation.id, message_id: `${String(i + 1).padStart(8, '0')}-88b1-11f1-bc31-62cdbf2cbe66`,
      sender_id: Math.floor(i / 7) % 2 ? user.id : peer.id, content: i % 3 ? `Message ${i}` : `Message ${i}: wrapping text with fractional line heights. `.repeat(6),
      created_at: new Date(Date.UTC(2026, 8, 1, 23, 0, i * 30)).toISOString(), message_type: 'text',
      reply_to: i % 13 === 0 && i > 0 ? `${String(i).padStart(8, '0')}-88b1-11f1-bc31-62cdbf2cbe66` : null,
      reactions: i % 7 === 0 ? { '\u{1f44d}': [peer.id] } : {}, attachments: attachments.map(a => JSON.stringify(a)), is_deleted: false, is_edited: false };
  });
  try {
    if (server) {
      const page = await browser.newPage();
      await page.route('**/measurement-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/tests/messages/measurementHandoffFixture.tsx"></script>' }));
      await page.goto(`${base}/measurement-fixture`);
      await page.waitForFunction(() => window.handoff);
      await page.waitForTimeout(100);
      await page.evaluate(() => window.handoff.start());
      await page.waitForFunction(() => window.handoff && document.querySelectorAll('[data-message-id]').length === 80);
      await page.waitForTimeout(100);
      const handoff = await page.evaluate(() => window.handoff.trim());
      console.log(JSON.stringify({ handoff: { actual: handoff.actual, accounted: handoff.accounted, difference: handoff.accounted - handoff.actual } }));
      await fs.mkdir('performance-results', { recursive: true });
      await fs.writeFile(`performance-results/trim-handoff-${baseline ? 'before' : 'after'}.json`, JSON.stringify(handoff, null, 2));
      if (!baseline) assert.ok(Math.abs(handoff.actual - handoff.accounted) <= 0.01, 'measured heights must survive a window commit before the scheduled flush');
      else assert.ok(Math.abs(handoff.actual - handoff.accounted) > 1, 'the old owners must reproduce the lost measurement batch');
      await page.close();
    }
    for (const [width, density] of [[1280, 'compact'], [390, 'compact'], [1280, 'comfortable'], [390, 'comfortable']]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const pending = [];
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => localStorage.setItem('void:message-geometry-debug', '1'));
      await page.addInitScript(density => localStorage.setItem('void_density', density), density);
      await page.routeWebSocket('**/gateway', ws => {
        ws.onMessage(raw => {
          const frame = JSON.parse(String(raw));
          if (frame.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture', user_id: user.id } }));
          if (frame.op === 1) ws.send(JSON.stringify({ op: 3 }));
        });
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
      });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/fixture.jpg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="gray"/></svg>' });
        if (url.pathname.startsWith('/api/')) {
          let body = { success: true, csrfToken: 'fixture', friends: [], presences: [],
            preferences: { density, message_group_spacing: 16, chat_font_scale: 14 }, incoming: [], outgoing: [] };
          if (url.pathname === '/api/bootstrap') body = { ...body, user, account: user, conversations: [conversation], friend_requests: { incoming: [], outgoing: [] } };
          if (url.pathname === '/api/conversations') body = { success: true, conversations: [conversation] };
          if ([`/api/conversations/${conversation.id}`, '/api/conversations/456'].includes(url.pathname)) body = { success: true, conversation };
          if (/\/messages$/.test(url.pathname)) {
            const before = url.searchParams.get('before'), after = url.searchParams.get('after');
            const index = messages.findIndex(m => m.message_id === (before || after));
            const selected = before ? messages.slice(Math.max(0, index - 20), index) : after ? messages.slice(index + 1, index + 21) : messages.slice(-20);
            const hasMore = before ? index > 20 : after ? index + 21 < messages.length : true;
            body = { success: true, messages: selected, has_more: hasMore };
            if (before || after) await new Promise(resolve => pending.push({ direction: before ? 'older' : 'newer', resolve, ids: selected.map(m => m.message_id) }));
          } else if (/\/messages\//.test(url.pathname)) {
            body = { success: true, message: messages.find(m => url.pathname.endsWith(m.message_id)) || messages[0] };
          }
          return route.fulfill({ json: body });
        }
        if (url.origin === new URL(base).origin) return route.continue();
        return route.abort();
      });
      const snapshot = () => page.evaluate(async ({ id, local }) => {
        const scroller = document.querySelector('[data-message-timeline]');
        let runtime = local ? (await import('/src/Services/hooks/Chats/MessageList/messageListRuntime.ts')).getSavedConversationRuntime(id) : null;
        const estimator = local ? (await import('/src/components/Chat/Messages/messageRowHeight.ts')).estimateMessageRowHeight : null;
        const bounds = scroller.getBoundingClientRect();
        // Optional test-only introspection enriches deployed traces. Assertions
        // about movement/count/order below still use actual DOM geometry.
        const domIds = [...scroller.querySelectorAll('[data-message-id]')].map(row => row.dataset.messageId);
        let windowState = null;
        let owner = scroller[Object.keys(scroller).find(key => key.startsWith('__reactFiber'))];
        for (; owner && !windowState; owner = owner.return) {
          for (const candidate of [owner, owner.alternate]) {
            for (let hook = candidate?.memoizedState; hook && typeof hook === 'object' && 'next' in hook; hook = hook.next) {
              const state = hook.memoizedState;
              if (state?.runtime?.renderedIds?.join() === domIds.join() && state.groupBreakBeforeIds instanceof Set) {
                windowState = state;
                break;
              }
            }
          }
        }
        runtime ||= windowState?.runtime;
        const measurements = window.__trimMeasuredHeights ||= new Map();
        for (const entry of window.__VOID_MESSAGE_GEOMETRY_DEBUG__ || []) {
          if (entry.event.startsWith('message_row_') && entry.payload?.messageId) measurements.set(entry.payload.messageId, entry.payload.nextHeight);
        }
        const rows = [...scroller.querySelectorAll('[data-message-id]')].map(row => {
          const rect = row.getBoundingClientRect();
          let fiber = row[Object.keys(row).find(k => k.startsWith('__reactFiber'))];
          while (fiber && !fiber.memoizedProps?.message) fiber = fiber.return;
          const props = fiber?.memoizedProps;
          const message = props?.message || runtime?.messageById.get(row.dataset.messageId);
          return { id: row.dataset.messageId, top: rect.top, height: rect.height, visible: rect.bottom > bounds.top && rect.top < bounds.bottom,
            measuredCache: measurements.get(row.dataset.messageId), runtimeHeight: runtime?.heightByMessageId.get(row.dataset.messageId),
            estimate: message && estimator ? estimator(message, props?.density || 'comfortable') : null,
            startsGroup: props?.startsGroup, showDateSeparator: props?.showDateSeparator, sender: message?.sender_id,
            groupBreakBefore: windowState?.groupBreakBeforeIds.has(row.dataset.messageId),
            type: message?.message_type, paddingTop: getComputedStyle(row).paddingTop };
        });
        return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
          rect: { top: bounds.top, bottom: bounds.bottom }, rows, top: runtime?.topSpacerHeight, bottom: runtime?.bottomSpacerHeight,
          physicalTop: scroller.querySelector('[data-message-older-range]')?.getBoundingClientRect().height || 0,
          physicalBottom: scroller.querySelector('[data-message-newer-range]')?.getBoundingClientRect().height || 0 };
      }, { id: conversation.id, local: Boolean(server) });
      try {
        await page.goto(`${base}/chats/456`);
        await page.locator('[data-message-id]').last().waitFor({ timeout: 45000 });
        await page.waitForTimeout(1000);
        for (const direction of [...Array(7).fill('older'), ...Array(4).fill('newer')]) {
          await page.locator('[data-message-timeline]').evaluate((s, direction) => {
            const range = s.querySelector(direction === 'older' ? '[data-message-older-range]' : '[data-message-newer-range]');
            const height = range?.getBoundingClientRect().height || 0;
            s.scrollTop = direction === 'older' ? height + 80 : s.scrollHeight - height - s.clientHeight - 80;
          }, direction);
          for (let i = 0; i < 100 && !pending.some(p => p.direction === direction); i++) await page.waitForTimeout(50);
          const request = pending.find(p => p.direction === direction);
          assert.ok(request, `no ${direction} request at ${width}px`);
          await page.waitForTimeout(100);
          const before = await snapshot();
          await page.evaluate(() => window.clearMessageGeometryDebugReport?.());
          pending.splice(pending.indexOf(request), 1); request.resolve();
          await page.waitForFunction(ids => ids.some(id => document.querySelector(`[data-message-id="${id}"]`)), request.ids);
          await page.waitForTimeout(300);
          const after = await snapshot();
          const events = await page.evaluate(() => window.__VOID_MESSAGE_GEOMETRY_DEBUG__ || []);
          const removed = before.rows.filter(r => !after.rows.some(a => a.id === r.id)).map(row => ({
            ...row, direction: direction === 'older' ? 'new/bottom' : 'old/top',
            usedForSpacer: row.runtimeHeight ?? row.measuredCache ?? row.estimate,
          }));
          const anchors = before.rows.filter(r => r.visible).map(row => ({ id: row.id, before: row.top, after: after.rows.find(a => a.id === row.id)?.top }));
          const surviving = anchors.filter(a => a.after !== undefined);
          const record = { width, density, direction, before, after, removed, anchors, events,
            survivingBoundary: [after.rows[0], after.rows.at(-1)].map(row => ({ before: before.rows.find(r => r.id === row.id), after: row })),
            removedHeight: removed.reduce((s, r) => s + r.height, 0),
            spacerDelta: direction === 'older' ? after.bottom - before.bottom : after.top - before.top,
            maxDisplacement: Math.max(0, ...surviving.map(a => Math.abs(a.after - a.before))) };
          reports.push(record);
          if (removed.length) {
            console.log(JSON.stringify({ width, density, direction, removed: removed.length, count: after.rows.length, actual: record.removedHeight,
              spacerDelta: record.spacerDelta, displacement: record.maxDisplacement }));
            assert.equal(after.rows.length, 60);
            assert.ok(surviving.length > 0);
            if (!baseline) {
              assert.ok(record.maxDisplacement <= 1, `trim moved anchor ${record.maxDisplacement}px`);
              if (server) assert.ok(Math.abs(record.spacerDelta - record.removedHeight) <= 0.01, 'trim spacer must match removed DOM rows');
              assert.ok(events.filter(e => e.event === 'layout_shift' && !e.payload.hadRecentInput).every(e => e.payload.value <= 0.001), 'no meaningful trim CLS');
            }
            const beforeIds = before.rows.map(r => r.id);
            assert.deepEqual(removed.map(r => r.id), direction === 'older' ? beforeIds.slice(-removed.length) : beforeIds.slice(0, removed.length));
            assert.ok(direction === 'older' ? after.physicalBottom > 0 : after.physicalTop > 0);
          }
          // Surviving interior grouping/date traits must not change at window seams.
          for (const row of after.rows.slice(1)) {
            const previous = before.rows.find(r => r.id === row.id);
            if (previous) {
              assert.equal(row.startsGroup, previous.startsGroup);
              assert.equal(row.showDateSeparator, previous.showDateSeparator);
            }
          }
          assert.equal(new Set(after.rows.map(r => r.id)).size, after.rows.length);
          assert.deepEqual(after.rows.map(r => r.id), after.rows.map(r => r.id).sort());
        }
        assert.deepEqual(errors, []);
        assert.ok(reports.some(r => r.width === width && r.density === density && r.direction === 'older' && r.removed.length));
        assert.ok(reports.some(r => r.width === width && r.density === density && r.direction === 'newer' && r.removed.length));
      } catch (error) {
        console.error({ url: page.url(), errors, text: (await page.locator('body').innerText()).slice(0, 1800) });
        throw error;
      } finally { pending.forEach(p => p.resolve()); await page.close(); }
    }
  } finally {
    await browser.close(); await server?.close();
    await fs.mkdir('performance-results', { recursive: true });
    await fs.writeFile(`performance-results/trim-${baseline ? 'before' : 'after'}${server ? '' : '-deployed'}.json`, JSON.stringify(reports, null, 2));
  }
});
