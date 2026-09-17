import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const baseline = process.env.MEDIA_BASELINE === '1';
const hash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
const image = (id, width, height) => ({ id, name: `${id}.png`, mime: 'image/png', width, height, inline: true,
  blurhash: hash, url: `${locationOrigin}/test-media/${id}/original`, display_variants: {
    small: { url: `${locationOrigin}/test-media/${id}/small`, width: 480, expires_at: Date.now() + 3600000 },
    medium: { url: `${locationOrigin}/test-media/${id}/medium`, width: 960, expires_at: Date.now() + 3600000 },
    large: { url: `${locationOrigin}/test-media/${id}/large`, width: 1600, expires_at: Date.now() + 3600000 },
  } });
let locationOrigin;
const video = id => ({ id, name: `${id}.mp4`, mime: 'video/mp4', width: 1920, height: 1080,
  inline: true, video_trusted: true, duration_ms: 65000, url: `${locationOrigin}/test-media/${id}/video`,
  fallback_url: `/api/conversations/fixture/attachments/${id}`,
  poster: { url: `${locationOrigin}/test-media/${id}/poster`, width: 640, height: 360 } });

async function snapshot(page) {
  return page.locator('[data-message-id]').evaluateAll(rows => rows.map(row => {
    const r = row.getBoundingClientRect();
    return { id: row.dataset.messageId, x: r.x, y: r.y, width: r.width, height: r.height };
  }));
}

