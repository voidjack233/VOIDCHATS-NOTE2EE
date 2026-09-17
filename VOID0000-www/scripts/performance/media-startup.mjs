// Read-only production measurement. Login via npm run perf:chat:auth first.
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { installChatPerformanceCollector } from './chat-cls-lcp-browser.mjs';
import { calculateCls, parsePositiveInteger, summarizeValues, normalizeConversationRoute } from './chat-cls-lcp-core.mjs';

const config = JSON.parse(await fs.readFile('.playwright/chat-cls-lcp.local.json', 'utf8'));
const base = process.env.CHAT_PERF_BASE_URL || config.baseUrl;
const route = normalizeConversationRoute(process.env.CHAT_PERF_CONVERSATION_ROUTE || config.conversationRoute, base);
const auth = process.env.CHAT_PERF_AUTH_STATE || '.playwright/chat-perf-auth.json';
const runs = parsePositiveInteger(process.env.CHAT_PERF_RUNS, 3, 'CHAT_PERF_RUNS', 10);
const resultPath = `performance-results/media-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const browser = await chromium.launch();
const results = [];
try {
  for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } })) {
    const context = await browser.newContext({ storageState: auth, viewport });
    await context.addInitScript(installChatPerformanceCollector);
    await context.addInitScript(() => {
      window.mediaInteractions = [];
      new PerformanceObserver(list => {
        for (const event of list.getEntries()) if (event.interactionId) window.mediaInteractions.push({ id: event.interactionId, duration: event.duration });
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    });
    try {
      for (let run = 1; run <= runs; run++) {
        const page = await context.newPage();
        const client = await context.newCDPSession(page);
        await client.send('Network.enable');
        await client.send('Network.setCacheDisabled', { cacheDisabled: true });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
        try {
          await page.locator('[data-message-timeline] [data-message-id]').first().waitFor({ timeout: 45000 });
        } catch (error) {
          console.error(JSON.stringify({ url: page.url(), rows: await page.locator('[data-message-id]').count(),
            timelines: await page.locator('[data-message-timeline]').count(), errors }));
          await fs.mkdir('performance-results', { recursive: true });
          await page.screenshot({ path: 'performance-results/media-navigation-failure.png' });
          throw error;
        }
        await page.waitForTimeout(8000);
        const initial = await page.evaluate(() => ({
          metrics: window.__voidChatPerf.export(),
          media: [...document.querySelectorAll('[data-message-timeline] img, [data-message-timeline] video')].map(el => {
            const r = el.getBoundingClientRect();
            return { tag: el.tagName, width: r.width, height: r.height, visible: r.bottom > 0 && r.top < innerHeight,
              loaded: el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el.readyState,
              loading: el.getAttribute('loading'), priority: el.getAttribute('fetchpriority') };
          }),
        }));
        // Genuine local interaction without sending a message or altering account data.
        const composer = page.locator('textarea, [contenteditable="true"]').first();
        if (await composer.count()) await composer.click();
        await page.mouse.move(viewport.width * 0.7, viewport.height * 0.5);
        await page.mouse.wheel(0, -500);
        await page.waitForTimeout(1000);
        const play = page.getByRole('button', { name: /^Play video:/ }).first();
        const playback = { attempted: false, playing: false };
        if (process.env.CHAT_PERF_PLAY === '1' && await play.count()) {
          await play.click(); playback.attempted = true;
          try {
            await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.currentTime > 0 && !v.paused), null, { timeout: 15000 });
            playback.playing = true;
            await page.locator('video').first().evaluate(v => v.pause());
          } catch { /* Record the failure without disguising it as a passing smoke test. */ }
        }
        const final = await page.evaluate(() => ({ metrics: window.__voidChatPerf.export(), interactions: window.mediaInteractions }));
        const lcp = initial.metrics.hardLcps.at(-1) || null;
        const result = { viewport: name, run, cls: calculateCls(initial.metrics.layoutShifts),
          lcpMs: lcp?.startTime ?? null, lcpElement: lcp?.element, interactionMaxMs: final.interactions.length ? Math.max(...final.interactions.map(e => e.duration)) : null,
          media: initial.media, errors, playback, initial: initial.metrics, final: final.metrics };
        results.push(result);
        console.log(JSON.stringify({ viewport: name, run, cls: result.cls, lcpMs: result.lcpMs,
          lcpElement: result.lcpElement, interactionMaxMs: result.interactionMaxMs, media: result.media, errors, playback }));
        await context.storageState({ path: auth, indexedDB: true }); await fs.chmod(auth, 0o600);
        await page.close();
      }
    } finally {
      // A refresh may rotate cookies even if conversation navigation fails.
      await context.storageState({ path: auth, indexedDB: true }); await fs.chmod(auth, 0o600);
      await context.close();
    }
  }
} finally {
  await browser.close();
  const summaries = ['desktop', 'mobile'].map(viewport => {
    const samples = results.filter(r => r.viewport === viewport);
    return { viewport, cls: summarizeValues(samples.map(r => r.cls)), lcpMs: summarizeValues(samples.map(r => r.lcpMs)),
      interactionMaxMs: summarizeValues(samples.map(r => r.interactionMaxMs)) };
  });
  await fs.mkdir('performance-results', { recursive: true });
  await fs.writeFile(resultPath, JSON.stringify({ base, route, cacheDisabled: true, results, summaries }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ resultPath, summaries }));
}
