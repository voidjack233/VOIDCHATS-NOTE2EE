import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { installChatPerformanceCollector } from '../../performance/chat-cls-lcp-browser.mjs';
import { calculateCls } from '../../performance/chat-cls-lcp-core.mjs';

// Uses the deployed JS/CSS, but intercepts ALL API/WS/media traffic with fixtures.
// This is a deployed-build regression smoke, not a real-network media benchmark.
test('deployed routed timeline: delayed mixed media and poster playback retain row geometry', { timeout: 180000 }, async () => {
  const base = process.env.MEDIA_TEST_DEPLOYED_URL;
  assert.ok(base, 'Set MEDIA_TEST_DEPLOYED_URL explicitly; this test never chooses a live target implicitly');
  const baseline = process.env.MEDIA_BASELINE === '1';
  const browser = await chromium.launch();
  const movie = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10',
    '-t', '3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  const picture = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=960x540',
    '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '1', '-q:v', '2', '-f', 'image2pipe', 'pipe:1']);
  const records = [];
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const user = { id: '10d44508-fded-489b-945d-c5008dfd8b45', profile_id: '101', username: 'fixture', display_name: 'Fixture' };
      const conversation = { id: 'b3f849f1-a6c0-46b2-9027-7e53e009d460', public_id: '456', type: 'group', name: 'Media fixture',
        role: 'owner', owner_id: user.id, member_count: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
        members: [{ user_id: user.id, profile_id: '101', username: 'fixture', display_name: 'Fixture', role: 'owner' }] };
      const image = (id, w, h) => ({ id, mime: 'image/png', name: `${id}.png`, inline: true, width: w, height: h,
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', url: `https://cdn.void0000.online/test-media/${id}/original`,
        display_url: `https://vmd.void0000.online/test-media/${id}/small` });
      const video = id => ({ id, mime: 'video/mp4', name: `${id}.mp4`, inline: true, video_trusted: true,
        width: 1920, height: 1080, duration_ms: 3000, url: `https://cdn.void0000.online/test-media/${id}/video`,
        poster: { url: `https://cdn.void0000.online/test-media/${id}/poster`, width: 640, height: 360 } });
      const groups = [[image('portrait', 3760, 5640)], [image('landscape', 5640, 3760)],
        [image('portrait2', 3760, 5640), image('landscape2', 5640, 3760)],
        [image('mixed', 1920, 1080), video('one')], [video('two'), video('three')],
        [image('file-image', 1920, 1080), { id: 'file', name: 'note.txt', mime: 'text/plain', size: 20, url: '/test-media/file' }]];
      const messages = groups.map((attachments, i) => ({ conversation_id: conversation.id,
        message_id: `${String(i + 1).padStart(8, '0')}-88b1-11f1-bc31-62cdbf2cbe66`, sender_id: user.id,
        content: '', message_type: 'text', created_at: `2026-09-01T00:00:0${i}.000Z`,
        is_deleted: false, is_edited: false, attachments: attachments.map(a => JSON.stringify(a)) }));
      let release; const held = new Promise(resolve => { release = resolve; });
      const failures = [];
      await page.addInitScript(installChatPerformanceCollector);
      page.on('pageerror', e => failures.push(e.message));
      await page.routeWebSocket('**/gateway', ws => {
        ws.onMessage(raw => {
          const frame = JSON.parse(String(raw));
          if (frame.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'media-fixture', user_id: user.id } }));
          if (frame.op === 1) ws.send(JSON.stringify({ op: 3 }));
        });
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
      });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/test-media/')) {
          await held;
          if (url.pathname.endsWith('/video')) return route.fulfill({ contentType: 'video/mp4', body: movie });
          return route.fulfill({ contentType: 'image/jpeg', body: picture });
        }
        if (url.pathname.startsWith('/api/')) {
          let body = { success: true, csrfToken: 'fixture-only', friends: [], presences: [], preferences: {}, incoming: [], outgoing: [] };
          if (url.pathname === '/api/bootstrap') body = { ...body, user, account: user, conversations: [conversation], friend_requests: { incoming: [], outgoing: [] } };
          if (url.pathname === '/api/conversations') body = { success: true, conversations: [conversation] };
          if ([`/api/conversations/${conversation.id}`, '/api/conversations/456'].includes(url.pathname)) body = { success: true, conversation };
          if (/\/messages(?:\/|$)/.test(url.pathname)) body = { success: true, messages, has_more: false, hasOlder: false, hasNewer: false };
          return route.fulfill({ json: body });
        }
        if (url.origin === new URL(base).origin) return route.continue();
        return route.abort();
      });
      try {
        await page.goto(`${base}/chats/456`);
        await page.locator('[data-message-id]').last().waitFor({ timeout: 30000 });
        await page.waitForTimeout(1500);
        const rects = () => page.locator('[data-message-id]').evaluateAll(rows => rows.map(row => {
          const r = row.getBoundingClientRect(); return { id: row.dataset.messageId, y: r.y, width: r.width, height: r.height };
        }));
        const before = await rects(); const start = await page.evaluate(() => performance.now()); release();
        await page.waitForTimeout(1500); const after = await rects();
        const metrics = await page.evaluate(() => window.__voidChatPerf.export());
        const mediaShifts = metrics.layoutShifts.filter(e => e.startTime >= start);
        if (!baseline) { assert.deepEqual(after, before); assert.equal(calculateCls(mediaShifts), 0); assert.equal(await page.locator('video').count(), 0); }
        const play = page.getByRole('button', { name: /^Play video:/ }).last();
        if (!baseline) {
          await play.scrollIntoViewIfNeeded(); const beforePlay = await rects(); await play.click();
          await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.currentTime > 0 && !v.paused));
          assert.deepEqual(await rects(), beforePlay); await page.locator('video').evaluate(v => v.pause());
        }
        assert.deepEqual(failures, []);
        const record = { width, baseline, initialCls: calculateCls(metrics.layoutShifts), mediaCls: calculateCls(mediaShifts),
          lcp: metrics.hardLcps.at(-1), before, after, shifts: metrics.layoutShifts };
        records.push(record); console.log(JSON.stringify(record));
      } finally { release(); await page.close(); }
    }
  } finally {
    await browser.close(); await fs.mkdir('performance-results', { recursive: true });
    await fs.writeFile(`performance-results/media-deployed-${baseline ? 'before' : 'after'}.json`, JSON.stringify(records, null, 2));
  }
});