test('real message media frames retain geometry across loading, fallback, spoilers and playback', { timeout: 180000 }, async t => {
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom',
    plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom', 'lucide-react', 'blurhash'] } });
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end(await server.transformIndexHtml('/', '<!doctype html><html data-theme="void"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/tests/attachments/mediaPerformanceFixture.tsx"></script></body></html>'));
  });
  let browser;
  try {
    const picture = dimensions => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${dimensions}`,
      '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '1', '-q:v', '2', '-f', 'image2pipe', 'pipe:1']);
    const portraitPicture = picture('480x720'); const landscapePicture = picture('960x540');
    await server.listen(); locationOrigin = server.resolvedUrls.local[0].replace(/\/$/, '');
    browser = await chromium.launch();
    for (const width of [1280, 390]) {
      await t.test(`${width}px portrait/landscape and mixed frames`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const requests = []; let release;
        let held;
        let loading = true;
        await page.addInitScript(() => {
          window.mediaShifts = [];
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) if (!e.hadRecentInput) window.mediaShifts.push({
              value: e.value, time: e.startTime, sources: e.sources.map(s => ({
                node: s.node?.tagName, className: s.node?.className,
                before: s.previousRect.toJSON(), after: s.currentRect.toJSON(),
              })),
            });
          }).observe({ type: 'layout-shift', buffered: true });
        });
        await page.route('**/*', async route => {
          const req = route.request(); const url = new URL(req.url());
          if (url.pathname.startsWith('/test-media/') || url.pathname.startsWith('/api/')) {
            requests.push({ path: url.pathname, type: req.resourceType() });
            if (loading) await held;
            if (/\/video$|\/attachments\//.test(url.pathname)) return route.fulfill({ status: 404 });
            if (url.pathname.includes('/broken/')) return route.fulfill({ status: 404 });
            if (url.pathname.includes('/retry/') && !url.pathname.endsWith('/original')) return route.fulfill({ status: 404 });
            const portrait = /portrait|retry/.test(url.pathname);
            return route.fulfill({ contentType: 'image/jpeg', body: portrait ? portraitPicture : landscapePicture });
          }
          if (!req.url().startsWith(locationOrigin)) return route.abort();
          return route.continue();
        });
        try {
          await page.goto(locationOrigin); await page.waitForFunction(() => window.mediaFixture);
          const combinations = [
            [image('portrait', 3760, 5640)], [image('landscape', 5640, 3760)],
            [image('portrait', 3760, 5640), image('landscape', 5640, 3760)],
            [image('landscape', 5640, 3760), video('one')], [video('one'), video('two')],
            [image('landscape', 5640, 3760), { id: 'file', name: 'note.txt', mime: 'text/plain', url: '/test-media/file', size: 20 }],
          ];
          const results = [];
          for (const [index, attachments] of combinations.entries()) {
            held = new Promise(resolve => { release = resolve; }); loading = true;
            await page.reload(); await page.waitForFunction(() => window.mediaFixture);
            await page.evaluate(rows => window.mediaFixture.render(rows), [
              { id: `media-${index}`, attachments }, { id: 'following-text', attachments: [], content: 'Following row must not move' },
            ]);
            await page.locator(`[data-message-id="media-${index}"]`).waitFor();
            await page.waitForTimeout(150);
            const before = await snapshot(page);
            await page.waitForTimeout(600);
            const start = await page.evaluate(() => performance.now());
            loading = false; release();
            await page.waitForFunction(() => [...document.querySelectorAll('img[alt="attachment"]')].every(img => img.complete && img.naturalWidth > 0));
            await page.waitForTimeout(200);
            const after = await snapshot(page);
            const shifts = await page.evaluate(start => window.mediaShifts.filter(e => e.time >= start), start);
            results.push({ combination: index, before, after, shifts });
            if (!baseline) assert.deepEqual(after, before, `combination ${index} must reserve its final geometry`);
            if (!baseline) assert.equal(shifts.reduce((sum, e) => sum + e.value, 0), 0, 'media loads must not shift rows');
            if (attachments.some(a => a.mime === 'video/mp4') && !baseline) {
              assert.equal(await page.locator('video').count(), 0);
              await page.getByRole('button', { name: /^Play video/ }).first().click();
              await page.locator('video').first().waitFor();
              assert.deepEqual(await snapshot(page), before);
            }
          }
          for (const id of ['retry', 'broken', 'spoiler']) {
            const attachment = { ...image(id, 3760, 5640), spoiler: id === 'spoiler' };
            await page.evaluate(a => window.mediaFixture.render([{ id: 'state-test', attachments: [a] }]), attachment);
            await page.locator('[data-message-id="state-test"]').waitFor();
            const before = await snapshot(page);
            if (id === 'spoiler') await page.getByText('Spoiler', { exact: true }).click();
            await page.waitForTimeout(500);
            if (!baseline) assert.deepEqual(await snapshot(page), before);
            if (id === 'broken') {
              await page.locator('[data-message-id="state-test"] .lucide-image-off').waitFor();
              assert.equal(await page.locator('[data-message-id="state-test"] canvas').count(), 0);
            }
            if (id === 'retry') {
              await page.locator('img[alt="attachment"]').click();
              const opened = await page.evaluate(() => window.mediaFixture.opened());
              assert.ok(opened.length > 0, 'image viewer callback retained');
              assert.ok(requests.some(r => r.path === '/test-media/retry/original'));
            }
          }
          if (!baseline) {
            const rows = Array.from({ length: 12 }, (_, i) => ({ id: `history-${i}`, attachments: [image(`history-${i}`, 3760, 5640)] }));
            await page.evaluate(rows => window.mediaFixture.render(rows), rows);
            await page.locator('[data-message-id="history-0"] img').waitFor();
            await page.waitForTimeout(300);
            assert.equal(await page.locator('[data-message-id="history-11"] img').count(), 0, 'far historical image must not start loading');
            const first = page.locator('[data-message-id="history-0"] img');
            assert.equal(await first.getAttribute('loading'), 'eager');
            assert.equal(await first.getAttribute('fetchpriority'), 'high');
            assert.match(await first.getAttribute('srcset'), /small.*480w.*medium.*960w/);
            assert.equal(requests.some(r => r.path === '/test-media/history-11/small'), false);
            const node = await first.elementHandle();
            await page.locator('[data-message-id="history-11"]').scrollIntoViewIfNeeded();
            await page.locator('[data-message-id="history-11"] img').waitFor();
            await page.waitForFunction(() => document.querySelector('[data-message-id="history-11"] img')?.naturalWidth > 0);
            assert.equal(await node.evaluate(el => el.isConnected && el.naturalWidth > 0), true, 'visited images must not return to placeholders');
            await page.waitForFunction(() => document.querySelector('[data-message-id="history-0"] img')?.getAttribute('fetchpriority') === 'low');
            const viewer = await page.evaluate(async a => {
              const { getAttachmentViewerSources } = await import('/src/Services/Chat/attachmentService.ts');
              return getAttachmentViewerSources(a);
            }, rows[0].attachments[0]);
            assert.match(viewer[0].srcSet, /medium.*large/);
            assert.ok(viewer.some(source => source.url.endsWith('/original')));
            await page.evaluate(() => window.mediaFixture.density('compact'));
            await page.waitForTimeout(200);
            assert.ok((await page.locator('[data-message-id="history-11"] button[data-message-gesture-target]').boundingBox()).width <= width);
          }
          assert.equal(requests.some(r => r.type === 'fetch' || r.type === 'xhr'), false);
          const shifts = await page.evaluate(() => window.mediaShifts);
          console.log(JSON.stringify({ width, baseline, results, shifts }));
        } finally { release?.(); await page.close(); }
      });
    }
  } finally { await browser?.close(); await server.close(); }
});
